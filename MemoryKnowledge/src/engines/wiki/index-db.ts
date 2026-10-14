/** Tenant-scoped PostgreSQL wiki indexes and source lifecycle. No SQLite files. */
import type pg from "pg";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

export const WIKI_INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_wiki_page (
  wiki_key TEXT NOT NULL, page_id TEXT NOT NULL,
  title TEXT, type TEXT, rel_path TEXT, snippet TEXT,
  search_vector TSVECTOR NOT NULL,
  PRIMARY KEY(wiki_key, page_id)
);
CREATE INDEX IF NOT EXISTS idx_kwp_search ON knowledge_wiki_page USING gin(search_vector);
CREATE TABLE IF NOT EXISTS knowledge_wiki_edge (
  wiki_key TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  PRIMARY KEY(wiki_key, source_id, target_id)
);
CREATE TABLE IF NOT EXISTS knowledge_wiki_source (
  wiki_key TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
  size INTEGER NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_modified_by TEXT, ingested_at TEXT, ingest_error TEXT,
  PRIMARY KEY(wiki_key, filename)
);
`;
let pool: pg.Pool | undefined;
export function configureWikiIndexPool(value: pg.Pool): void {
  pool = value;
}
function getPool(): pg.Pool {
  if (!pool) throw new Error("Wiki PostgreSQL pool has not been initialized");
  return pool;
}
/** The tenant/team/resource tuple stays stable when the working directory moves. */
export function wikiKey(wikiDir: string): string {
  return JSON.stringify([
    basename(dirname(dirname(wikiDir))),
    basename(dirname(wikiDir)),
    basename(wikiDir),
  ]);
}
export interface WikiIndexDb {
  key: string;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}
function scoped(client: pg.Pool | pg.PoolClient, wikiDir: string): WikiIndexDb {
  return {
    key: wikiKey(wikiDir),
    query: (text, values) => client.query(text, values),
  };
}
/** Schema is migrated once with the central store, rather than per wiki. */
export async function initIndexDb(_wikiDir: string): Promise<void> {
  getPool();
}
export function getReadDb(_wikiId: string, wikiDir: string): WikiIndexDb {
  return scoped(getPool(), wikiDir);
}
export async function withWriteDb<T>(
  wikiDir: string,
  fn: (db: WikiIndexDb) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      wikiKey(wikiDir),
    ]);
    const value = await fn(scoped(client, wikiDir));
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
/** No per-wiki connections remain; a single bounded PG pool serves every wiki. */
export function evictWikiDb(_wikiId: string): void {}
export function readPoolSize(): number {
  return pool?.totalCount ?? 0;
}
export async function deleteWikiIndex(wikiDir: string): Promise<void> {
  await withWriteDb(wikiDir, async (db) => {
    for (const table of [
      "knowledge_wiki_page",
      "knowledge_wiki_edge",
      "knowledge_wiki_source",
    ]) {
      await db.query(`DELETE FROM ${table} WHERE wiki_key = $1`, [db.key]);
    }
  });
}

export type SourceStatus = "uploaded" | "ingested" | "failed";

/** source 表一行（rawLs 返回、增量判断用）。 */
export interface SourceRow {
  filename: string;
  sha256: string;
  size: number;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  last_modified_by: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
}

/** 计算内容 SHA-256（增量判断与 source 登记共用同一份 sha）。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function upsertSource(
  db: WikiIndexDb,
  entry: {
    filename: string;
    sha256: string;
    size: number;
    userId?: string | null;
  },
): Promise<"created" | "updated" | "unchanged"> {
  const now = new Date().toISOString();
  const old = (
    await db.query<{ sha256: string }>(
      "SELECT sha256 FROM knowledge_wiki_source WHERE wiki_key=$1 AND filename=$2",
      [db.key, entry.filename],
    )
  ).rows[0];
  if (!old) {
    await db.query(
      `INSERT INTO knowledge_wiki_source
      (wiki_key, filename, sha256, size, status, created_at, updated_at, last_modified_by)
      VALUES ($1,$2,$3,$4,'uploaded',$5,$5,$6)`,
      [
        db.key,
        entry.filename,
        entry.sha256,
        entry.size,
        now,
        entry.userId ?? null,
      ],
    );
    return "created";
  }
  if (old.sha256 !== entry.sha256) {
    await db.query(
      `UPDATE knowledge_wiki_source SET sha256=$3, size=$4, status='uploaded',
      updated_at=$5,last_modified_by=$6,ingest_error=NULL WHERE wiki_key=$1 AND filename=$2`,
      [
        db.key,
        entry.filename,
        entry.sha256,
        entry.size,
        now,
        entry.userId ?? null,
      ],
    );
    return "updated";
  }
  return "unchanged";
}
export async function listSources(db: WikiIndexDb): Promise<SourceRow[]> {
  return (
    await db.query<SourceRow>(
      `SELECT filename,sha256,size,status,created_at,updated_at,
    last_modified_by,ingested_at,ingest_error FROM knowledge_wiki_source WHERE wiki_key=$1 ORDER BY filename`,
      [db.key],
    )
  ).rows;
}
export async function readSourceStates(
  db: WikiIndexDb,
): Promise<Map<string, { sha256: string; status: SourceStatus }>> {
  const rows = await listSources(db);
  return new Map(
    rows.map((r) => [r.filename, { sha256: r.sha256, status: r.status }]),
  );
}
export async function deleteSources(
  db: WikiIndexDb,
  filenames: string[],
): Promise<void> {
  if (filenames.length)
    await db.query(
      "DELETE FROM knowledge_wiki_source WHERE wiki_key=$1 AND filename=ANY($2::text[])",
      [db.key, filenames],
    );
}
export async function recordSourceIngestResult(
  db: WikiIndexDb,
  entry: {
    filename: string;
    sha256: string;
    size: number;
    ok: boolean;
    error?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO knowledge_wiki_source
    (wiki_key,filename,sha256,size,status,created_at,updated_at,ingested_at,ingest_error)
    VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8)
    ON CONFLICT(wiki_key,filename) DO UPDATE SET
      status=EXCLUDED.status,ingested_at=EXCLUDED.ingested_at,ingest_error=EXCLUDED.ingest_error
    WHERE knowledge_wiki_source.sha256=EXCLUDED.sha256`,
    [
      db.key,
      entry.filename,
      entry.sha256,
      entry.size,
      entry.ok ? "ingested" : "failed",
      now,
      entry.ok ? now : null,
      entry.ok ? null : (entry.error ?? "unknown").slice(0, 500),
    ],
  );
}

export function classifySources(
  disk: Array<{ filename: string; sha256: string }>,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
): { toIngest: string[]; skipped: string[]; deleted: string[] } {
  const diskNames = new Set(disk.map((d) => d.filename));
  const deleted = [...oldStates.keys()].filter((fn) => !diskNames.has(fn));
  const toIngest: string[] = [];
  const skipped: string[] = [];
  for (const d of disk) {
    const prev = oldStates.get(d.filename);
    if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256)
      toIngest.push(d.filename);
    else skipped.push(d.filename);
  }
  return { toIngest, skipped, deleted };
}
