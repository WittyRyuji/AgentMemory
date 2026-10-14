import { PROXY_TURN_SEQ_SCHEMA_SQL } from './postgres-turn-seq.js';
import { PROXY_RATE_LIMIT_SCHEMA_SQL } from '../rate-limit/postgres-store.js';
import { Pool } from 'pg';
import { bucketOf, type ProxyStorage } from './proxy-storage.js';

export interface ProxySql {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export const PROXY_POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proxy_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('ttl', 'nottl')),
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS proxy_kv_bucket_updated ON proxy_kv(bucket, updated_at);`;

function assertKey(key: string, allowEmpty = false): void {
  if ((!key && !allowEmpty) || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.split('/').includes('..')) {
    throw new Error('invalid PostgreSQL storage key');
  }
}

/** Shared authoritative KV. Queries/CAS are atomic and errors propagate. */
export class PostgresStorage implements ProxyStorage {
  readonly type = 'postgres' as const;
  constructor(readonly sql: ProxySql, private readonly end?: () => Promise<void>) {}

  async initialize(): Promise<void> { await this.sql.query(PROXY_POSTGRES_SCHEMA_SQL); await this.sql.query(PROXY_RATE_LIMIT_SCHEMA_SQL); await this.sql.query(PROXY_TURN_SEQ_SCHEMA_SQL); }
  async close(): Promise<void> { await this.end?.(); }

  async putText(key: string, value: string): Promise<void> {
    assertKey(key);
    await this.sql.query(
      `INSERT INTO proxy_kv (k,v,bucket,updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v,bucket=EXCLUDED.bucket,updated_at=EXCLUDED.updated_at`,
      [key, value, bucketOf(key), Date.now()],
    );
  }
  async putJSON(key: string, value: unknown): Promise<void> { await this.putText(key, JSON.stringify(value)); }
  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    assertKey(key);
    const result = await this.sql.query(
      'INSERT INTO proxy_kv (k,v,bucket,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (k) DO NOTHING RETURNING k',
      [key, value, bucketOf(key), Date.now()],
    );
    return result.rows.length === 1;
  }
  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> { return this.putTextIfAbsent(key, JSON.stringify(value)); }
  async getText(key: string): Promise<string | null> {
    assertKey(key);
    const result = await this.sql.query('SELECT v FROM proxy_kv WHERE k=$1', [key]);
    return (result.rows[0]?.v as string | undefined) ?? null;
  }
  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.getText(key);
    return raw === null ? null : JSON.parse(raw) as T;
  }
  async exists(key: string): Promise<boolean> {
    assertKey(key);
    return (await this.sql.query('SELECT k FROM proxy_kv WHERE k=$1', [key])).rows.length > 0;
  }
  async del(key: string): Promise<void> {
    assertKey(key);
    await this.sql.query('DELETE FROM proxy_kv WHERE k=$1', [key]);
  }
  async delPrefix(prefix: string): Promise<number> {
    assertKey(prefix, true);
    const result = await this.sql.query('DELETE FROM proxy_kv WHERE left(k,char_length($1))=$1 RETURNING k', [prefix]);
    return result.rows.length;
  }
  async listNames(prefix: string): Promise<string[]> {
    assertKey(prefix, true);
    const result = await this.sql.query('SELECT k FROM proxy_kv WHERE left(k,char_length($1))=$1 ORDER BY k', [prefix]);
    return result.rows.map(row => (row.k as string).slice(prefix.length));
  }
  async sweep(opts: { ttlMs: number; now?: number }): Promise<{ removedTtl: number }> {
    const result = await this.sql.query("DELETE FROM proxy_kv WHERE bucket='ttl' AND updated_at<$1 RETURNING k", [(opts.now ?? Date.now()) - opts.ttlMs]);
    await this.sql.query('DELETE FROM proxy_rate_limit_windows WHERE updated_at<$1', [Math.floor((opts.now ?? Date.now()) / 1000) - 120]);
    await this.sql.query('DELETE FROM proxy_turn_sequences WHERE expires_at<$1', [Math.floor((opts.now ?? Date.now()) / 1000)]);
    return { removedTtl: result.rows.length };
  }

  /** Binding updates must preserve creation time without a cross-node R-M-W race. */
  async putBindingRecord(key: string, value: unknown): Promise<void> {
    assertKey(key);
    await this.sql.query(
      `INSERT INTO proxy_kv (k,v,bucket,updated_at) VALUES ($1,$2,'nottl',$3)
       ON CONFLICT (k) DO UPDATE SET
         v=(EXCLUDED.v::jsonb || jsonb_build_object('created_at', COALESCE(proxy_kv.v::jsonb->'created_at',EXCLUDED.v::jsonb->'created_at')))::text,
         updated_at=EXCLUDED.updated_at`,
      [key, JSON.stringify(value), Date.now()],
    );
  }
  async touchBindingRecord(key: string): Promise<void> {
    assertKey(key);
    await this.sql.query(
      "UPDATE proxy_kv SET v=jsonb_set(v::jsonb,'{last_seen}',to_jsonb($2::bigint))::text,updated_at=$2 WHERE k=$1", [key, Date.now()],
    );
  }
}

export function openPostgresStorage(connectionString: string): PostgresStorage {
  if (!connectionString.trim()) throw new Error('PROXY_POSTGRES_URL or DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => console.error('[storage] PostgreSQL idle connection failed'));
  return new PostgresStorage(pool as ProxySql, () => pool.end());
}
