import { it, expect, vi } from "vitest";
import type pg from "pg";
import { acquireKnowledgeLease } from "./client.js";
import { redactLogText, createLogger } from "../logger.js";

it("fails closed when another process already holds the PG writer lease", async () => {
  const release = vi.fn();
  const fake = {
    connect: async () => ({
      query: async () => ({ rows: [{ acquired: false }] }),
      release,
    }),
  } as unknown as pg.Pool;
  await expect(acquireKnowledgeLease(fake)).rejects.toThrow(
    "Another Knowledge process",
  );
  expect(release).toHaveBeenCalledOnce();
});
it("redacts SQL binds and URL credentials from generic logs", () => {
  expect(
    redactLogText("Failed query: insert binding\nparams: secret-token"),
  ).not.toContain("secret-token");
  expect(
    redactLogText("connection postgresql://owner:password@localhost/db failed"),
  ).not.toContain("password");
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    createLogger("test").warn("failed", {
      api_key: "secret",
      nested: { cred_secret: "encoded-secret" },
    });
    expect(spy.mock.calls.flat().join()).not.toContain("encoded-secret");
  } finally {
    spy.mockRestore();
  }
});

it.skipIf(!process.env.PG_TEST_URL)(
  "enforces the writer lease across real PostgreSQL sessions",
  async () => {
    const { TestPool } = await import("./__tests__/test-pool.js");
    const first = new TestPool(),
      second = new TestPool();
    let unlockFirst: (() => Promise<void>) | undefined,
      unlockSecond: (() => Promise<void>) | undefined;
    try {
      unlockFirst = await acquireKnowledgeLease(first);
      await expect(acquireKnowledgeLease(second)).rejects.toThrow(
        "Another Knowledge process",
      );
      await unlockFirst();
      unlockFirst = undefined;
      unlockSecond = await acquireKnowledgeLease(second);
    } finally {
      if (unlockSecond) await unlockSecond();
      if (unlockFirst) await unlockFirst();
      await first.end();
      await second.end();
    }
  },
);
