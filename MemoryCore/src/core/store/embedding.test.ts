import { afterEach, beforeAll, afterAll, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIEmbeddingService } from "./embedding.js";
import { parseConfig } from "../../config.js";
import { loadGatewayConfig } from "../../gateway/config.js";

const config = { provider: "openai", apiKey: "test-only", model: "fixture", dimensions: 3 };
let root: string;
let status = 200;
let response: unknown;
const requests: { url: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ url: req.url!, body: JSON.parse(body), headers: req.headers });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
afterEach(() => { requests.length = 0; status = 200; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const vectorResponse = () => ({ data: [{ index: 0, embedding: [1, 0, 0] }] });

it("uses full endpoint unchanged, including custom path, query, slash, and precedence", async () => {
  response = vectorResponse();
  const endpoint = `${root}/custom/prefix/embeddings/multimodal/?api-version=2026-01&x=a%2Fb`;
  const service = new OpenAIEmbeddingService({ ...config, endpoint, baseUrl: "https://unused.invalid/v1" });
  expect([...await service.embed("memory")]).toEqual([1, 0, 0]);
  expect(requests[0].url).toBe("/custom/prefix/embeddings/multimodal/?api-version=2026-01&x=a%2Fb");
  expect(requests[0].body).toEqual({ input: ["memory"], model: "fixture", dimensions: 3 });
  expect(requests[0].headers.authorization).toBe("Bearer test-only");
});
it("keeps legacy baseUrl and sorts OpenAI batch indices", async () => {
  response = { data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] };
  const service = new OpenAIEmbeddingService({ ...config, baseUrl: `${root}/v1///`, sendDimensions: false });
  expect((await service.embedBatch(["one", "two"])).map(v => [...v])).toEqual([[1, 0, 0], [0, 1, 0]]);
  expect(requests[0].url).toBe("/v1/embeddings");
  expect(requests[0].body).not.toHaveProperty("dimensions");
});
it("Ark embeds independent texts separately and reads data.embedding", async () => {
  response = { data: { embedding: [0, 3, 4], object: "embedding" } };
  const service = new OpenAIEmbeddingService({ ...config, endpoint: `${root}/api/v3/embeddings/multimodal`, format: "ark-multimodal", sendDimensions: false });
  const vectors = await service.embedBatch(["one", "two"]);
  expect(vectors).toHaveLength(2);
  expect(vectors[0][1]).toBeCloseTo(0.6);
  expect(requests.map(r => r.body)).toEqual(["one", "two"].map(text => ({ model: "fixture", encoding_format: "float", input: [{ type: "text", text }] })));
  expect(requests.map(r => r.url)).toEqual(Array(2).fill("/api/v3/embeddings/multimodal"));
  expect(service.getProviderInfo().provider).toBe("openai:ark-multimodal");
  expect(await service.embedBatch([])).toEqual([]);
  expect(requests).toHaveLength(2);
});
it("supports explicit dimensions and truncation for Ark", async () => {
  response = { data: { embedding: [1, 0, 0] } };
  await new OpenAIEmbeddingService({ ...config, endpoint: root, format: "ark-multimodal", maxInputChars: 3 }).embed("abcdef");
  expect(requests[0].body.input).toEqual([{ type: "text", text: "abc" }]);
  expect(requests[0].body.dimensions).toBe(3);
});
it("qclaw forwards the exact endpoint without logging URLs", async () => {
  response = vectorResponse();
  const debug = vi.fn();
  const endpoint = "https://example.invalid/prefix/embed?secret=private";
  await new OpenAIEmbeddingService({ ...config, provider: "qclaw", endpoint, proxyUrl: root }, { debug } as any).embed("one");
  expect(requests[0].headers["remote-url"]).toBe(endpoint);
  expect(JSON.stringify(debug.mock.calls)).not.toContain("private");
});
it.each([
  [{ data: [] }, "count"],
  [{ data: [{ index: 1, embedding: [1, 0, 0] }] }, "indices"],
  [{ data: [{ index: 0, embedding: [1, 0] }] }, "dimension"],
  [{ data: [{ index: 0, embedding: [1, "0", 0] }] }, "values"],
  [{ data: [{ index: 0, embedding: [1e300, 0, 0] }] }, "values"],
])("rejects malformed OpenAI output without retries: %j", async (value, message) => {
  response = value;
  await expect(new OpenAIEmbeddingService({ ...config, endpoint: root }).embed("private text")).rejects.toThrow(message);
  expect(requests).toHaveLength(1);
});
it.each([{ data: [{ embedding: [1, 0, 0] }] }, { data: { embedding: [1, 0] } }])("rejects malformed Ark responses", async value => {
  response = value;
  await expect(new OpenAIEmbeddingService({ ...config, endpoint: root, format: "ark-multimodal" }).embed("one")).rejects.toThrow(/Ark|dimension/);
  expect(requests).toHaveLength(1);
});
it("does not retry 4xx or expose response text", async () => {
  status = 401; response = { error: "test-only private memory signed-url" };
  await expect(new OpenAIEmbeddingService({ ...config, endpoint: root }).embed("private memory")).rejects.toThrow(/^Embedding API error: HTTP 401$/);
  expect(requests).toHaveLength(1);
});
it.each([429, 503])("preserves no automatic retry policy for HTTP %s", async status => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("private", { status }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(new OpenAIEmbeddingService({ ...config, endpoint: root }).embed("one")).rejects.toThrow(`HTTP ${status}`);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("redacts network errors without retrying", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error("key=test-only&text=private"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(new OpenAIEmbeddingService({ ...config, endpoint: root }).embed("one")).rejects.toThrow(/^Embedding API request failed$/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("honors per-call timeout without retries", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("private", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetchMock);
  const check = expect(new OpenAIEmbeddingService({ ...config, endpoint: root, timeoutMs: 10000 }).embed("one", { timeoutMs: 5 })).rejects.toThrow(/^Embedding API request timed out$/);
  await vi.advanceTimersByTimeAsync(5); await check;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([0, 1.5, Infinity, NaN])("rejects invalid dimensions %s", dimensions => {
  expect(() => new OpenAIEmbeddingService({ ...config, endpoint: root, dimensions })).toThrow("positive integer");
});
it("config accepts endpoint-only and validates format and dimensions", () => {
  const parsed = parseConfig({ embedding: { ...config, endpoint: root, format: "ark-multimodal" } });
  expect(parsed.embedding.enabled).toBe(true);
  expect(parsed.embedding.endpoint).toBe(root);
  expect(parsed.embedding.format).toBe("ark-multimodal");
  expect(parseConfig({ embedding: { ...config, endpoint: root, format: "typo" } }).embedding.enabled).toBe(false);
  expect(parseConfig({ embedding: { ...config, endpoint: root, dimensions: 1.5 } }).embedding.enabled).toBe(false);
  expect(parseConfig({ embedding: config }).embedding.configError).toContain("endpoint or baseUrl");
});
it.each([false, true])("gateway loads endpoint-only configuration with top-level=%s", topLevel => {
  const dir = mkdtempSync(join(tmpdir(), "embedding-config-"));
  const file = join(dir, "config.yaml");
  vi.stubEnv("TDAI_GATEWAY_CONFIG", file);
  vi.stubEnv("EMBEDDING_TEST_ENDPOINT", `${root}/api/v3/embeddings/multimodal?version=1`);
  try {
    writeFileSync(file, `${topLevel ? "" : "memory:\n"}${topLevel ? "" : "  "}embedding:\n${["provider: openai", 'endpoint: "${EMBEDDING_TEST_ENDPOINT}"', "format: ark-multimodal", "apiKey: test-only", "model: fixture", "dimensions: 3"].map(s => `${topLevel ? "  " : "    "}${s}`).join("\n")}\n`);
    const parsed = loadGatewayConfig().memory.embedding;
    expect(parsed.enabled).toBe(true);
    expect(parsed.endpoint).toBe(`${root}/api/v3/embeddings/multimodal?version=1`);
    expect(parsed.format).toBe("ark-multimodal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("redacts malformed JSON and does not retry", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("private key/test-only is not JSON"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(new OpenAIEmbeddingService({ ...config, endpoint: root }).embed("one")).rejects.toThrow(/^Embedding API returned invalid JSON$/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each(["file:///tmp/test", "https://user:secret@example.invalid/embed", "https://example.invalid/embed#fragment", "not a URL"])("rejects invalid endpoint without leaking it", endpoint => {
  expect(() => new OpenAIEmbeddingService({ ...config, endpoint })).toThrow(/invalid endpoint URL|HTTP\(S\) URL/);
});
