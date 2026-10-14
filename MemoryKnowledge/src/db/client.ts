/** PostgreSQL is the durable system of record for Knowledge. */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  WIKI_INDEX_SCHEMA_SQL,
  configureWikiIndexPool,
} from "../engines/wiki/index-db.js";
import { ARTIFACT_SCHEMA_SQL } from "./artifact-store.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
export interface CreateDbOptions {
  connectionString: string;
  autoMigrate?: boolean;
  /** Test seam; production uses a bounded node-postgres connection pool. */
  pool?: pg.Pool;
}
export const KNOWLEDGE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS knowledge_code_graph (
      code_graph_id   TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      repo_name       TEXT NOT NULL DEFAULT '',
      repo_url        TEXT NOT NULL,
      branch          TEXT NOT NULL,
      commit_hash     TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'pending',
      internal_status TEXT,
      sync_error      TEXT,
      stats_json      TEXT,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kcg_team_repo_branch
      ON knowledge_code_graph(service_id, team_id, repo_url, branch)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kcg_team_status
      ON knowledge_code_graph(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki (
      wiki_id         TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      name            TEXT NOT NULL,
      source_type     TEXT,
      source_url      TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'draft',
      internal_status TEXT,
      sync_error      TEXT,
      page_count      INTEGER,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwiki_team_name
      ON knowledge_wiki(service_id, team_id, name)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kwiki_team_status
      ON knowledge_wiki(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki_audit (
      id         SERIAL PRIMARY KEY,
      wiki_id    TEXT NOT NULL,
      service_id TEXT,
      version    INTEGER NOT NULL DEFAULT 0,
      action     TEXT NOT NULL,
      user_id    TEXT,
      agent_id   TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kwa_wiki_version
      ON knowledge_wiki_audit(wiki_id, version DESC);

    CREATE TABLE IF NOT EXISTS knowledge_code_graph_audit (
      id            SERIAL PRIMARY KEY,
      code_graph_id TEXT NOT NULL,
      service_id    TEXT,
      version       INTEGER NOT NULL DEFAULT 0,
      action        TEXT NOT NULL,
      user_id       TEXT,
      agent_id      TEXT,
      detail        TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kcga_cg_version
      ON knowledge_code_graph_audit(code_graph_id, version DESC);

    CREATE TABLE IF NOT EXISTS knowledge_source_credential (
      service_id       TEXT NOT NULL,
      resource_type    TEXT NOT NULL,        -- 'code-graph' | 'wiki'
      resource_id      TEXT NOT NULL,        -- = code_graph_id 或 wiki_id
      provider_id      TEXT NOT NULL,        -- 'gongfeng' / 'iwiki' / ...（非键）
      cred_kind        TEXT NOT NULL,        -- 'bearer' | 'basic'
      cred_secret      TEXT NOT NULL,        -- base64(UTF-8 令牌)
      cred_username    TEXT,                 -- 仅 basic
      cred_extra_json  TEXT,
      last_verified_at TEXT,
      created_by       TEXT,
      updated_by       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ksc_pk
      ON knowledge_source_credential(service_id, resource_type, resource_id);

    CREATE TABLE IF NOT EXISTS llm_binding (
      service_id     TEXT PRIMARY KEY,
      mode           TEXT NOT NULL DEFAULT 'proxy',
      proxy_base_url TEXT,
      api_key        TEXT,
      model          TEXT,
      base_url       TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL
    );

ALTER TABLE knowledge_code_graph ADD COLUMN IF NOT EXISTS service_url TEXT;
ALTER TABLE knowledge_code_graph ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE knowledge_wiki ADD COLUMN IF NOT EXISTS service_url TEXT;
ALTER TABLE knowledge_wiki ADD COLUMN IF NOT EXISTS summary TEXT;
`;

export async function createDb(
  opts: CreateDbOptions,
): Promise<{ db: Db; raw: pg.Pool }> {
  if (!opts.pool && !/^postgres(?:ql)?:\/\//.test(opts.connectionString)) {
    throw new Error(
      "KNOWLEDGE_POSTGRES_URL must be a PostgreSQL connection URL",
    );
  }
  const raw =
    opts.pool ??
    new pg.Pool({
      connectionString: opts.connectionString,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
  raw.on("error", () => {
    /* Connection failures surface on the next operation; never log secrets. */
  });
  const db = drizzle(raw, { schema });
  try {
    if (opts.autoMigrate !== false) await migrate(db, raw);
    configureWikiIndexPool(raw);
    return { db, raw };
  } catch (error) {
    if (!opts.pool) await raw.end();
    throw error;
  }
}

export async function migrate(_db: Db, raw: pg.Pool): Promise<void> {
  const client = await raw.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent process startups without dropping or recreating user data.
    await client.query("SELECT pg_advisory_xact_lock(734819230)");
    await client.query(KNOWLEDGE_SCHEMA_SQL);
    await client.query(WIKI_INDEX_SCHEMA_SQL);
    await client.query(ARTIFACT_SCHEMA_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The existing in-memory build queue/cache supports one writer per database. */
export async function acquireKnowledgeLease(
  pool: pg.Pool,
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(734819231) AS acquired",
  );
  if (!result.rows[0]?.acquired) {
    client.release();
    throw new Error(
      "Another Knowledge process owns this database; concurrent writers are not supported",
    );
  }
  // Losing the lease must stop writes immediately, rather than let two caches diverge.
  client.on("error", () => {
    process.exit(1);
  });
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock(734819231)");
    } finally {
      client.release();
    }
  };
}
