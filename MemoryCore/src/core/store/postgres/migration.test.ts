import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  migrateSqliteToPostgres,
  type ImportOptions,
} from "../../../../scripts/migrate-sqlite-to-postgres/migrate.js";
import { VectorStore } from "../sqlite/memory-store.js";
import { SqliteMetadataStore } from "../../../metadata/store/sqlite-adapter.js";
import { PostgresMetadataStore } from "../../../metadata/store/postgres-adapter.js";
import { PostgresDatabase, instanceSchema } from "./client.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { TestPostgresPool } from "./test-pool.js";
import { PostgresStorageBackend } from "../../storage/postgres-backend.js";
const dir = mkdtempSync(join(tmpdir(), "pg-import-"));
const opts: ImportOptions = {
  instanceId: "import",
  memorySqlite: join(dir, "memory.db"),
  metadataSqlite: join(dir, "metadata.db"),
  filesRoot: join(dir, "files"),
  provider: "openai",
  model: "fixture",
  dimensions: 3,
  profileIsolation: { teamId: "team", agentId: "agent" },
};
const pool = new TestPostgresPool();
const db = new PostgresDatabase(pool, instanceSchema(opts.instanceId));
let userId = "",
  keyValue = "";
beforeAll(() => {
  const sqlite = new VectorStore(opts.memorySqlite!, 3);
  sqlite.init({ provider: opts.provider, model: opts.model });
  expect(sqlite.isDegraded()).toBe(false);
  sqlite.upsertL0(
    {
      id: "message",
      sessionKey: "session",
      sessionId: "session",
      teamId: "team",
      agentId: "agent",
      userId: "user",
      role: "user",
      messageText: "PostgreSQL 数据库",
      recordedAt: "2026-10-01T00:00:00Z",
      timestamp: 1,
    },
    new Float32Array([1, 0, 0]),
  );
  sqlite.createMemoryPrompt({
    memory_prompt_id: "prompt",
    name: "Preserved",
    layer: "l1",
    prompt: "Extract",
    version: 2,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 2,
  });
  sqlite.close();
  const meta = new SqliteMetadataStore(opts.metadataSqlite!);
  meta.init();
  const user = meta.createUser({
    auth_provider: "local",
    external_id: "fixture",
    username: "fixture",
  });
  userId = user.user_id;
  keyValue = meta.getDefaultUserKey(userId)!.key_value;
  meta.close();
  mkdirSync(join(opts.filesRoot!, "skills"), { recursive: true });
  writeFileSync(join(opts.filesRoot!, "persona.md"), "# Preserved persona");
  writeFileSync(
    join(opts.filesRoot!, "skills", "resource.bin"),
    Buffer.from([0, 255, 42]),
  );
});
afterAll(async () => {
  await pool.end();
  rmSync(dir, { recursive: true, force: true });
});
it("dry-run reads sources without connecting or mutating PostgreSQL", async () => {
  const before = readFileSync(opts.memorySqlite!);
  const report = await migrateSqliteToPostgres(opts, {
    initialize() {
      throw new Error("target touched");
    },
  } as any);
  expect(report.applied).toBe(false);
  expect(report.counts.l0_conversations).toBe(1);
  expect(report.counts.meta_users).toBe(1);
  expect(report.counts.files).toBe(2);
  expect(readFileSync(opts.memorySqlite!)).toEqual(before);
});
it("imports metadata keys, vectors, prompts, scoped profiles and resources atomically", async () => {
  const report = await migrateSqliteToPostgres({ ...opts, apply: true }, db);
  expect(report.applied).toBe(true);
  expect(report.vectorsCopied).toBe(1);
  const store = new PostgresMemoryStore({ db, dimensions: 3 });
  await store.init({ provider: opts.provider, model: opts.model });
  expect(
    (
      await store.searchL0Vector(new Float32Array([1, 0, 0]), 10, undefined, {
        teamId: "team",
      })
    )[0].record_id,
  ).toBe("message");
  expect(
    (await store.queryProfiles({ teamId: "team", agentId: "agent" }))[0]
      .content,
  ).toContain("Preserved persona");
  expect((await store.getMemoryPrompts(["prompt"]))[0].version).toBe(2);
  const meta = new PostgresMetadataStore(
    new PostgresDatabase(pool, instanceSchema(opts.instanceId, "metadata")),
  );
  await meta.init();
  expect((await meta.getUserByKey(keyValue))?.user_id).toBe(userId);
  expect(
    (await new PostgresStorageBackend(db).getObject("skills/resource.bin"))
      ?.content,
  ).toEqual(Buffer.from([0, 255, 42]));
  await expect(
    migrateSqliteToPostgres({ ...opts, apply: true }, db),
  ).rejects.toThrow("not empty");
});
it("a late file failure rolls back metadata, rows and objects together", async () => {
  const id = "rollback",
    target = new PostgresDatabase(pool, instanceSchema(id));
  writeFileSync(
    join(opts.filesRoot!, "skills", "resource.bin.meta.json"),
    "invalid json",
  );
  await expect(
    migrateSqliteToPostgres({ ...opts, instanceId: id, apply: true }, target),
  ).rejects.toThrow();
  expect(
    Number(
      (await target.query<{ n: string }>("SELECT count(*) AS n FROM memory_l0"))
        .rows[0].n,
    ),
  ).toBe(0);
  const meta = new PostgresMetadataStore(
    new PostgresDatabase(pool, instanceSchema(id, "metadata")),
  );
  await meta.init();
  expect(await meta.getUserById(userId)).toBeNull();
});
it("requires explicit ownership for unscoped profiles and refuses unknown tables", async () => {
  await expect(
    migrateSqliteToPostgres({ ...opts, profileIsolation: undefined }),
  ).rejects.toThrow("Unscoped profile");
  const sqlite = new DatabaseSync(opts.memorySqlite!);
  sqlite.exec("CREATE TABLE unknown_business (id TEXT)");
  sqlite.close();
  const report = await migrateSqliteToPostgres(opts);
  expect(report.skipped).toContain("table:unknown_business");
  await expect(
    migrateSqliteToPostgres({ ...opts, apply: true }, db),
  ).rejects.toThrow("Unsupported source");
});
