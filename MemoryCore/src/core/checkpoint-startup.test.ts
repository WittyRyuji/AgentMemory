import { describe, expect, it, vi } from "vitest";
import { TdaiCore } from "./tdai-core.js";

function fixture() {
  const initial = {
    l0_conversations_count: 99,
    total_memories_extracted: 88,
    runner_states: {},
    pipeline_states: { session: { conversation_count: 7 } },
  };
  let raw = JSON.stringify(initial);
  const core = Object.create(TdaiCore.prototype) as any;
  core.dataDir = "/path-that-must-not-be-used-for-checkpoints";
  core.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  core.storage = {
    readFile: vi.fn(async () => raw),
    writeFile: vi.fn(async (_path: string, value: string) => { raw = value; }),
  };
  core.vectorStore = { countL0: vi.fn(async () => 3), countL1: vi.fn(async () => 4) };
  core.scheduler = { start: vi.fn() };
  return { core, initial, read: () => JSON.parse(raw) };
}

describe("local scheduler checkpoint reconciliation", () => {
  it("awaits async counts and reconciles once before concurrent scheduler starts", async () => {
    const { core, read } = fixture();
    core.scheduler.start.mockImplementation(() => {
      expect(read()).toMatchObject({ l0_conversations_count: 3, total_memories_extracted: 4 });
    });
    await Promise.all([core.ensureSchedulerStarted(), core.ensureSchedulerStarted()]);
    await core.ensureSchedulerStarted();
    expect(core.vectorStore.countL0).toHaveBeenCalledOnce();
    expect(core.vectorStore.countL1).toHaveBeenCalledOnce();
    expect(core.scheduler.start).toHaveBeenCalledOnce();
    expect(core.scheduler.start).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ conversation_count: 7 }) }));
  });

  it("keeps checkpoint state and starts normally when counting fails", async () => {
    const { core, read, initial } = fixture();
    core.vectorStore.countL0.mockRejectedValue(new Error("store unavailable"));
    await core.ensureSchedulerStarted();
    expect(read()).toEqual(initial);
    expect(core.storage.writeFile).not.toHaveBeenCalled();
    expect(core.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Checkpoint recalculate skipped"));
    expect(core.scheduler.start).toHaveBeenCalledOnce();
  });

  it("does not reset counters in degraded mode without a store", async () => {
    const { core, read, initial } = fixture();
    core.vectorStore = undefined;
    await core.ensureSchedulerStarted();
    expect(read()).toEqual(initial);
    expect(core.storage.writeFile).not.toHaveBeenCalled();
    expect(core.scheduler.start).toHaveBeenCalledOnce();
  });

  it("never reconciles global counts when a distributed scheduler is injected", async () => {
    const { core } = fixture();
    const manager = { start: vi.fn() };
    core.setStatefulPipelineManager(manager);
    await core.ensureSchedulerStarted();
    expect(core.vectorStore.countL0).not.toHaveBeenCalled();
    expect(core.storage.writeFile).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
  });
});
