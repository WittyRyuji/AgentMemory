import { afterAll, beforeAll, expect, it } from "vitest";
import { TestPostgresPool } from "./test-pool.js";
import { PostgresDatabase, instanceSchema } from "./client.js";
import { PostgresStateBackend } from "../../state/postgres-backend.js";
import { PostgresSkillStore } from "./skill-store.js";
import { PostgresSkillAgentTaskQueue } from "../../skill/conversation-add/postgres-agent-task-queue.js";
import type { TaskPayload } from "../../state/types.js";
const pool = new TestPostgresPool();
const db = new PostgresDatabase(pool, instanceSchema("state-skill"));
const state = new PostgresStateBackend(db);
const task = (id: string, priority = 1): TaskPayload => ({
  id,
  type: "L1",
  instanceId: "instance",
  sessionId: "session",
  priority,
  createdAt: Date.now(),
});
beforeAll(async () => {
  await state.initialize();
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
});
afterAll(() => pool.end());
it("durable queue claims are owner-bound, reclaimable and atomically replaceable", async () => {
  await state.enqueueTask(task("low", 2));
  await state.enqueueTask(task("high", 0));
  const first = (await state.consumeTask("one"))!;
  expect(first.id).toBe("high");
  expect(await state.ackTaskIfOwned(first._msgId!, "other")).toBe(false);
  await state.refreshTaskClaim(first._msgId!, "one", 1000);
  const claimed = await state.claimStaleTasks("two", 500, 1);
  expect(claimed[0]._ownerId).toBe("two");
  expect(
    await state.replacePendingTask(first._msgId!, "one", task("unauthorized")),
  ).toBe(false);
  expect(
    await state.replacePendingTask(first._msgId!, "two", task("retry", 0)),
  ).toBe(true);
  const second = (await new PostgresStateBackend(db).consumeTask("restart"))!;
  expect(second.id).toBe("retry");
  await state.ackTaskIfOwned(second._msgId!, "restart");
  expect(await state.getQueueDepth()).toEqual({ high: 0, low: 1 });
});
it("atomic capture preserves concurrent rounds, buffers, scoped sessions and timers", async () => {
  await Promise.all(
    Array.from({ length: 10 }, (_, n) =>
      state.captureAtomic({
        instanceId: "capture",
        sessionId: "session:colon",
        teamId: "team",
        agentId: "agent",
        messageJson: String(n),
        threshold: 3,
        fireAtMs: Date.now() + 10000,
        timerMember: "session:colon:L1_idle",
        taskPayload: { ...task(`capture-${n}`), instanceId: "capture" },
        nowMs: Date.now(),
        rounds: 1,
      }),
    ),
  );
  expect(
    (await state.getSessionState("capture", "session:colon", "team", "agent"))
      ?.conversation_count,
  ).toBe(1);
  expect(
    await state.getBufferLength("capture", "session:colon", "team", "agent"),
  ).toBe(10);
  expect(
    await state.getBufferLength("capture", "session:colon", "other", "agent"),
  ).toBe(0);
  expect(await state.listActiveSessions("capture")).toEqual(["session:colon"]);
  expect(
    (await state.drainBuffer("capture", "session:colon", "team", "agent"))
      .length,
  ).toBe(10);
  expect(
    (await state.listQueuedTasks()).filter((t) => t.instanceId === "capture"),
  ).toHaveLength(3);
});
it("timer dispatch rolls back if task construction fails; locks cannot be stolen", async () => {
  await state.setTimer("instance", "due:L2_schedule", 1);
  await expect(
    state.dispatchExpiredTimers(() => {
      throw new Error("fail");
    }),
  ).rejects.toThrow("fail");
  expect(
    await state.dispatchExpiredTimers((entry) => ({
      ...task("timer"),
      sessionId: entry.member.split("\0")[1],
    })),
  ).toBe(1);
  expect(await state.dispatchExpiredTimers(() => task("duplicate"))).toBe(0);
  expect(await state.acquireLock("lock", "a", 10000)).toBe(true);
  expect(await state.acquireLock("lock", "b", 10000)).toBe(false);
  expect(await state.renewLock("lock", "b", 10000)).toBe(false);
  await state.releaseLock("lock", "b");
  expect(await state.acquireLock("lock", "b", 10000)).toBe(false);
});
const embedding = {
  embed: async () => new Float32Array([1, 0, 0]),
  embedBatch: async (texts: string[]) =>
    texts.map(() => new Float32Array([1, 0, 0])),
  getDimensions: () => 3,
  getProviderInfo: () => ({ provider: "test", model: "test" }),
  isReady: () => true,
  startWarmup: () => {},
};
const skills = new PostgresSkillStore(db, embedding);
const skillInput = {
  team_id: "team",
  owner_agent_id: "agent",
  skill_id: "skill",
  name: "postgres-backup",
  description: "PostgreSQL backup workflow",
  content: "Back up PostgreSQL safely.",
  content_hash: "hash",
  manifest: [],
  storage_dir: "unused",
};
it("skill versions, names, archive and vectors preserve the existing contract", async () => {
  await skills.initialize();
  expect((await skills.appendVersion(skillInput)).version).toBe(1);
  await Promise.all([
    skills.appendVersion({ ...skillInput, content_hash: "two" }),
    skills.appendVersion({ ...skillInput, content_hash: "three" }),
  ]);
  expect((await skills.getHead("skill", "team"))?.version).toBe(3);
  expect(await skills.getHead("skill", "other")).toBeNull();
  expect(await skills.countVersions("skill", "team")).toBe(3);
  expect((await skills.listSkills({ team_id: "team" })).total).toBe(1);
  expect(
    (await skills.searchSkills({ query: "PostgreSQL", team_id: "team" }))[0]
      .skill.skill_id,
  ).toBe("skill");
  expect(
    (
      await skills.searchSkills({
        query: "anything",
        queryEmbedding: new Float32Array([1, 0, 0]),
        mode: "embedding",
        team_id: "team",
      })
    )[0].score,
  ).toBe(1);
  await expect(
    skills.appendVersion({ ...skillInput, skill_id: "collision" }),
  ).rejects.toThrow("SKILL_NAME_DUPLICATE");
  expect(await skills.deleteVersion("skill", 3)).toBe(false);
  expect(await skills.deleteVersion("skill", 1)).toBe(true);
  expect(await skills.archiveHead("skill", "team")).toEqual({ archived: true });
  expect(await skills.getHead("skill", "team")).toBeNull();
  expect(
    (await skills.appendVersion({ ...skillInput, content_hash: "revived" }))
      .version,
  ).toBe(4);
});
it("skill queue survives recreation, rotates atomically and protects extract locks", async () => {
  const tuple = {
    instance_id: "i",
    space_id: "s",
    user_id: "u",
    team_id: "t",
    agent_id: "a",
  };
  const queue = new PostgresSkillAgentTaskQueue(db);
  expect(await queue.enqueueAgent(tuple)).toBe(true);
  expect(await queue.enqueueAgent(tuple)).toBe(false);
  expect(await new PostgresSkillAgentTaskQueue(db).peekAgent(0)).toEqual(tuple);
  expect(await queue.peekAgent(0)).toEqual(tuple);
  const lock = await queue.acquireExtractLock(tuple, 10000);
  expect(lock).not.toBeNull();
  expect(await queue.acquireExtractLock(tuple, 10000)).toBeNull();
  await queue.releaseExtractLock(lock!);
  expect(await queue.acquireExtractLock(tuple, 10000)).not.toBeNull();
  await queue.withTasksMutex(
    tuple,
    { lockTtlMs: 1000, waitDeadlineMs: 1000 },
    async () => {},
  );
  await queue.removeAgent(tuple);
  expect(await queue.peekAgent(0)).toBeNull();
});
