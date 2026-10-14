import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StandaloneLLMRunner,
  StandaloneLLMRunnerFactory,
} from "../../adapters/standalone/llm-runner.js";
import { loadGatewayConfig } from "../../gateway/config.js";
import { parseConfig } from "../../config.js";
import { parseOAuthConfig } from "./runtime.js";
import { resolveStandaloneLlmForRuntime } from "../../adapters/standalone/llm-provider-resolver.js";
import { OAuthFailure } from "./types.js";
const mock = vi.hoisted(() => ({ complete: vi.fn(), accessToken: vi.fn() }));
vi.mock("./runtime.js", async (original) => ({
  ...(await original<typeof import("./runtime.js")>()),
  createOAuthRuntime: () => ({
    service: { accessToken: mock.accessToken },
    inference: { complete: mock.complete },
  }),
}));
afterEach(() => vi.unstubAllEnvs());
describe("OAuth runner integration", () => {
  it("selects OAuth without API key for plain L1 output and never falls back on error", async () => {
    mock.accessToken.mockResolvedValue("access");
    mock.complete.mockResolvedValue({
      text: "memory",
      output: [],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    const runner = new StandaloneLLMRunner({
      config: {
        provider: "oauth",
        baseUrl: "https://unused.invalid",
        apiKey: "",
        model: "model",
      },
    });
    expect(await runner.run({ prompt: "extract", taskId: "l1" })).toBe(
      "memory",
    );
    expect(runner.lastUsage?.totalTokens).toBe(3);
    mock.complete.mockRejectedValue(new OAuthFailure("quota_limited"));
    await expect(
      runner.run({ prompt: "extract", taskId: "l1" }),
    ).rejects.toMatchObject({ code: "quota_limited" });
    expect(runner.lastUsage).toBeUndefined();
  });
  it("keeps L2/L3 storage-backed tools and model override", async () => {
    mock.accessToken.mockResolvedValue("access");
    let n = 0;
    mock.complete.mockImplementation(async (_token, request) => {
      expect(request.model).toBe("scene-model");
      expect(request.tools[0].type).toBe("namespace");
      return ++n === 1
        ? {
            text: "",
            output: [
              {
                type: "function_call",
                call_id: "write1",
                name: "write",
                namespace: "memory",
                arguments: '{"path":"profile.md","content":"persona"}',
              },
            ],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }
        : {
            text: "saved",
            output: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
    });
    const writeFile = vi.fn(async () => {});
    const runner = new StandaloneLLMRunnerFactory({
      config: { provider: "oauth", baseUrl: "", apiKey: "", model: "default" },
    }).createRunner({ modelRef: "openai/scene-model", enableTools: true });
    expect(
      await runner.run({
        prompt: "update",
        taskId: "l3",
        storage: { writeFile } as any,
        storagePrefix: "persona/",
      }),
    ).toBe("saved");
    expect(writeFile).toHaveBeenCalledWith("persona/profile.md", "persona");
  });
  it("blocks a dangling symlink write outside the local L2/L3 workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "oauth-sandbox-")),
      outside = mkdtempSync(join(tmpdir(), "oauth-outside-"));
    const target = join(outside, "new-file");
    symlinkSync(target, join(root, "link"));
    let n = 0;
    mock.accessToken.mockResolvedValue("access");
    mock.complete.mockImplementation(async (_token, request) => {
      if (++n === 1)
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "linkwrite",
              name: "write",
              arguments: '{"path":"link","content":"escape"}',
            },
          ],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      expect(request.input.at(-1).output).toContain(
        "escapes workspace boundary",
      );
      return {
        text: "blocked",
        output: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });
    try {
      const runner = new StandaloneLLMRunner({
        config: { provider: "oauth", baseUrl: "", apiKey: "", model: "model" },
        enableTools: true,
      });
      expect(
        await runner.run({ prompt: "x", taskId: "l3", workspaceDir: root }),
      ).toBe("blocked");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("splices top-level OAuth into the memory and skill runner configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
    mkdirSync(join(dir, "config"));
    writeFileSync(
      join(dir, "config/db.toml"),
      '[postgres]\nurl="postgresql://user@localhost/agentmemory"',
    );
    writeFileSync(
      join(dir, "gateway.yaml"),
      "llm:\n  provider: oauth\n  model: selected\n  oauth:\n    account: owner\n    vaultId: host-one\n",
    );
    vi.stubEnv("AGENTMEMORY_DB_CONFIG", join(dir, "config/db.toml"));
    vi.stubEnv("TDAI_GATEWAY_CONFIG", join(dir, "gateway.yaml"));
    for (const key of [
      "DATABASE_URL",
      "TDAI_POSTGRES_URL",
      "TDAI_METADATA_POSTGRES_URL",
      "TDAI_LLM_PROVIDER",
      "TDAI_LLM_API_KEY",
      "TDAI_LLM_MODEL",
      "STORE_MODE",
      "AGENTMEMORY_DB_OVERRIDE",
    ])
      vi.stubEnv(key, undefined);
    try {
      const config = loadGatewayConfig();
      expect(config.llm.provider).toBe("oauth");
      expect(config.memory.llm.enabled).toBe(true);
      expect(config.memory.llm.oauth?.account).toBe("owner");
      expect(
        resolveStandaloneLlmForRuntime(config.memory.llm, "instance").oauth
          ?.vaultId,
      ).toBe("host-one");
      expect(
        parseConfig({
          llm: {
            enabled: true,
            provider: "oauth",
            model: "selected",
            oauth: { account: "owner" },
          },
        }).llm.oauth?.account,
      ).toBe("owner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects unknown providers rather than silently selecting paid API auth", () => {
    expect(() => parseConfig({ llm: { provider: "oahtu" } })).toThrow(
      "Unknown LLM provider",
    );
  });
  it("validates account labels and keeps key values out of config", () => {
    expect(parseOAuthConfig({ account: "owner" })).toMatchObject({
      account: "owner",
      encryptionKeyEnv: "AGENTMEMORY_OAUTH_KEY",
    });
    expect(() => parseOAuthConfig({ account: "../other" })).toThrow(
      OAuthFailure,
    );
  });
});
