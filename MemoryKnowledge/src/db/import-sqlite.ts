/** Offline, all-or-nothing import from the legacy SQLite + file tree. */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createDb, acquireKnowledgeLease } from "./client.js";
import { PostgresArtifactStore } from "./artifact-store.js";
import { wikiKey } from "../engines/wiki/index-db.js";

const TABLES = [
  "knowledge_code_graph",
  "knowledge_wiki",
  "knowledge_wiki_audit",
  "knowledge_code_graph_audit",
  "knowledge_source_credential",
  "llm_binding",
] as const;
export interface ImportOptions {
  sqlitePath: string;
  dataDir: string;
  sshKeyDir?: string;
}
export async function importLegacyKnowledge(
  pool: pg.Pool,
  opts: ImportOptions,
): Promise<Record<string, number>> {
  const sqlite = new DatabaseSync(resolve(opts.sqlitePath), { readOnly: true });
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(734819230)");
    // A fresh destination prevents silently merging unrelated tenant IDs or snapshots.
    for (const table of [
      ...TABLES,
      "knowledge_wiki_source",
      "knowledge_wiki_page",
      "knowledge_wiki_edge",
      "knowledge_artifact_scope",
    ]) {
      const result = await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
      if (result.rows.length)
        throw new Error(
          `Import requires an empty PostgreSQL destination (${table} contains data)`,
        );
    }
    for (const table of TABLES) {
      const exists = sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!exists) {
        counts[table] = 0;
        continue;
      }
      const columns = (
        await client.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows.map((r) => r.column_name);
      const sourceColumns = (
        sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      if (
        table === "knowledge_source_credential" &&
        !sourceColumns.includes("resource_id")
      )
        throw new Error(
          "Legacy user-scoped credentials require explicit resource mapping before import",
        );
      const shared = columns.filter((c) => sourceColumns.includes(c));
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows)
        await client.query(
          `INSERT INTO ${table} (${shared.map((c) => `"${c}"`).join(",")}) VALUES (${shared.map((_, i) => `$${i + 1}`).join(",")})`,
          shared.map((c) => row[c]),
        );
      counts[table] = rows.length;
    }
    for (const table of [
      "knowledge_wiki_audit",
      "knowledge_code_graph_audit",
    ]) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT max(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`,
      );
    }
    const artifacts = new PostgresArtifactStore(pool, opts.dataDir);
    let files = 0,
      sources = 0;
    for (const [table, idColumn] of [
      ["knowledge_wiki", "wiki_id"],
      ["knowledge_code_graph", "code_graph_id"],
    ] as const) {
      const rows = (
        await client.query(
          `SELECT service_id,team_id,${idColumn} AS id FROM ${table}`,
        )
      ).rows;
      for (const row of rows) {
        const dir = join(opts.dataDir, row.service_id, row.team_id, row.id);
        // Never report a successful migration that lost a registered resource's files.
        if (!existsSync(dir))
          throw new Error(`Missing source directory for resource ${row.id}`);
        const indexPath = join(dir, "index.db");
        if (table === "knowledge_wiki" && existsSync(indexPath)) {
          const index = new DatabaseSync(indexPath, { readOnly: true });
          try {
            if (
              index
                .prepare("SELECT 1 FROM sqlite_master WHERE name='source'")
                .get()
            ) {
              for (const source of index
                .prepare("SELECT * FROM source")
                .all()) {
                await client.query(
                  `INSERT INTO knowledge_wiki_source(wiki_key,filename,sha256,size,status,created_at,updated_at,last_modified_by,ingested_at,ingest_error)
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                  [
                    wikiKey(dir),
                    source.filename,
                    source.sha256,
                    source.size,
                    source.status,
                    source.created_at,
                    source.updated_at,
                    source.last_modified_by,
                    source.ingested_at,
                    source.ingest_error,
                  ],
                );
                sources++;
              }
            }
          } finally {
            index.close();
          }
        }
        await artifacts.checkpoint(dir, client);
        files++;
      }
    }
    const sshDir = opts.sshKeyDir ?? join(opts.dataDir, "ssh-keys");
    if (existsSync(sshDir)) {
      const keys = new PostgresArtifactStore(pool, sshDir, "ssh");
      for (const entry of readdirSync(sshDir, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink())
          await keys.checkpoint(join(sshDir, entry.name), client);
    }
    counts.resource_snapshots = files;
    counts.wiki_sources = sources;
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    sqlite.close();
  }
}
async function main(): Promise<void> {
  const [sqlitePath, dataDir, sshKeyDir] = process.argv.slice(2);
  if (!sqlitePath || !dataDir)
    throw new Error(
      "Usage: npm run db:import-sqlite -- /backup/knowledge.db /backup/data [ssh-key-dir]",
    );
  const { raw } = await createDb({
    connectionString:
      process.env.KNOWLEDGE_POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
  });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireKnowledgeLease(raw);
    console.log(
      JSON.stringify(
        await importLegacyKnowledge(raw, { sqlitePath, dataDir, sshKeyDir }),
        null,
        2,
      ),
    );
  } finally {
    if (release) await release();
    await raw.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message.replace(
            /Failed query:[\s\S]*/,
            "Database import failed; transaction rolled back",
          )
        : "Import failed",
    );
    process.exitCode = 1;
  });
}
