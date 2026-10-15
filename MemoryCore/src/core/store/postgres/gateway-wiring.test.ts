import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestPostgresPool } from "./test-pool.js";
// Only the wire transport is replaced. Schemas, transactions, queries and vector
// operators execute in PostgreSQL (PGlite); no SQLite/mock store is involved.
const { pools } = vi.hoisted(() => ({ pools: [] as TestPostgresPool[] }));
vi.mock("pg", () => ({
  Pool: class {
    private pool: TestPostgresPool;
    constructor() {
      if (!pools.length) pools.push(new TestPostgresPool(true));
      this.pool = pools[0];
    }
    on() {
      return this;
    }
    connect() {
      return this.pool.connect();
    }
    end() {
      return Promise.resolve();
    }
  },
}));
import { loadGatewayConfig } from "../../../gateway/config.js";
import { StorePool } from "../store-pool.js";
import { LocalBackendResolver } from "../../backend-selection/local-resolver.js";
import { TdaiGateway } from "../../../gateway/server.js";
import { scopeProfileStorageView } from "../../storage/adapter.js";
import { createPostgresEmbedding } from "../factory.js";
const dir = mkdtempSync(join(tmpdir(), "pg-wiring-"));
const configFile = join(dir, "config.json");
writeFileSync(
  configFile,
  JSON.stringify({
    deployMode: "standalone",
    instanceId: "wiring",
    worker: { concurrency: 1 },
    skill: { enabled: true, extraction: { enabled: false } },
    data: { baseDir: dir, fileStore: "rowfs", fileStoreOthers: "postgres" },
    memory: {
      storeBackend: "postgres",
      postgres: { url: "postgresql://unused/test" },
      embedding: {
        enabled: true,
        provider: "openai",
        baseUrl: "https://embedding.invalid/v1",
        apiKey: "test-only",
        model: "test",
        dimensions: 3,
      },
      bm25: { enabled: false },
      extraction: { enabled: false },
      skill: { enabled: true },
    },
  }),
);
vi.stubEnv("TDAI_GATEWAY_CONFIG", configFile);
vi.stubEnv("STORE_MODE", "postgres");
vi.stubEnv("TDAI_POSTGRES_URL", "postgresql://unused/test");
const cfg = loadGatewayConfig();
beforeEach(() => {
  vi.stubEnv("TDAI_GATEWAY_CONFIG", configFile);
  vi.stubEnv("STORE_MODE", "postgres");
  vi.stubEnv("TDAI_POSTGRES_URL", "postgresql://unused/test");
});
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const pool = new StorePool({
  mode: "postgres",
  memoryCfg: cfg.memory,
  dataDir: dir,
  logger,
});
(pool as any).graceCloseDelayMs = 0;
const source = {
  resolveVdb: async () => null,
  resolveMongo: async () => null,
  resolveCos: async () => null,
};
const resolver = new LocalBackendResolver({
  deployMode: "standalone",
  storeMode: "postgres",
  fileStore: "rowfs",
  fileStoreOthers: "postgres",
  source,
});
afterAll(async () => {
  await pool.closeAll();
  for (const p of pools) {
    if (!(p as any).pg?.closed) await p.end().catch(() => {});
  }
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
it("gateway resolves PG-only storage for per-instance profiles, sessions and skills", async () => {
  expect(cfg.stateBackend).toBe("postgres");
  expect((await resolver.resolve("one")).fs.others.kind).toBe("postgres");
  const gateway = new TdaiGateway() as any;
  gateway.storePool = pool;
  gateway.backendResolver = resolver;
  gateway.configProvider = source;
  const storage = await gateway.resolveStorageForInstance("one");
  const scoped = scopeProfileStorageView(storage, "", {
    teamId: "team",
    agentId: "agent",
  });
  await scoped.writeFile("persona.md", "# Durable persona");
  await scoped.writeFile("scene_blocks/code.md", "# Code\nPostgreSQL");
  const { store } = await pool.getStore("one", null);
  expect(
    await store.countProfiles?.({ teamId: "team", agentId: "agent" }),
  ).toBe(2);
  expect(
    await scopeProfileStorageView(storage, "", {
      teamId: "other",
      agentId: "agent",
    }).exists("persona.md"),
  ).toBe(false);
  const sessions = await gateway.resolveSessionStorageForInstance("one");
  expect(sessions.type).toBe("postgres");
  await sessions.appendFile("conversations/test.jsonl", '{"role":"user"}\n');
  const restarted = await gateway.resolveSessionStorageForInstance("one");
  expect(await restarted.readFile("conversations/test.jsonl")).toContain(
    '"user"',
  );
  const other = await gateway.resolveStorageForInstance("two");
  expect(
    await scopeProfileStorageView(other, "", {
      teamId: "team",
      agentId: "agent",
    }).exists("persona.md"),
  ).toBe(false);
  expect((await pool.getSkillStore("one", null)).isDegraded()).toBe(false);
  const meta = await gateway.ensureMetadataStore("one");
  expect(meta.constructor.name).toBe("PostgresMetadataStore");
  await gateway.metadataStorePool.closeAll();
});
it("PG mode rejects local embeddings rather than loading a model or falling back", () => {
  expect(() =>
    createPostgresEmbedding(
      {
        ...cfg.memory,
        embedding: { ...cfg.memory.embedding, provider: "local" },
      },
      logger,
    ),
  ).toThrow();
  expect(() =>
    createPostgresEmbedding(
      { ...cfg.memory, embedding: { ...cfg.memory.embedding, apiKey: "" } },
      logger,
    ),
  ).toThrow();
});

it("starts and stops the actual gateway lifecycle with only the HTTP listener stubbed", async () => {
  const server = new EventEmitter() as any;
  server.listen = (_port: number, _host: string, done: () => void) => {
    done();
    return server;
  };
  server.close = (done: () => void) => {
    done();
    return server;
  };
  vi.spyOn(http, "createServer").mockReturnValue(server);
  vi.stubEnv("WORKER_CONCURRENCY", "1");
  vi.stubEnv("TDAI_SKILL_WORKER_CONCURRENCY", "1");
  const gateway = new TdaiGateway() as any;
  try {
    await gateway.start();
    expect(gateway.core.getVectorStore().constructor.name).toBe(
      "PostgresMemoryStore",
    );
    expect(gateway.core.getStorage().type).toBe("rowfs");
    expect(gateway.core.getSkillCore()).toBeDefined();
    expect(gateway.stateBackend.constructor.name).toBe("PostgresStateBackend");
    expect(gateway.metadataStorePool.backend).toBe("postgres");
  } finally {
    await gateway.stop();
  }
});

it("concurrent first requests wait for the PostgreSQL schema to be ready", async () => {
  await Promise.all(Array.from({length: 8}, async () => {
    const {store} = await pool.getStore("concurrent-cold-start",null);
    expect(store.isDegraded()).toBe(false);
    expect(await store.countProfiles?.()).toBe(0);
  }));
});

it("endpoint-only Ark configuration is shared by L1 writes and vector recall", async () => {
  const endpoint = "https://ark.invalid/api/v3/embeddings/multimodal?version=test";
  const memoryCfg = { ...cfg.memory, embedding: { ...cfg.memory.embedding,
    baseUrl: "", endpoint, format: "ark-multimodal" as const, sendDimensions: false,
  } };
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ data: { embedding: [1, 0, 0] } }));
  vi.stubGlobal("fetch", fetchMock);
  const arkPool = new StorePool({ mode: "postgres", memoryCfg, dataDir: dir, logger });
  (arkPool as any).graceCloseDelayMs = 0;
  try {
    const { store, embedding } = await arkPool.getStore("ark-endpoint", null);
    expect(embedding.getDimensions()).toBe(3);
    const now = new Date().toISOString();
    await store.upsertL1({ id: "ark-l1", content: "synthetic memory", type: "persona", priority: 80,
      scene_name: "test", sessionKey: "session", sessionId: "session", teamId: "team", agentId: "agent",
      userId: "user", timestamps: [now], createdAt: now, updatedAt: now, version: 1, metadata: {},
    }, await embedding.embed("synthetic memory"));
    const recalled = await store.searchL1Vector(await embedding.embed("synthetic query"), 5, undefined, { teamId: "team" });
    expect(recalled[0].record_id).toBe("ark-l1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([endpoint, endpoint]);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body))).toEqual(
      ["synthetic memory", "synthetic query"].map(text => ({ model: "test", encoding_format: "float", input: [{ type: "text", text }] })),
    );
    expect(createPostgresEmbedding(memoryCfg).getProviderInfo()).toEqual(embedding.getProviderInfo());
  } finally { await arkPool.closeAll(); }
});
