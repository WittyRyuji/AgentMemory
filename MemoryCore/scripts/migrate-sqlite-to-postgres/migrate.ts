/** Offline, atomic import into an EMPTY PostgreSQL instance. No inference calls. */
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import * as sqliteVec from "sqlite-vec";
import {
  PostgresDatabase,
  instanceSchema,
} from "../../src/core/store/postgres/client.js";
import {
  PostgresMemoryStore,
  vectorLiteral,
} from "../../src/core/store/postgres/memory-store.js";
import { PostgresMetadataStore } from "../../src/metadata/store/postgres-adapter.js";
import { PostgresSkillStore } from "../../src/core/store/postgres/skill-store.js";
import { PostgresStorageBackend } from "../../src/core/storage/postgres-backend.js";
import { PostgresDocuments } from "../../src/core/store/postgres/documents.js";
import { tokenizeForFts } from "../../src/core/store/tokenize.js";
import {
  buildProfileStableId,
  buildProfileIsolationScope,
  parseProfileIsolationScope,
  type ProfileIsolation,
} from "../../src/core/profile/profile-scope.js";
import { classifyPath } from "../../src/core/storage/profile-row-backend.js";

type Row = Record<string, any>;
export interface ImportOptions {
  memorySqlite?: string;
  metadataSqlite?: string;
  filesRoot?: string;
  instanceId: string;
  dimensions: number;
  provider: string;
  model: string;
  apply?: boolean;
  withoutVectors?: boolean;
  /** Explicit ownership required for old unscoped persona/scene files. */
  profileIsolation?: ProfileIsolation;
}
export interface ImportReport {
  applied: boolean;
  counts: Record<string, number>;
  skipped: string[];
  vectorsCopied: number;
  vectorsMissing: number;
}
const docsMapping: Record<string, [string, string]> = {
  entity_teams: ["teams", "team_id"],
  entity_users: ["users", "user_id"],
  entity_agents: ["agents", "agent_id"],
  entity_tasks: ["tasks", "task_id"],
  entity_knowledge: ["knowledge", "knowledge_id"],
  memory_audit: ["audit", "audit_id"],
  memory_prompts: ["prompts", "memory_prompt_id"],
  memory_prompt_settings: ["prompt_settings", "setting_id"],
  memory_prompt_setting_logs: ["prompt_logs", "setting_log_id"],
  memory_generation_refs: ["generation_refs", "generation_ref_id"],
  skills: ["skills", "row_id"],
};
const ident = (name: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(name))
    throw new Error("Unsupported SQL identifier");
  return `"${name}"`;
};
function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Row[]
  ).map((r) => r.name);
}
function openSource(path: string) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: true });
  db.exec("PRAGMA query_only=ON; BEGIN");
  return db;
}
function transformDoc(row: Row): Row {
  const result = { ...row };
  for (const [key, value] of Object.entries(row))
    if (key.endsWith("_ids_json")) {
      result[key.slice(0, -5)] = JSON.parse(String(value ?? "[]"));
      delete result[key];
    }
  if ("manifest_json" in result) {
    result.manifest = JSON.parse(result.manifest_json);
    delete result.manifest_json;
    result.is_head = !!result.is_head;
  }
  return result;
}
async function* files(
  root: string,
  dir = root,
): AsyncGenerator<{ path: string; key: string }> {
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name),
      stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`Symlinks are not imported: ${relative(root, path)}`);
    if (stat.isDirectory()) yield* files(root, path);
    else if (stat.isFile())
      yield { path, key: relative(root, path).split("\\").join("/") };
  }
}
function profileFor(key: string, opts: ImportOptions) {
  let path = key,
    isolation = opts.profileIsolation;
  if (key.startsWith("profiles/")) {
    const end = key.indexOf("/", 9);
    if (end < 0) return null;
    const scope = key.slice(9, end);
    path = key.slice(end + 1);
    if (!classifyPath(path)) return null;
    isolation = parseProfileIsolationScope(scope);
    if (!isolation)
      throw new Error(`Unrecognized legacy profile scope: ${scope}`);
  }
  const profile = classifyPath(path);
  if (!profile) return null;
  if (!isolation?.agentId || !(isolation.teamId || isolation.userId))
    throw new Error(
      "Unscoped profile files require --profile-team and --profile-agent",
    );
  return { ...profile, isolation };
}
/** Dry-run does not open/connect to the target database, even when one is passed. */
export async function migrateSqliteToPostgres(
  opts: ImportOptions,
  target?: PostgresDatabase,
): Promise<ImportReport> {
  if (!opts.memorySqlite && !opts.metadataSqlite && !opts.filesRoot)
    throw new Error("At least one source is required");
  if (
    !Number.isInteger(opts.dimensions) ||
    opts.dimensions < 1 ||
    !opts.instanceId ||
    !opts.model ||
    !opts.provider
  )
    throw new Error("instanceId, provider, model and dimensions are required");
  const report: ImportReport = {
    applied: false,
    counts: {},
    skipped: [],
    vectorsCopied: 0,
    vectorsMissing: 0,
  };
  const memory = opts.memorySqlite ? openSource(opts.memorySqlite) : undefined;
  const metadata = opts.metadataSqlite
    ? openSource(opts.metadataSqlite)
    : undefined;
  try {
    const mt = memory ? tables(memory) : [],
      met = metadata
        ? tables(metadata).filter((t) => t.startsWith("meta_"))
        : [];
    const supported = new Set([
      "l0_conversations",
      "l1_records",
      ...Object.keys(docsMapping),
    ]);
    for (const table of mt) {
      if (supported.has(table))
        report.counts[table] = Number(
          (
            memory!
              .prepare(`SELECT count(*) AS n FROM ${ident(table)}`)
              .get() as Row
          ).n,
        );
      else if (
        !/^(sqlite_|embedding_meta$|l[01]_(vec|fts)|skill_(vec|fts))/.test(
          table,
        )
      )
        report.skipped.push(`table:${table}`);
    }
    for (const table of met)
      report.counts[table] = Number(
        (
          metadata!
            .prepare(`SELECT count(*) AS n FROM ${ident(table)}`)
            .get() as Row
        ).n,
      );
    if (memory && !opts.withoutVectors && mt.includes("embedding_meta")) {
      const saved = memory
        .prepare(
          "SELECT value FROM embedding_meta WHERE key='embedding_provider_info'",
        )
        .get() as Row | undefined;
      if (saved) {
        const source = JSON.parse(saved.value);
        if (
          source.provider !== opts.provider ||
          source.model !== opts.model ||
          source.dimensions !== opts.dimensions
        )
          throw new Error(
            "Source embedding model/dimensions differ; use the same provider or explicitly --without-vectors",
          );
      }
    }
    if (
      memory &&
      !opts.withoutVectors &&
      mt.some((t) => /^(l[01]|skill)_vec$/.test(t))
    )
      sqliteVec.load(memory);
    const objectFiles: Array<{ path: string; key: string }> = [];
    if (opts.filesRoot)
      for await (const file of files(opts.filesRoot)) {
        if (
          file.key.endsWith(".meta.json") ||
          /\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(file.key) ||
          file.key === ".metadata/manifest.json" ||
          file.key === ".metadata/instance_id"
        ) {
          report.skipped.push(`file:${file.key}`);
          continue;
        }
        // Import the selected storage root, not server configuration or credentials.
        if (
          !/^(persona\.md$|scene_blocks\/|profiles\/|conversations\/|records\/|skills\/|sessions\/|\.metadata\/|\.backup\/|generation_logs\/)/.test(
            file.key,
          )
        ) {
          report.skipped.push(`file:${file.key}`);
          continue;
        }
        profileFor(file.key, opts);
        objectFiles.push(file);
      }
    report.counts.files = objectFiles.length;
    if (!opts.apply) return report;
    if (!target) throw new Error("Apply requires a PostgreSQL target");
    if (target.schema !== instanceSchema(opts.instanceId))
      throw new Error("Target schema does not match the requested instance");
    if (report.skipped.some((x) => x.startsWith("table:")))
      throw new Error(
        "Unsupported source business tables; inspect dry-run report before migrating",
      );
    const store = new PostgresMemoryStore({
      db: target,
      dimensions: opts.dimensions,
    });
    await store.init({ provider: opts.provider, model: opts.model });
    const metaDb = new PostgresDatabase(
      target.pool,
      instanceSchema(opts.instanceId, "metadata"),
    );
    await new PostgresMetadataStore(metaDb).init();
    const noInference = {
      embed: async (): Promise<Float32Array> => {
        throw new Error("Migration must never call inference");
      },
      embedBatch: async (): Promise<Float32Array[]> => {
        throw new Error("Migration must never call inference");
      },
      getDimensions: () => opts.dimensions,
      getProviderInfo: () => ({ provider: opts.provider, model: opts.model }),
      isReady: () => true,
      startWarmup: () => {},
    };
    await new PostgresSkillStore(target, noInference).initialize();
    const objects = new PostgresStorageBackend(target);
    await objects.exists("__migration_probe__");
    const docs = new PostgresDocuments(target);
    await target.transaction(async () => {
      await target.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [metaDb.schema],
      );
      for (const table of [
        "memory_l0",
        "memory_l1",
        "memory_objects",
        "skill_search",
      ]) {
        if (
          Number(
            (
              await target.query<{ n: string }>(
                `SELECT count(*) AS n FROM ${table}`,
              )
            ).rows[0].n,
          )
        )
          throw new Error("Target is not empty; refusing to overwrite");
      }
      if (
        Number(
          (
            await target.query<{ n: string }>(
              "SELECT count(*) AS n FROM memory_documents WHERE kind<>'config'",
            )
          ).rows[0].n,
        )
      )
        throw new Error("Target is not empty; refusing to overwrite");
      const metaTables = (
        await target.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
          [metaDb.schema],
        )
      ).rows.map((r) => r.table_name);
      for (const table of metaTables)
        if (
          Number(
            (
              await target.query<{ n: string }>(
                `SELECT count(*) AS n FROM "${metaDb.schema}".${ident(table)}`,
              )
            ).rows[0].n,
          )
        )
          throw new Error(
            "Metadata target is not empty; refusing to overwrite",
          );
      for (const table of met) {
        if (!metaTables.includes(table))
          throw new Error(`Unsupported metadata table: ${table}`);
        const columns = (
          metadata!.prepare(`PRAGMA table_info(${ident(table)})`).all() as Row[]
        ).map((c) => String(c.name));
        const names = columns.map(ident).join(",");
        for (const row of metadata!
          .prepare(`SELECT * FROM ${ident(table)}`)
          .iterate() as Iterable<Row>)
          await target.query(
            `INSERT INTO "${metaDb.schema}".${ident(table)}(${names}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
            columns.map((c) => row[c]),
          );
        if (
          ["meta_config_params", "meta_instance_upstream_config"].includes(
            table,
          )
        )
          await target.query(
            `SELECT setval(pg_get_serial_sequence($1,'id'), GREATEST(COALESCE(MAX(id),0),1), MAX(id) IS NOT NULL) FROM "${metaDb.schema}".${ident(table)}`,
            [`"${metaDb.schema}".${table}`],
          );
      }
      const vectorFor = (table: string, id: string) => {
        if (opts.withoutVectors || !memory || !mt.includes(table)) {
          report.vectorsMissing++;
          return null;
        }
        const row = memory
          .prepare(
            `SELECT embedding FROM ${ident(table)} WHERE ${table === "skill_vec" ? "skill_id" : "record_id"}=?`,
          )
          .get(id) as Row | undefined;
        if (!row?.embedding) {
          report.vectorsMissing++;
          return null;
        }
        const bytes = Buffer.from(row.embedding);
        if (bytes.length !== opts.dimensions * 4)
          throw new Error("Source vector dimensions do not match target");
        const vector = Float32Array.from({ length: opts.dimensions }, (_, i) =>
          bytes.readFloatLE(i * 4),
        );
        if (!vector.some((v) => v !== 0)) {
          report.vectorsMissing++;
          return null;
        }
        report.vectorsCopied++;
        return vectorLiteral(vector, opts.dimensions);
      };
      for (const [source, dest, field, vec] of [
        ["l0_conversations", "memory_l0", "message_text", "l0_vec"],
        ["l1_records", "memory_l1", "content", "l1_vec"],
      ])
        if (mt.includes(source)) {
          for (const row of memory!
            .prepare(`SELECT * FROM ${ident(source)}`)
            .iterate() as Iterable<Row>) {
            const tokens = tokenizeForFts(row[field]);
            const data = {
              ...row,
              _id: row.record_id,
              tokens,
              recorded_at_ms: Date.parse(row.recorded_at) || 0,
              updated_time_ms: Date.parse(row.updated_time) || 0,
            };
            await target.query(
              `INSERT INTO ${dest}(id,data,embedding,search) VALUES($1,$2::jsonb,$3::vector,to_tsvector('simple',$4))`,
              [
                row.record_id,
                JSON.stringify(data),
                vectorFor(vec, row.record_id),
                tokens,
              ],
            );
          }
        }
      for (const [table, [kind, id]] of Object.entries(docsMapping))
        if (mt.includes(table))
          for (const raw of memory!
            .prepare(`SELECT * FROM ${ident(table)}`)
            .iterate() as Iterable<Row>) {
            const row = transformDoc(raw);
            await docs.put(kind, String(row[id]), row);
            if (kind === "skills")
              await target.query(
                "INSERT INTO skill_search(row_id,embedding,search) VALUES($1,$2::vector,to_tsvector('simple',$3))",
                [
                  row.row_id,
                  row.is_head ? vectorFor("skill_vec", row.skill_id) : null,
                  tokenizeForFts(
                    `${row.name} ${row.description} ${row.content}`,
                  ),
                ],
              );
          }
      for (const file of objectFiles) {
        const bytes = await readFile(file.path),
          profile = profileFor(file.key, opts);
        if (profile) {
          const content = bytes.toString("utf8"),
            time = (await lstat(file.path)).mtimeMs;
          const scope = buildProfileIsolationScope(profile.isolation);
          await store.syncProfiles([
            {
              id: buildProfileStableId(scope, profile.type, profile.filename),
              type: profile.type,
              filename: profile.filename,
              content,
              contentMd5: createHash("md5").update(content).digest("hex"),
              ...profile.isolation,
              version: 1,
              createdAtMs: time,
              updatedAtMs: time,
            },
          ]);
        } else {
          let sidecar: Row = {};
          try {
            sidecar = JSON.parse(
              await readFile(`${file.path}.meta.json`, "utf8"),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await objects.putObject(file.key, bytes, sidecar);
        }
      }
    }, true);
    report.applied = true;
    return report;
  } finally {
    memory?.close();
    metadata?.close();
  }
}
