import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestPool } from "./__tests__/test-pool.js";
import { createDb } from "./client.js";
import { importLegacyKnowledge } from "./import-sqlite.js";
import { PostgresKnowledgeStore } from "../store/postgres-store.js";
import { PostgresArtifactStore } from "./artifact-store.js";

it("imports legacy SQLite metadata/source state/files atomically and advances audit sequences", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-import-"));
  const data = join(root, "data"),
    dir = join(data, "tenant", "team", "wiki-legacy");
  mkdirSync(join(dir, "raw/sources"), { recursive: true });
  writeFileSync(join(dir, "raw/sources/legacy.md"), "# Legacy 原文");
  const old = new DatabaseSync(join(root, "knowledge.db"));
  old.exec(`CREATE TABLE knowledge_wiki(wiki_id TEXT PRIMARY KEY,service_id TEXT,team_id TEXT,name TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO knowledge_wiki VALUES('wiki-legacy','tenant','team','Legacy','ready','2026-01-01','2026-01-02');
    CREATE TABLE knowledge_wiki_audit(id INTEGER PRIMARY KEY,wiki_id TEXT,service_id TEXT,version INTEGER,action TEXT,created_at TEXT);
    INSERT INTO knowledge_wiki_audit VALUES(42,'wiki-legacy','tenant',1,'ready','2026-01-02');`);
  old.close();
  const index = new DatabaseSync(join(dir, "index.db"));
  index.exec(`CREATE TABLE source(filename TEXT PRIMARY KEY,sha256 TEXT,size INTEGER,status TEXT,created_at TEXT,updated_at TEXT,last_modified_by TEXT,ingested_at TEXT,ingest_error TEXT);
    INSERT INTO source VALUES('legacy.md','legacy-sha',15,'ingested','2026-01-01','2026-01-02','author','2026-01-03',NULL);`);
  index.close();
  const pool = new TestPool();
  try {
    const { db } = await createDb({
      connectionString: "postgres://test",
      pool,
    });
    const counts = await importLegacyKnowledge(pool, {
      sqlitePath: join(root, "knowledge.db"),
      dataDir: data,
    });
    expect(counts).toMatchObject({
      knowledge_wiki: 1,
      knowledge_wiki_audit: 1,
      wiki_sources: 1,
      resource_snapshots: 1,
    });
    const store = new PostgresKnowledgeStore(db);
    expect((await store.getWikiById("tenant", "wiki-legacy"))?.name).toBe(
      "Legacy",
    );
    await store.appendWikiAudit({
      service_id: "tenant",
      asset_id: "wiki-legacy",
      version: 2,
      action: "ready",
    });
    expect((await store.listWikiAudit("tenant", "wiki-legacy"))[0].id).toBe(43);
    rmSync(data, { recursive: true, force: true });
    await new PostgresArtifactStore(pool, data).restoreAll();
    expect(readFileSync(join(dir, "raw/sources/legacy.md"), "utf8")).toContain(
      "原文",
    );
    await expect(
      importLegacyKnowledge(pool, {
        sqlitePath: join(root, "knowledge.db"),
        dataDir: data,
      }),
    ).rejects.toThrow("empty PostgreSQL");
    expect(await store.countWikis("tenant", "team")).toBe(1);
  } finally {
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("rolls back the whole import if a registered resource directory is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-import-fail-"));
  const old = new DatabaseSync(join(root, "old.db"));
  old.exec(`CREATE TABLE knowledge_wiki(wiki_id TEXT PRIMARY KEY,service_id TEXT,team_id TEXT,name TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO knowledge_wiki VALUES('wiki-missing','t','g','Missing','2026-01-01','2026-01-01');`);
  old.close();
  const pool = new TestPool();
  try {
    const { db } = await createDb({
      connectionString: "postgres://test",
      pool,
    });
    await expect(
      importLegacyKnowledge(pool, {
        sqlitePath: join(root, "old.db"),
        dataDir: root,
      }),
    ).rejects.toThrow("Missing source directory");
    expect(await new PostgresKnowledgeStore(db).countWikis("t", "g")).toBe(0);
  } finally {
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
