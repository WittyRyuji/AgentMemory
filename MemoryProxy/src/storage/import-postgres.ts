import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { RATE_LIMIT_GLOBAL_KEY, rateLimitOverrideKey } from '../rate-limit/postgres-store.js';
import { bucketOf } from './proxy-storage.js';
import { sessionDirOf, sessionBindingDirOf, assertKeySegment } from './key-utils.js';
import { PROXY_POSTGRES_SCHEMA_SQL, type ProxySql } from './postgres-storage.js';

export interface ProxySnapshotRow { key: string; value: string; updatedAt: number }

/** Only durable state roots (ttl/nottl), never log/config/credential files. */
export function readProxySnapshot(fsRoot?: string, sqlitePath?: string): ProxySnapshotRow[] {
  const rows = new Map<string, ProxySnapshotRow>();
  const add = (row: ProxySnapshotRow) => {
    if (!Number.isFinite(row.updatedAt) || !/^(ttl|nottl)\//.test(row.key) || row.key.includes('\\') || row.key.includes('\0') || row.key.split('/').includes('..')) throw new Error('invalid source KV row');
    const existing = rows.get(row.key);
    if (existing && existing.value !== row.value) throw new Error('conflicting source records; reconcile source snapshots before importing');
    if (!existing || row.updatedAt > existing.updatedAt) rows.set(row.key, row);
  };
  if (fsRoot) {
    // Fail on a misspelled root rather than reporting a successful empty import.
    if (!statSync(fsRoot).isDirectory()) throw new Error('filesystem root must be a directory');
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const key = prefix + entry.name;
        const file = join(dir, entry.name);
        if (entry.isDirectory()) walk(file, `${key}/`);
        else if (entry.isFile()) {
          if (entry.name.endsWith('.tmp')) throw new Error('temporary state file found; stop writers and reconcile source first');
          add({ key, value: readFileSync(file, 'utf8'), updatedAt: Math.trunc(statSync(file).mtimeMs) });
        } else throw new Error('source symlinks and special files are not supported');
      }
    };
    for (const entry of readdirSync(fsRoot, { withFileTypes: true })) {
      if (entry.name !== 'ttl' && entry.name !== 'nottl') continue;
      if (!entry.isDirectory()) throw new Error('invalid state bucket directory');
      walk(join(fsRoot, entry.name), `${entry.name}/`);
    }
  }
  if (sqlitePath) {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const parts = (sid: string) => {
      const [spaceId, userId, agentSource, ...rest] = sid.split(':');
      if (!spaceId || !userId || !agentSource || !rest.length) throw new Error('ambiguous legacy session id; migrate it to the four-part layout first');
      return { spaceId, userId, agentSource, sessionId: rest.join(':') };
    };
    try {
      db.exec('BEGIN');
      if (has('proxy_kv')) {
        for (const row of db.prepare('SELECT k,v,updated_at FROM proxy_kv').all() as Array<{ k: string; v: Buffer | string; updated_at: number }>) {
          add({ key: row.k, value: Buffer.isBuffer(row.v) ? row.v.toString('utf8') : row.v, updatedAt: row.updated_at });
        }
      }
      if (has('sessions')) {
        for (const row of db.prepare('SELECT session_id,state_json,created_at,updated_at FROM sessions').all() as Array<{ session_id: string; state_json: string; created_at: number; updated_at: number }>) {
          const id = parts(row.session_id);
          const state = JSON.parse(row.state_json);
          add({ key: `${sessionDirOf('ttl', id.spaceId, id.userId, id.agentSource, id.sessionId)}inj-sess.json`, value: row.state_json, updatedAt: row.updated_at });
          // The pre-KV SQLite backend stored terminal identity inside sessions.
          // Preserve it as a non-expiring binding when no explicit binding exists.
          const bindingKey = `${sessionBindingDirOf('nottl', id.spaceId, id.sessionId)}binding.json`;
          if (state.status === 'initialized' && !rows.has(bindingKey)) {
            add({ key: bindingKey, updatedAt: row.updated_at, value: JSON.stringify({
              outcome: state.bypassed ? 'bypassed' : 'initialized',
              userId: state.sessionInfo?.user_id || state.userId || id.userId,
              teamId: state.sessionInfo?.team_id, agentId: state.sessionInfo?.agent_id,
              taskId: state.sessionInfo?.task_id, userKey: state.sessionInfo?.user_key,
              agentSource: id.agentSource, created_at: row.created_at, last_seen: row.updated_at,
            }) });
          }
        }
      }
      if (has('hook_cache')) {
        for (const row of db.prepare('SELECT session_id,hook_id,blocks_json,created_at FROM hook_cache').all() as Array<{ session_id: string; hook_id: string; blocks_json: string; created_at: number }>) {
          const id = parts(row.session_id);
          assertKeySegment('hookId', row.hook_id);
          JSON.parse(row.blocks_json);
          add({ key: `${sessionDirOf('ttl', id.spaceId, id.userId, id.agentSource, id.sessionId)}inj-hook/${row.hook_id}.json`, value: row.blocks_json, updatedAt: row.created_at });
        }
      }
      db.exec('ROLLBACK');
    } finally { db.close(); }
  }
  return [...rows.values()];
}

/** Use a dedicated PG client, with all writers stopped during migration. */
export async function importProxySnapshot(sql: ProxySql, rows: ProxySnapshotRow[]): Promise<void> {
  await sql.query('BEGIN');
  try {
    await sql.query(PROXY_POSTGRES_SCHEMA_SQL);
    await sql.query('LOCK TABLE proxy_kv IN ACCESS EXCLUSIVE MODE');
    if (Number((await sql.query('SELECT count(*) AS count FROM proxy_kv')).rows[0]?.count) !== 0) throw new Error('Proxy target must be empty; refusing to overwrite');
    for (const row of rows) {
      await sql.query('INSERT INTO proxy_kv (k,v,bucket,updated_at) VALUES ($1,$2,$3,$4)', [row.key, row.value, bucketOf(row.key), row.updatedAt]);
    }
    if (Number((await sql.query('SELECT count(*) AS count FROM proxy_kv')).rows[0]?.count) !== rows.length) throw new Error('Proxy import verification failed');
    await sql.query('COMMIT');
  } catch (err) {
    await sql.query('ROLLBACK');
    throw err;
  }
}


/** Accept the existing GET /v3/admin/rate-limits response, exported before cutover. */
export function readRateLimitSnapshot(file: string): ProxySnapshotRow[] {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const data = raw.code === 0 ? raw.data : raw;
  const valid = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!data || !valid(data.tpm) || !valid(data.qpm) || !Array.isArray(data.overrides)) throw new Error('invalid rate-limit export');
  const now = Date.now();
  const rows: ProxySnapshotRow[] = [{ key: RATE_LIMIT_GLOBAL_KEY, value: JSON.stringify({ tpm: data.tpm, qpm: data.qpm }), updatedAt: now }];
  for (const row of data.overrides) {
    if (!row || typeof row.instanceId !== 'string' || typeof row.modelId !== 'string' || !valid(row.tpm) || !valid(row.qpm)) throw new Error('invalid rate-limit override export');
    rows.push({ key: rateLimitOverrideKey(row.instanceId, row.modelId), value: JSON.stringify({ instanceId: row.instanceId, modelId: row.modelId, tpm: row.tpm, qpm: row.qpm }), updatedAt: now });
  }
  if (new Set(rows.map(r => r.key)).size !== rows.length) throw new Error('duplicate rate-limit override');
  return rows;
}
