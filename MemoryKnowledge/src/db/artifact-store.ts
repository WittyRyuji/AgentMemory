/**
 * PostgreSQL-backed working trees for file-oriented engines.
 * Files are a materialized cache. A successful write/build is acknowledged only
 * after its complete snapshot is committed to PG. Derived codegraph indexes,
 * Git history and obsolete SQLite wiki indexes are rebuildable and excluded.
 * Run one Knowledge process per working directory; this is not a shared-cache
 * multi-writer filesystem.
 */
import type pg from "pg";
import { createHash } from "node:crypto";
import {
  readdirSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { resolve, relative, join, dirname, isAbsolute, sep } from "node:path";

export const ARTIFACT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_artifact_scope (
  namespace TEXT NOT NULL, scope TEXT NOT NULL,
  PRIMARY KEY(namespace, scope)
);
CREATE TABLE IF NOT EXISTS knowledge_artifact (
  namespace TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL,
  content BYTEA NOT NULL, sha256 TEXT NOT NULL, mode INTEGER NOT NULL,
  PRIMARY KEY(namespace, scope, path),
  FOREIGN KEY(namespace, scope) REFERENCES knowledge_artifact_scope(namespace, scope) ON DELETE CASCADE
);`;
export interface ArtifactQuery {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}
const DERIVED_WIKI_INDEX = new Set([
  "index.db",
  "index.db-wal",
  "index.db-shm",
]);
interface FileSnapshot {
  path: string;
  content: Buffer;
  sha256: string;
  mode: number;
}

function contained(root: string, child: string): string {
  const result = resolve(root, child);
  const rel = relative(root, result);
  if (
    !child ||
    isAbsolute(child) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    !rel
  ) {
    throw new Error("Invalid artifact path");
  }
  return result;
}

export class PostgresArtifactStore {
  private readonly root: string;
  constructor(
    private readonly pool: pg.Pool,
    root: string,
    private readonly namespace = "knowledge",
  ) {
    this.root = resolve(root);
  }
  scopeFor(directory: string): string {
    const scope = relative(this.root, resolve(directory)).split(sep).join("/");
    contained(this.root, scope);
    return scope;
  }
  private capture(directory: string): FileSnapshot[] {
    const files: FileSnapshot[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const resourceId = directory.split(sep).at(-1) ?? "";
        if (
          resourceId.startsWith("wiki-") &&
          dir === directory &&
          DERIVED_WIKI_INDEX.has(entry.name)
        )
          continue;
        if (
          resourceId.startsWith("cg-") &&
          (entry.name === ".git" ||
            entry.name === "node_modules" ||
            entry.name === ".codegraph" ||
            entry.name.startsWith(".codegraph-"))
        )
          continue;
        const full = join(dir, entry.name);
        // Do not follow repository symlinks, which can escape the authorized tree.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = lstatSync(full);
        if (stat.size > 128 * 1024 * 1024)
          throw new Error(`Artifact file exceeds 128 MiB: ${entry.name}`);
        const content = readFileSync(full);
        files.push({
          path: relative(directory, full).split(sep).join("/"),
          content,
          sha256: createHash("sha256").update(content).digest("hex"),
          mode: stat.mode & 0o777,
        });
      }
    };
    walk(directory);
    return files;
  }
  /** Can share a transaction with the wiki source lifecycle/index update. */
  async checkpoint(
    directory: string,
    transaction?: ArtifactQuery,
  ): Promise<void> {
    const scope = this.scopeFor(directory);
    const client = transaction ?? (await this.pool.connect());
    try {
      if (!transaction) await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${this.namespace}/${scope}`,
      ]);
      if (this.namespace === "knowledge") {
        const [serviceId, teamId, id, extra] = scope.split("/");
        if (extra || !id)
          throw new Error("Expected tenant/team/resource artifact scope");
        const table = id.startsWith("wiki-")
          ? "knowledge_wiki"
          : id.startsWith("cg-")
            ? "knowledge_code_graph"
            : null;
        const column = id.startsWith("wiki-") ? "wiki_id" : "code_graph_id";
        if (!table) throw new Error("Unknown Knowledge artifact resource type");
        const owner = await client.query(
          `SELECT 1 FROM ${table} WHERE service_id=$1 AND team_id=$2 AND ${column}=$3 FOR KEY SHARE`,
          [serviceId, teamId, id],
        );
        if (!owner.rows.length)
          throw new Error("Artifact owner no longer exists");
      }
      const files = this.capture(resolve(directory));
      await client.query(
        "INSERT INTO knowledge_artifact_scope(namespace,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.namespace, scope],
      );
      for (const file of files) {
        await client.query(
          `INSERT INTO knowledge_artifact(namespace,scope,path,content,sha256,mode)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,scope,path) DO UPDATE
          SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,mode=EXCLUDED.mode
          WHERE knowledge_artifact.sha256<>EXCLUDED.sha256 OR knowledge_artifact.mode<>EXCLUDED.mode`,
          [
            this.namespace,
            scope,
            file.path,
            file.content,
            file.sha256,
            file.mode,
          ],
        );
      }
      await client.query(
        "DELETE FROM knowledge_artifact WHERE namespace=$1 AND scope=$2 AND NOT(path=ANY($3::text[]))",
        [this.namespace, scope, files.map((f) => f.path)],
      );
      if (!transaction) await client.query("COMMIT");
    } catch (error) {
      if (!transaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!transaction) (client as pg.PoolClient).release();
    }
  }
  async remove(directory: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM knowledge_artifact_scope WHERE namespace=$1 AND scope=$2",
      [this.namespace, this.scopeFor(directory)],
    );
  }
  /** Restore only registered scopes; unrelated manually staged directories survive. */
  async restoreAll(): Promise<void> {
    const scopes = (
      await this.pool.query<{ scope: string }>(
        "SELECT scope FROM knowledge_artifact_scope WHERE namespace=$1 ORDER BY scope",
        [this.namespace],
      )
    ).rows;
    for (const { scope } of scopes) {
      const directory = contained(this.root, scope);
      const rows = (
        await this.pool.query<{ path: string; content: Buffer; mode: number }>(
          "SELECT path,content,mode FROM knowledge_artifact WHERE namespace=$1 AND scope=$2 ORDER BY path",
          [this.namespace, scope],
        )
      ).rows;
      // Validate the whole snapshot before replacing its cache.
      for (const row of rows) contained(directory, row.path);
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const row of rows) {
        const file = contained(directory, row.path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, Buffer.from(row.content), {
          mode: row.mode & 0o777,
        });
        chmodSync(file, row.mode & 0o777);
      }
    }
  }
}
