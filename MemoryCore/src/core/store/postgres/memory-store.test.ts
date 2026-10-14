import { beforeAll, afterAll, it, expect } from "vitest";
import { TestPostgresPool } from "./test-pool.js";
import { PostgresDatabase, instanceSchema } from "./client.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { PostgresStorageBackend } from "../../storage/postgres-backend.js";
import type { MemoryRecord } from "../types.js";
const pool = new TestPostgresPool();
const db = new PostgresDatabase(pool, instanceSchema("core-contract"));
const store = new PostgresMemoryStore({ db, dimensions: 3 });
const vector = new Float32Array([1, 0, 0]);
const l0 = (id: string, team = "team") => ({
  id,
  sessionKey: "session",
  sessionId: "session",
  teamId: team,
  agentId: "agent",
  userId: "user",
  role: "user",
  messageText: "用户喜欢 PostgreSQL 编程",
  recordedAt: "2026-10-01T10:00:00Z",
  timestamp: 1790848800000,
});
const l1 = (id: string, team = "team"): MemoryRecord => ({
  id,
  content: "The user prefers PostgreSQL",
  type: "persona",
  priority: 80,
  scene_name: "database",
  sessionKey: "session",
  sessionId: "session",
  teamId: team,
  agentId: "agent",
  userId: "user",
  timestamps: ["2026-10-01T10:00:00Z"],
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  version: 1,
  metadata: {},
});
beforeAll(() => store.init({ provider: "openai", model: "test" }));
afterAll(() => pool.end());
it("persists scoped L0/L1, queries pgvector and full-text, and rejects ownership changes", async () => {
  await store.upsertL0(l0("l0"), vector);
  await store.upsertL1(l1("l1"), vector);
  await store.upsertL1(l1("other", "other"), new Float32Array([0, 1, 0]));
  expect(await store.countL1({ teamId: "team" })).toBe(1);
  expect(
    (await store.searchL1Vector(vector, 10, undefined, { teamId: "team" }))[0],
  ).toMatchObject({ record_id: "l1", score: 1 });
  expect(
    await store.searchL1Vector(vector, 10, undefined, { teamId: "missing" }),
  ).toEqual([]);
  expect(
    (
      await store.searchL0Fts('"PostgreSQL" OR "不存在"', 10, {
        teamId: "team",
      })
    )[0].record_id,
  ).toBe("l0");
  expect(
    (await store.searchL0Fts("编程", 10, { teamId: "team" }))[0].record_id,
  ).toBe("l0");
  await expect(store.upsertL1(l1("l1", "other"), vector)).rejects.toThrow(
    "ownership",
  );
  expect(
    (await store.queryL0GroupedBySessionId("session"))[0].messages[0].id,
  ).toBe("l0");
  expect(
    (await store.queryL1Paginated({ teamId: "team", limit: 1, offset: 0 }))
      .total,
  ).toBe(1);
  await store.upsertL1({ ...l1("l1"), content: "changed" });
  expect(
    await store.searchL1Vector(vector, 10, undefined, { teamId: "team" }),
  ).toEqual([]);
  await expect(
    store.upsertL1(l1("bad"), new Float32Array([1, 2])),
  ).rejects.toThrow("3 finite");
});
it("batch insert rolls back on duplicates and has no cross-instance visibility", async () => {
  await expect(store.insertL0Batch([l0("batch"), l0("l0")])).rejects.toThrow();
  expect((await store.getAllL0Texts()).map((r) => r.record_id)).not.toContain(
    "batch",
  );
  const other = new PostgresMemoryStore({
    db: new PostgresDatabase(pool, instanceSchema("other-instance")),
    dimensions: 3,
  });
  await other.init();
  expect(await other.countL0()).toBe(0);
});
it("profiles use atomic version checks and clear requires scope", async () => {
  const profile = {
    id: "profile",
    type: "l2" as const,
    filename: "scene_blocks/a.md",
    content: "a",
    contentMd5: "test",
    teamId: "team",
    agentId: "agent",
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  await store.syncProfiles([profile]);
  await store.syncProfiles([{ ...profile, version: 2, baselineVersion: 1 }]);
  await expect(
    store.syncProfiles([{ ...profile, version: 3, baselineVersion: 1 }]),
  ).rejects.toThrow("optimistic");
  expect(
    (
      await store.queryProfiles({ pathPrefix: "scene_blocks/", teamId: "team" })
    )[0].version,
  ).toBe(2);
  await expect(
    store.clearMemoryContent({ teamId: "", agentId: "agent" }),
  ).rejects.toThrow();
  const result = await store.clearMemoryContent({
    teamId: "team",
    agentId: "agent",
  });
  expect(result).toEqual({ l0Deleted: 1, l1Deleted: 1, profilesDeleted: 1 });
  expect(await store.countL1()).toBe(1);
});
it("object storage round-trips binary, atomic append and prefix pagination", async () => {
  const files = new PostgresStorageBackend(db);
  await files.putObject("skills/a.bin", Buffer.from([0, 255, 34]), {
    contentType: "application/octet-stream",
    metadata: { key: "value" },
  });
  expect((await files.getObject("skills/a.bin"))?.content).toEqual(
    Buffer.from([0, 255, 34]),
  );
  await Promise.all(
    Array.from({ length: 5 }, () =>
      files.appendObject("conversation/log", "hello\n"),
    ),
  );
  expect((await files.getObject("conversation/log"))?.content.toString()).toBe(
    "hello\n".repeat(5),
  );
  expect(
    (await files.listObjects("", { recursive: false })).entries.map(
      (r) => r.key,
    ),
  ).toEqual(["conversation/", "skills/"]);
  expect(await files.deleteByPrefix("skills/")).toBe(1);
  expect(await files.exists("conversation/log")).toBe(true);
});
it("refuses model/dimension drift rather than silently mixing vector spaces", async () => {
  const changed = new PostgresMemoryStore({ db, dimensions: 3 });
  await expect(
    changed.init({ provider: "openai", model: "different" }),
  ).rejects.toThrow("re-embedding");
});
