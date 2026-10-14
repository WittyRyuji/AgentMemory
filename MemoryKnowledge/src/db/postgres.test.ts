import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestPool } from "./__tests__/test-pool.js";
import { createDb, migrate, type Db } from "./client.js";
import { PostgresKnowledgeStore } from "../store/postgres-store.js";
import { createCredentialStore } from "../source-auth/credential-store.js";
import { createLlmBindingStore } from "../store/llm-binding-store.js";
import { PostgresArtifactStore } from "./artifact-store.js";
import { WikiService } from "../store/wiki-service.js";
import { createWikiSourceManager } from "../engines/wiki/manager.js";
import {
  withWriteDb,
  upsertSource,
  listSources,
  getReadDb,
  recordSourceIngestResult,
} from "../engines/wiki/index-db.js";
import { Hono } from "hono";
import { accessLog } from "../middleware/response-envelope.js";
import { createWikiRoutes } from "../routes/wiki.js";
import { createLlmBindingRoutes } from "../routes/llm-binding.js";

const pool = new TestPool();
let db: Db;
let store: PostgresKnowledgeStore;
const root = mkdtempSync(join(tmpdir(), "knowledge-pg-"));
beforeAll(async () => {
  ({ db } = await createDb({ connectionString: "postgres://test", pool }));
  store = new PostgresKnowledgeStore(db);
}, 30_000);
afterAll(async () => {
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL knowledge stores", () => {
  it("migrates idempotently and retains metadata, audit ordering and tenant boundaries", async () => {
    const first = await store.createWiki({
      service_id: "tenant-a",
      team_id: "team",
      name: "wiki",
    });
    expect(first.row.status).toBe("draft");
    expect(
      (
        await store.createWiki({
          service_id: "tenant-a",
          team_id: "team",
          name: "wiki",
        })
      ).existed,
    ).toBe(true);
    const other = await store.createWiki({
      service_id: "tenant-b",
      team_id: "team",
      name: "wiki",
    });
    expect(other.row.wiki_id).not.toBe(first.row.wiki_id);
    expect(await store.getWikiById("tenant-b", first.row.wiki_id)).toBeNull();
    expect(await store.deleteWiki("tenant-b", "team", first.row.wiki_id)).toBe(
      false,
    );
    await store.updateWikiStatus("tenant-b", first.row.wiki_id, {
      status: "failed",
    });
    expect(
      (await store.getWikiById("tenant-a", first.row.wiki_id))?.status,
    ).toBe("draft");
    await store.appendWikiAudit({
      service_id: "tenant-a",
      asset_id: first.row.wiki_id,
      version: 1,
      action: "create",
    });
    await store.appendWikiAudit({
      service_id: "tenant-a",
      asset_id: first.row.wiki_id,
      version: 2,
      action: "ready",
    });
    expect(
      (await store.listWikiAudit("tenant-a", first.row.wiki_id)).map(
        (r) => r.version,
      ),
    ).toEqual([2, 1]);
    expect(await store.listWikiAudit("tenant-b", first.row.wiki_id)).toEqual(
      [],
    );
    await migrate(db, pool);
    expect(await store.countWikis("tenant-a", "team")).toBe(1);
  });
  it("handles competing idempotent creates and interrupted builds", async () => {
    const input = {
      service_id: "tenant-a",
      team_id: "team",
      repo_url: "https://example.invalid/repo",
      branch: "main",
    };
    const results = await Promise.all([
      store.createCodeGraph(input),
      store.createCodeGraph(input),
    ]);
    expect(new Set(results.map((r) => r.row.code_graph_id)).size).toBe(1);
    expect(results.filter((r) => !r.existed)).toHaveLength(1);
    expect(await store.markInterruptedAsFailed()).toBe(1);
    expect(
      (await store.getCodeGraphById("tenant-a", results[0].row.code_graph_id))
        ?.status,
    ).toBe("failed");
  });
  it("preserves credential isolation, verification and binding key omission semantics", async () => {
    const creds = createCredentialStore({ db });
    const ref = {
      type: "wiki" as const,
      serviceId: "tenant-a",
      resourceId: "credential-fixture",
    };
    await creds.put(
      ref,
      { kind: "bearer", secret: "test-only-token" },
      "provider",
    );
    expect((await creds.get(ref))?.secret).toBe("test-only-token");
    expect(await creds.get({ ...ref, serviceId: "tenant-b" })).toBeNull();
    await creds.recordVerify(ref);
    expect((await creds.status(ref))?.last_verified_at).toBeTruthy();
    expect(JSON.stringify(await creds.status(ref))).not.toContain(
      "test-only-token",
    );
    const binding = createLlmBindingStore(db);
    await binding.upsert("tenant-a", {
      mode: "byo",
      base_url: "https://example.invalid",
      api_key: "test-key",
    });
    await binding.upsert("tenant-a", {
      mode: "byo",
      base_url: "https://example.invalid/updated",
    });
    expect((await binding.get("tenant-a"))?.api_key).toBe("test-key");
    await binding.upsert("tenant-a", { mode: "byo", api_key: null });
    expect((await binding.get("tenant-a"))?.api_key).toBeNull();
  });
});

describe("durable wiki content, search and API parity", () => {
  it("restores raw/pages/import map from PG after deleting every working-cache file", async () => {
    const data = join(root, "durability");
    const artifacts = new PostgresArtifactStore(pool, data);
    const service = new WikiService({
      store,
      dataRoot: data,
      artifactStore: artifacts,
      worker: async () => ({ pageCount: 0 }),
    });
    const { row } = await service.create({
      service_id: "durable",
      team_id: "team",
      name: "Restart",
    });
    const args = [row.service_id, row.team_id, row.wiki_id] as const;
    await service.rawWrite(
      ...args,
      "source.md",
      "# 原文\n数据库与缓存",
      "author",
    );
    await service.pageWrite(
      ...args,
      "concepts/database",
      "---\ntitle: 数据库\ntype: concept\n---\nPostgreSQL caching [[cache]]",
    );
    await service.writeImportNameMap(...args, "provider", {
      "external-id": "source.md",
    });
    const initialSources = await service.rawLs(...args);
    rmSync(data, { recursive: true, force: true });
    const restartedArtifacts = new PostgresArtifactStore(pool, data);
    await restartedArtifacts.restoreAll();
    expect(await service.rawRead(...args, "source.md")).toContain("数据库");
    expect(await service.pageRead(...args, "concepts/database")).toContain(
      "locked: true",
    );
    expect(service.readImportNameMap(...args, "provider")).toEqual({
      "external-id": "source.md",
    });
    expect(await service.rawLs(...args)).toEqual(initialSources);
    expect(existsSync(join(service.dirFor(...args), "index.db"))).toBe(false);
    await service.delete(...args);
    await restartedArtifacts.restoreAll();
    expect(existsSync(service.dirFor(...args))).toBe(false);
    expect(
      await listSources(getReadDb(row.wiki_id, service.dirFor(...args))),
    ).toEqual([]);
  });
  it("keeps source state and file checkpoint in one rollback boundary", async () => {
    const data = join(root, "rollback"),
      artifacts = new PostgresArtifactStore(pool, data);
    const service = new WikiService({
      store,
      dataRoot: data,
      artifactStore: artifacts,
      worker: async () => ({}),
    });
    const { row } = await service.create({
      service_id: "rollback",
      team_id: "t",
      name: "rollback",
    });
    const dir = service.dirFor(row.service_id, row.team_id, row.wiki_id);
    await service.rawWrite(
      row.service_id,
      row.team_id,
      row.wiki_id,
      "source.md",
      "v1",
    );
    await expect(
      withWriteDb(dir, async (index) => {
        await upsertSource(index, {
          filename: "not-committed.md",
          sha256: "bad",
          size: 3,
        });
        writeFileSync(join(dir, "raw/sources/source.md"), "uncommitted");
        await artifacts.checkpoint(dir, index);
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");
    rmSync(data, { recursive: true, force: true });
    await artifacts.restoreAll();
    expect(readFileSync(join(dir, "raw/sources/source.md"), "utf8")).toBe("v1");
    expect(
      (await listSources(getReadDb(row.wiki_id, dir))).map((r) => r.filename),
    ).toEqual(["source.md"]);
  });
  it("preserves incremental source timestamps and does not skip changed content", async () => {
    const dir = join(root, "tenant", "team", "wiki-source-test");
    await withWriteDb(dir, async (index) => {
      await upsertSource(index, {
        filename: "a.md",
        sha256: "one",
        size: 1,
        userId: "u",
      });
    });
    const read = () => listSources(getReadDb("wiki-source-test", dir));
    const created = (await read())[0];
    await withWriteDb(dir, async (index) => {
      await recordSourceIngestResult(index, {
        filename: "a.md",
        sha256: "one",
        size: 1,
        ok: true,
      });
    });
    expect((await read())[0]).toMatchObject({
      status: "ingested",
      created_at: created.created_at,
      updated_at: created.updated_at,
    });
    await withWriteDb(dir, async (index) => {
      expect(
        await upsertSource(index, { filename: "a.md", sha256: "one", size: 1 }),
      ).toBe("unchanged");
    });
    expect((await read())[0].status).toBe("ingested");
    await withWriteDb(dir, async (index) => {
      expect(
        await upsertSource(index, { filename: "a.md", sha256: "two", size: 2 }),
      ).toBe("updated");
    });
    expect((await read())[0]).toMatchObject({
      status: "uploaded",
      sha256: "two",
      created_at: created.created_at,
    });
  });
  it("supports Chinese/prefix search, title boost, graph expansion and tenant isolation", async () => {
    const data = join(root, "search");
    const dir = join(data, "tenant", "team", "wiki-search");
    mkdirSync(join(dir, "wiki/concepts"), { recursive: true });
    writeFileSync(
      join(dir, "wiki/concepts/database.md"),
      "---\ntitle: 数据库 PostgreSQL\ntype: concept\n---\n索引 数据库检索 [[cache]]",
    );
    writeFileSync(
      join(dir, "wiki/concepts/cache.md"),
      "---\ntitle: Cache\ntype: concept\n---\n高速缓存 linked from database",
    );
    writeFileSync(
      join(dir, "wiki/concepts/body.md"),
      "---\ntitle: Storage\ntype: concept\n---\nPostgreSQL content mention",
    );
    const mgr = await createWikiSourceManager(join(data, "_engines"));
    await mgr.register({ name: "wiki-search", path: dir });
    const chinese = await mgr.search("wiki-search", "数据库", 10);
    expect(chinese.results[0].title).toContain("数据库");
    const prefix = await mgr.search("wiki-search", "postgre", 10);
    expect(prefix.results.map((r) => r.title)).toEqual([
      "数据库 PostgreSQL",
      "Storage",
    ]);
    const expanded = await mgr.search("wiki-search", "数据库", 10, {
      hop: 1,
      minScore: 0,
    });
    expect(
      expanded.results.some((r) => r.title === "Cache" && r.hop === 1),
    ).toBe(true);
    expect((await mgr.graph("wiki-search")).edges.length).toBe(1);
    expect(
      await listSources(
        getReadDb("wiki-search", join(data, "foreign", "team", "wiki-search")),
      ),
    ).toEqual([]);
    const foreign = await pool.query(
      "SELECT count(*)::int AS n FROM knowledge_wiki_page WHERE wiki_key=$1",
      [JSON.stringify(["foreign", "team", "wiki-search"])],
    );
    expect(foreign.rows[0].n).toBe(0);
  });
  it("keeps HTTP create/list/read and binding responses resolved and secret-free", async () => {
    const data = join(root, "http"),
      artifacts = new PostgresArtifactStore(pool, data);
    const service = new WikiService({
      store,
      dataRoot: data,
      artifactStore: artifacts,
      worker: async () => ({}),
    });
    const mgr = await createWikiSourceManager(join(data, "_engines"), {
      artifactStore: artifacts,
    });
    const app = new Hono();
    app.use("*", accessLog());
    app.route(
      "/wiki",
      createWikiRoutes({ wikiService: service, wikiMgr: mgr }),
    );
    app.route(
      "/binding",
      createLlmBindingRoutes({ llmBindingStore: createLlmBindingStore(db) }),
    );
    const request = async (path: string, body: unknown) =>
      await app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "http",
        },
        body: JSON.stringify(body),
      });
    const created = await request("/wiki/create", {
      team_id: "team",
      name: "HTTP Wiki",
    });
    expect(created.status).toBe(201);
    const json = (await created.json()) as any;
    expect(json.data.wiki_id).toMatch(/^wiki-/);
    const id = json.data.wiki_id;
    const read = await request("/wiki/get", { wiki_id: id });
    expect(((await read.json()) as any).data.name).toBe("HTTP Wiki");
    const set = await request("/binding/set", {
      mode: "byo",
      base_url: "https://example.invalid",
      api_key: "test-secret",
    });
    expect(set.status).toBe(200);
    expect(await set.text()).not.toContain("test-secret");
  });
  it("restores SSH-mode artifacts with private permissions and rejects path escapes", async () => {
    const data = join(root, "ssh"),
      dir = join(data, "tenant");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "id_rsa_test"), "test-key-material", {
      mode: 0o600,
    });
    const artifacts = new PostgresArtifactStore(pool, data, "ssh-test");
    await artifacts.checkpoint(dir);
    rmSync(data, { recursive: true, force: true });
    await artifacts.restoreAll();
    expect(statSync(join(dir, "id_rsa_test")).mode & 0o777).toBe(0o600);
    expect(() => artifacts.scopeFor(join(data, "..", "outside"))).toThrow(
      "Invalid artifact path",
    );
  });
});

it("serializes concurrent ingest admission and safely handles delete during processing", async () => {
  const data = join(root, "concurrency"),
    artifacts = new PostgresArtifactStore(pool, data);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new WikiService({
    store,
    dataRoot: data,
    artifactStore: artifacts,
    worker: async () => {
      enter();
      await pending;
      return { pageCount: 0 };
    },
  });
  const { row } = await service.create({
    service_id: "race",
    team_id: "team",
    name: "race",
  });
  const args = [row.service_id, row.team_id, row.wiki_id] as const;
  const results = await Promise.all([
    service.ingest(...args),
    service.ingest(...args),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["busy", "ok"]);
  await entered;
  expect(await service.delete(...args)).toBe(true);
  finish();
  await service.onIdle();
  expect(await service.getById(row.service_id, row.wiki_id)).toBeNull();
  await artifacts.restoreAll();
  expect(existsSync(service.dirFor(...args))).toBe(false);
});

it("ignores stale ingest completion when raw source content changed meanwhile", async () => {
  const dir = join(root, "stale", "team", "wiki-stale");
  await withWriteDb(dir, async (index) => {
    await upsertSource(index, {
      filename: "changed.md",
      sha256: "old",
      size: 1,
    });
    await upsertSource(index, {
      filename: "changed.md",
      sha256: "new",
      size: 2,
    });
    await recordSourceIngestResult(index, {
      filename: "changed.md",
      sha256: "old",
      size: 1,
      ok: true,
    });
  });
  expect((await listSources(getReadDb("wiki-stale", dir)))[0]).toMatchObject({
    sha256: "new",
    status: "uploaded",
    ingested_at: null,
  });
});

it("rebuilds the actual upstream codegraph from PG after removing its SQLite cache", async () => {
  const { indexProject, closeIndex, getStats, executeTool } =
    await import("../engines/code/bridge.js");
  const data = join(root, "code-recovery"),
    artifacts = new PostgresArtifactStore(pool, data);
  const { row } = await store.createCodeGraph({
    service_id: "code",
    team_id: "team",
    repo_url: "https://example.invalid/code",
    branch: "main",
  });
  const dir = join(data, row.service_id, row.team_id, row.code_graph_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sample.ts"),
    'export function hello(name: string) { return `Hello ${name}`; }\nexport function greet() { return hello("world"); }\n',
  );
  writeFileSync(join(dir, "codegraph.json"), "{}");
  const first = await indexProject(dir);
  expect(getStats(first).fileCount).toBeGreaterThan(0);
  closeIndex(first);
  await artifacts.checkpoint(dir);
  rmSync(data, { recursive: true, force: true });
  await artifacts.restoreAll();
  expect(existsSync(join(dir, ".codegraph"))).toBe(false);
  expect(readFileSync(join(dir, "codegraph.json"), "utf8")).toBe("{}");
  const rebuilt = await indexProject(dir);
  try {
    const result = await executeTool(rebuilt, "codegraph_search", {
      query: "hello",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("hello");
    expect(result.text).toContain("sample.ts");
  } finally {
    closeIndex(rebuilt);
  }
}, 30_000);

it("assembles the existing Knowledge module and restores a ready wiki before use", async () => {
  const { createKnowledgeModule } = await import("../module.js");
  const data = join(root, "module-startup"),
    artifacts = new PostgresArtifactStore(pool, data);
  const service = new WikiService({
    store,
    dataRoot: data,
    artifactStore: artifacts,
    worker: async () => ({}),
  });
  const { row } = await service.create({
    service_id: "module",
    team_id: "team",
    name: "Module",
  });
  await service.pageWrite(
    row.service_id,
    row.team_id,
    row.wiki_id,
    "concepts/recovery",
    "---\ntitle: Recovery\ntype: concept\n---\nrestart recovery",
  );
  await store.updateWikiStatus(row.service_id, row.wiki_id, {
    status: "ready",
  });
  rmSync(data, { recursive: true, force: true });
  await artifacts.restoreAll();
  const module = await createKnowledgeModule({
    dataDir: data,
    db,
    artifactStore: artifacts,
    llmConfig: {
      mode: "custom",
      protocol: "openai",
      provider: "custom",
      model: "test",
      apiKey: "",
      baseUrl: "",
      maxTokens: 1000,
      timeoutMs: 1000,
    },
  });
  try {
    expect(
      module.wikiMgr.getPages(row.wiki_id).some((p) => p.title === "Recovery"),
    ).toBe(true);
    expect(
      (await module.wikiMgr.search(row.wiki_id, "recov")).results.some(
        (r) => r.title === "Recovery",
      ),
    ).toBe(true);
    expect(
      (await module.wikiService.getById(row.service_id, row.wiki_id))?.status,
    ).toBe("ready");
  } finally {
    module.autoSyncScheduler.stop();
    await module.wikiService.onIdle();
    await module.cgService.onIdle();
  }
});

it("keeps the previous durable code source when a failed sync empties its working tree", async () => {
  const { CodeGraphService } = await import("../store/code-graph-service.js");
  const data = join(root, "failed-code-sync"),
    artifacts = new PostgresArtifactStore(pool, data);
  const { row } = await store.createCodeGraph({
    service_id: "failed-code",
    team_id: "t",
    repo_url: "https://example.invalid/fail",
    branch: "main",
  });
  const dir = join(data, row.service_id, row.team_id, row.code_graph_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.ts"), "export const preserved = true;");
  await artifacts.checkpoint(dir);
  await store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
    status: "ready",
  });
  const service = new CodeGraphService({
    store,
    dataRoot: data,
    artifactStore: artifacts,
    worker: async ({ dir }) => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      throw new Error("remote unavailable");
    },
  });
  expect(
    (await service.sync(row.service_id, row.team_id, row.code_graph_id)).kind,
  ).toBe("ok");
  await service.onIdle();
  expect(
    (await store.getCodeGraphById(row.service_id, row.code_graph_id))?.status,
  ).toBe("failed");
  await artifacts.restoreAll();
  expect(readFileSync(join(dir, "source.ts"), "utf8")).toContain("preserved");
});
