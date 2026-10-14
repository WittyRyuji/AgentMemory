import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointManager } from "./checkpoint.js";
import type { StorageAdapter } from "../core/storage/adapter.js";

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-reconcile-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("checkpoint reconciliation retained from main", () => {
  it("reduces drifted counters and preserves pipeline/capture state", async () => {
    const manager = new CheckpointManager(await tempDir());
    const initial = await manager.read();
    initial.l0_conversations_count = 91;
    initial.total_memories_extracted = 72;
    initial.total_processed = 63;
    initial.scenes_processed = 54;
    initial.memories_since_last_persona = 9;
    initial.runner_states.session = { last_captured_timestamp: 123, last_l1_cursor: 111, last_scene_name: "coding" };
    await manager.write(initial);
    const result = await manager.recalculate({ l0Conversations: 0, l1Memories: 2 });
    expect(result).toEqual({ ...initial, l0_conversations_count: 0, total_memories_extracted: 2 });
    expect(await manager.read()).toEqual(result);
  });

  it("supports optional fields without resetting omitted counters", async () => {
    const manager = new CheckpointManager(await tempDir());
    await manager.recalculate({ l0Conversations: 4, l1Memories: 3, totalProcessed: 2, scenesProcessed: 1 });
    await manager.recalculate({ totalProcessed: 0, scenesProcessed: 0 });
    expect(await manager.recalculate({})).toMatchObject({ l0_conversations_count: 4, total_memories_extracted: 3, total_processed: 0, scenes_processed: 0 });
  });

  it("uses the injected storage and distributed lock without local files", async () => {
    let raw: string | null = null;
    const storage = {
      readFile: vi.fn(async () => raw),
      writeFile: vi.fn(async (_path: string, value: string) => { raw = value; }),
    } as unknown as StorageAdapter;
    const lock = { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}), renewLock: vi.fn(async () => true) };
    const dir = await tempDir();
    const manager = new CheckpointManager(dir, undefined, storage, { lock, lockKey: "instance-a" });
    await manager.recalculate({ l0Conversations: 1, l1Memories: 2 });
    expect(storage.readFile).toHaveBeenCalled();
    expect(storage.writeFile).toHaveBeenCalledOnce();
    expect(lock.acquireLock).toHaveBeenCalledWith("checkpoint:instance-a", expect.any(String), expect.any(Number));
    expect(lock.releaseLock).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, ".metadata"))).toBe(false);
    expect(await manager.read()).toMatchObject({ l0_conversations_count: 1, total_memories_extracted: 2 });
  });

  it("does not write when the distributed lock backend fails", async () => {
    const storage = { readFile: vi.fn(), writeFile: vi.fn() } as unknown as StorageAdapter;
    const lock = { acquireLock: vi.fn(async () => { throw new Error("offline"); }), releaseLock: vi.fn(), renewLock: vi.fn() };
    const manager = new CheckpointManager(await tempDir(), undefined, storage, { lock, lockKey: "instance-a" });
    await expect(manager.recalculate({ l0Conversations: 1 })).rejects.toMatchObject({ code: "CHECKPOINT_LOCK_UNAVAILABLE" });
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("serializes reconciliation with other counter mutations", async () => {
    const dir = await tempDir();
    const first = new CheckpointManager(dir);
    const second = new CheckpointManager(dir);
    await Promise.all([first.recalculate({ l0Conversations: 3 }), second.incrementScenesProcessed()]);
    expect(await first.read()).toMatchObject({ l0_conversations_count: 3, scenes_processed: 1 });
  });
});
