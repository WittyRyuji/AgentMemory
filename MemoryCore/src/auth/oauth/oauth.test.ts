import { validateSeedOAuthOverride } from "./config-policy.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { jsonSchema, tool } from "ai";
import { CredentialCipher } from "./crypto.js";
import {
  OAuthFailure,
  type OAuthCredential,
  type OAuthAuthAdapter,
  type LoginAttempt,
} from "./types.js";
import { OpenAIAuthAdapter, PLAN_SCOPE } from "./openai.js";
import { OpenAIResponsesAdapter } from "./responses.js";
import { OAuthService, type OAuthVault } from "./service.js";
import {
  PostgresOAuthVault,
  type ConnectionRecord,
  type LockedConnection,
} from "./vault.js";
import { OAuthProviderRegistry } from "./registry.js";
import { runOAuth } from "./runner.js";
import { TestPostgresPool } from "../../core/store/postgres/test-pool.js";
import {
  PostgresDatabase,
  instanceSchema,
} from "../../core/store/postgres/client.js";
const KEY = Buffer.alloc(32, 9).toString("base64");
const credential = (
  overrides: Partial<OAuthCredential> = {},
): OAuthCredential => ({
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  idToken: "id-secret",
  expiresAt: Date.now() + 3_600_000,
  scopes: [PLAN_SCOPE, "resource.invoke"],
  subject: "subject",
  ...overrides,
});
function memoryVault() {
  let record: ConnectionRecord | undefined, attempt: LoginAttempt | undefined;
  let queue = Promise.resolve();
  const vault: OAuthVault = {
    withLock: async <T>(
      _p: string,
      _l: string,
      fn: (slot: LockedConnection) => Promise<T>,
    ) => {
      const previous = queue;
      let unlock!: () => void;
      queue = new Promise<void>((r) => (unlock = r));
      await previous;
      try {
        return await fn({
          read: async () => record,
          write: async (r) => {
            record = structuredClone(r);
          },
          pending: async (a) => {
            attempt = a;
          },
          clearPending: async () => {
            attempt = undefined;
          },
          consume: async (state) => {
            if (
              !attempt ||
              attempt.state !== state ||
              attempt.expiresAt < Date.now()
            )
              throw new OAuthFailure("invalid_callback");
            const a = attempt;
            attempt = undefined;
            return a;
          },
        });
      } finally {
        unlock();
      }
    },
  };
  return {
    vault,
    seed: (r: ConnectionRecord) => (record = r),
    record: () => record,
    attempt: () => attempt,
  };
}
function adapter(): OAuthAuthAdapter {
  return {
    id: "openai",
    initialClientId: "dynamic_agent_client",
    inferenceScopes: [PLAN_SCOPE, "resource.invoke"],
    authorizationUrl: new OpenAIAuthAdapter().authorizationUrl,
    exchange: vi.fn(async () => credential()),
    refresh: vi.fn(async () =>
      credential({ accessToken: "new-access", refreshToken: "new-refresh" }),
    ),
    revoke: vi.fn(async () => {}),
  };
}
const ready = (c = credential()): ConnectionRecord => ({
  hostId: "host",
  clientId: "oaiapp_test",
  subject: "subject",
  credential: c,
  status: "ready",
});
const callback = (state: string, extra = "") =>
  `http://127.0.0.1:1455/auth/callback?code=code&state=${state}&client_id=oaiapp_test${extra}`;

describe("encrypted vault envelope", () => {
  it("encrypts with random nonces and authenticates record context", () => {
    const c = new CredentialCipher(KEY),
      a = c.seal(credential(), "openai:a"),
      b = c.seal(credential(), "openai:a");
    expect(a).not.toContain("secret");
    expect(a).not.toBe(b);
    expect(c.open(a, "openai:a")).toEqual(
      expect.objectContaining({ accessToken: "access-secret" }),
    );
    expect(() => c.open(a, "openai:b")).toThrow(OAuthFailure);
    expect(() => c.open(a.slice(0, -5), "openai:a")).toThrow(OAuthFailure);
  });
  it("rejects weak or malformed encryption keys", () => {
    for (const k of ["", Buffer.alloc(16).toString("base64"), KEY + "!"])
      expect(() => new CredentialCipher(k)).toThrow(OAuthFailure);
  });
});
describe("owner authorization lifecycle", () => {
  it("uses independent dynamic registration, PKCE S256, state, nonce and plan scopes", async () => {
    const m = memoryVault(),
      s = new OAuthService(m.vault, adapter(), "default");
    const u = new URL(await s.begin("http://127.0.0.1:1455/auth/callback"));
    expect(u.origin).toBe("https://auth.openai.com");
    expect(u.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toContain(PLAN_SCOPE);
    expect(u.searchParams.get("agent_name_hint")).toBe("AgentMemory");
    expect(m.attempt()?.verifier).not.toBe(
      u.searchParams.get("code_challenge"),
    );
    expect(m.record()?.hostId).toMatch(/^urn:uuid:/);
    expect(u.toString()).not.toContain("id_token_hint");
  });
  it.each([
    "http://localhost:1455/auth/callback",
    "https://127.0.0.1/auth/callback",
    "http://example.com/auth/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1/auth/callback?q=1",
  ])("rejects non-loopback callback %s", async (uri) => {
    await expect(
      new OAuthService(memoryVault().vault, adapter(), "default").begin(uri),
    ).rejects.toMatchObject({ code: "configuration_error" });
  });
  it("consumes callback once and stores validated registration", async () => {
    const m = memoryVault(),
      a = adapter(),
      s = new OAuthService(m.vault, a, "default");
    await s.begin("http://127.0.0.1:1455/auth/callback");
    const state = m.attempt()!.state;
    await s.callback(callback(state));
    expect(await s.accessToken()).toBe("access-secret");
    await expect(s.callback(callback(state))).rejects.toMatchObject({
      code: "invalid_callback",
    });
    expect(a.exchange).toHaveBeenCalledTimes(1);
  });
  it("rejects state mismatch and duplicate callback parameters before exchange", async () => {
    const m = memoryVault(),
      a = adapter(),
      s = new OAuthService(m.vault, a, "default");
    await s.begin("http://127.0.0.1:1455/auth/callback");
    await expect(s.callback(callback("wrong"))).rejects.toMatchObject({
      code: "invalid_callback",
    });
    await expect(
      s.callback(callback(m.attempt()!.state, "&state=duplicate")),
    ).rejects.toMatchObject({ code: "invalid_callback" });
    expect(a.exchange).not.toHaveBeenCalled();
  });
  it("validates denial state without exchanging code", async () => {
    const m = memoryVault(),
      a = adapter(),
      s = new OAuthService(m.vault, a, "default");
    await s.begin("http://127.0.0.1:1455/auth/callback");
    await expect(
      s.callback(callback(m.attempt()!.state, "&error=access_denied")),
    ).rejects.toMatchObject({ code: "consent_required" });
    expect(a.exchange).not.toHaveBeenCalled();
  });
  it("retains a new issued client ID after failed code exchange without activating credentials", async () => {
    const m = memoryVault(),
      a = adapter(),
      s = new OAuthService(m.vault, a, "default");
    await s.begin("http://127.0.0.1:1455/auth/callback");
    vi.mocked(a.exchange).mockRejectedValueOnce(
      new OAuthFailure("login_required"),
    );
    await expect(
      s.callback(callback(m.attempt()!.state)),
    ).rejects.toMatchObject({ code: "login_required" });
    expect(m.record()).toMatchObject({
      clientId: "oaiapp_test",
      status: "signed_out",
    });
    expect(m.record()?.credential).toBeUndefined();
    const retry = new URL(await s.begin("http://127.0.0.1:1455/auth/callback"));
    expect(retry.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(retry.searchParams.has("agent_name_hint")).toBe(false);
  });
  it("retains host/client mapping across logout and reauthorization", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(ready());
    const s = new OAuthService(m.vault, a, "default");
    await s.logout();
    expect(m.record()).toEqual({
      hostId: "host",
      clientId: "oaiapp_test",
      subject: "subject",
      status: "signed_out",
    });
    const u = new URL(await s.begin("http://127.0.0.1:1455/auth/callback"));
    expect(u.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(u.searchParams.has("agent_name_hint")).toBe(false);
  });
  it("does not replace a returning registration with a different client or subject", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(ready());
    const s = new OAuthService(m.vault, a, "default");
    await s.begin("http://127.0.0.1:1455/auth/callback");
    await expect(
      s.callback(
        callback(m.attempt()!.state).replace("oaiapp_test", "oaiapp_other"),
      ),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    await s.begin("http://127.0.0.1:1455/auth/callback");
    vi.mocked(a.exchange).mockResolvedValue(credential({ subject: "other" }));
    await expect(
      s.callback(callback(m.attempt()!.state)),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(m.record()?.credential?.subject).toBe("subject");
  });
  it("accepts omitted client_id only for a returning registration", async () => {
    const m = memoryVault(),
      s = new OAuthService(m.vault, adapter(), "default");
    m.seed(ready());
    await s.begin("http://127.0.0.1:1455/auth/callback");
    await s.callback(
      callback(m.attempt()!.state).replace("&client_id=oaiapp_test", ""),
    );
    expect(await s.accessToken()).toBe("access-secret");
  });
  it("blocks inference when scope was not granted", async () => {
    const m = memoryVault(),
      a = adapter(),
      s = new OAuthService(m.vault, a, "default");
    vi.mocked(a.exchange).mockResolvedValue(credential({ scopes: ["openid"] }));
    await s.begin("http://127.0.0.1:1455/auth/callback");
    await expect(
      s.callback(callback(m.attempt()!.state)),
    ).rejects.toMatchObject({ code: "consent_required" });
    await expect(s.accessToken()).rejects.toMatchObject({
      code: "consent_required",
    });
  });
  it("serializes rotating refreshes and persists the intent before HTTP", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(ready(credential({ expiresAt: 0 })));
    vi.mocked(a.refresh).mockImplementation(async () => {
      expect(m.record()?.status).toBe("refreshing");
      await new Promise((r) => setTimeout(r, 10));
      return credential({ accessToken: "new" });
    });
    const first = new OAuthService(m.vault, a, "default"),
      second = new OAuthService(m.vault, a, "default");
    expect(
      await Promise.all([first.accessToken(), second.accessToken()]),
    ).toEqual(["new", "new"]);
    expect(a.refresh).toHaveBeenCalledTimes(1);
  });
  it("never reuses a refresh token after uncertain outcome or process crash", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(ready(credential({ expiresAt: 0 })));
    vi.mocked(a.refresh).mockRejectedValue(new Error("refresh-secret"));
    const s = new OAuthService(m.vault, a, "default");
    await expect(s.accessToken()).rejects.toMatchObject({
      code: "refresh_uncertain",
    });
    await expect(s.accessToken()).rejects.toMatchObject({
      code: "refresh_uncertain",
    });
    expect(a.refresh).toHaveBeenCalledTimes(1);
    m.seed({ ...ready(), status: "refreshing" });
    await expect(s.accessToken()).rejects.toMatchObject({
      code: "refresh_uncertain",
    });
    expect(a.refresh).toHaveBeenCalledTimes(1);
  });
  it("respects earliest refresh time", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(
      ready(
        credential({
          expiresAt: Date.now() + 30_000,
          earliestRefreshAt: Date.now() + 20_000,
        }),
      ),
    );
    expect(await new OAuthService(m.vault, a, "default").accessToken()).toBe(
      "access-secret",
    );
    expect(a.refresh).not.toHaveBeenCalled();
  });
  it("shares quota backoff and policy denial across workers without changing billing or tokens", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(ready());
    const first = new OAuthService(m.vault, a, "default"),
      second = new OAuthService(m.vault, a, "default");
    await first.noteInferenceFailure(new OAuthFailure("quota_limited", 429));
    await expect(second.accessToken()).rejects.toMatchObject({
      code: "quota_limited",
    });
    expect(m.record()?.credential?.accessToken).toBe("access-secret");
    await first.noteInferenceFailure(new OAuthFailure("policy_denied", 403));
    await expect(second.accessToken()).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(a.refresh).not.toHaveBeenCalled();
  });
  it("reports unconfirmed remote revocation but clears local tokens", async () => {
    const m = memoryVault(),
      a = adapter();
    m.seed(ready());
    vi.mocked(a.revoke).mockRejectedValue(new Error("network"));
    expect(await new OAuthService(m.vault, a, "default").logout()).toEqual({
      revoked: false,
    });
    expect(m.record()?.credential).toBeUndefined();
  });
});

describe("OpenAI OIDC validation", () => {
  it("verifies signature, issuer, audience, expiry, nonce and identity", async () => {
    const keys = await generateKeyPair("RS256");
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "test";
    jwk.alg = "RS256";
    const attempt: LoginAttempt = {
      state: "state",
      nonce: "nonce",
      verifier: "verifier",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      hostId: "host",
      clientId: "dynamic_agent_client",
      expiresAt: Date.now() + 60000,
    };
    const make = (nonce = "nonce", aud = "oaiapp_test") =>
      new SignJWT({ nonce, email: "owner@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer("https://auth.openai.com")
        .setAudience(aud)
        .setSubject("subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    let jwt = await make();
    const forms: string[] = [];
    const http = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).includes("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          jwks_uri: "https://auth.openai.com/jwks",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
      forms.push(String(init?.body));
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        id_token: jwt,
        token_type: "Bearer",
        expires_in: 3600,
        scope: `openid ${PLAN_SCOPE} resource.invoke`,
      });
    });
    const a = new OpenAIAuthAdapter(http as typeof fetch);
    expect((await a.exchange(attempt, "code", "oaiapp_test")).subject).toBe(
      "subject",
    );
    expect(forms[0]).toContain("client_id=oaiapp_test");
    expect(forms[0]).toContain("code_verifier=verifier");
    expect(forms[0]).not.toContain("client_secret");
    jwt = await make("wrong");
    await expect(
      a.exchange(attempt, "code", "oaiapp_test"),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    jwt = await make("nonce", "other");
    await expect(
      a.exchange(attempt, "code", "oaiapp_test"),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });
});

const sse = (events: any[], split = false) => {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        if (split) for (const b of bytes) c.enqueue(Uint8Array.of(b));
        else c.enqueue(bytes);
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
const completed = (
  output: any[] = [
    { type: "message", content: [{ type: "output_text", text: "你好" }] },
  ],
) => ({
  type: "response.completed",
  response: {
    status: "completed",
    output,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
});
const req = () => ({
  model: "account-model",
  input: [{ role: "user", content: "prompt" }],
  signal: AbortSignal.timeout(10000),
});
describe("Responses SSE transport", () => {
  it("uses the public endpoint, explicit streaming/stateless body, and accepts split UTF-8 only after completion", async () => {
    const http = vi.fn(async () => sse([completed()], true));
    const result = await new OpenAIResponsesAdapter(
      http as typeof fetch,
    ).complete("token", req());
    expect(result.text).toBe("你好");
    expect(result.usage.totalTokens).toBe(5);
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "account-model",
      input: [{ role: "user", content: "prompt" }],
      stream: true,
      store: false,
    });
  });
  it.each(["response.failed", "response.incomplete", "error"])(
    "rejects terminal %s and discards partial output",
    async (type) => {
      const http = vi.fn(async () =>
        sse([
          { type: "response.output_text.delta", delta: "partial" },
          {
            type,
            response: {
              error: { code: "subscription_sharing_usage_limit_exceeded" },
            },
          },
        ]),
      );
      await expect(
        new OpenAIResponsesAdapter(http as typeof fetch).complete(
          "token",
          req(),
        ),
      ).rejects.toBeInstanceOf(OAuthFailure);
    },
  );
  it("rejects interrupted/empty streams without completion", async () => {
    await expect(
      new OpenAIResponsesAdapter(async () =>
        sse([{ type: "response.output_text.delta", delta: "partial" }]),
      ).complete("token", req()),
    ).rejects.toMatchObject({ code: "incomplete_stream" });
  });
  it.each([401, 403, 429, 500])(
    "sanitizes HTTP %s without leaking response body or credential",
    async (status) => {
      const a = new OpenAIResponsesAdapter(async () =>
        Response.json(
          { error: { message: "token prompt secret" } },
          { status },
        ),
      );
      await expect(a.complete("token", req())).rejects.not.toThrow("secret");
    },
  );
  it("lists only visible account-specific model slugs", async () => {
    const a = new OpenAIResponsesAdapter(async () =>
      Response.json({
        models: [
          { slug: "yes", display_name: "Yes", visibility: "list" },
          { slug: "hidden", visibility: "hide" },
        ],
      }),
    );
    expect(await a.models("token", AbortSignal.timeout(1000))).toEqual([
      { slug: "yes", displayName: "Yes" },
    ]);
  });
});

describe("extensible adapters and tool loop", () => {
  it("requires independent inference adapter registration", () => {
    const registry = new OAuthProviderRegistry().registerAuth({
      ...adapter(),
      id: "another",
    });
    expect(() => registry.resolve("another")).toThrow(OAuthFailure);
    expect(() =>
      registry.registerInference("bad", new OpenAIResponsesAdapter()),
    ).toThrow(OAuthFailure);
  });
  it("executes caller tools, supplies namespace and carries history with accumulated usage", async () => {
    const execute = vi.fn(async (args: any) => `read:${args.path}`),
      requests: any[] = [];
    const inference = {
      authProvider: "openai",
      models: vi.fn(),
      complete: vi.fn(async (_token: string, r: any) => {
        requests.push(structuredClone({ ...r, signal: undefined }));
        return requests.length === 1
          ? {
              text: "",
              output: [
                {
                  type: "function_call",
                  call_id: "c1",
                  name: "read",
                  namespace: "memory",
                  arguments: '{"path":"scene"}',
                },
              ],
              usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
            }
          : {
              text: " done ",
              output: [],
              usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
            };
      }),
    };
    const result = await runOAuth(
      {
        prompt: "extract",
        systemPrompt: "memory",
        taskId: "l2",
        enableTools: true,
      },
      {
        service: { accessToken: async () => "token" } as OAuthService,
        inference,
        model: "model",
        timeoutMs: 10000,
        tools: {
          read: tool({
            inputSchema: jsonSchema({
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            }),
            execute,
          }),
        },
      },
    );
    expect(result).toEqual({
      text: "done",
      usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[0].tools[0].type).toBe("namespace");
    expect(requests[1].input.at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "c1",
      output: "read:scene",
    });
  });
  it("rejects invalid tool arguments before any mutation", async () => {
    const execute = vi.fn();
    const inference = {
      authProvider: "openai",
      models: vi.fn(),
      complete: vi.fn(async () => ({
        text: "",
        output: [
          {
            type: "function_call",
            call_id: "x",
            name: "write",
            arguments: '{"path":42}',
          },
        ],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      })),
    };
    await expect(
      runOAuth(
        { prompt: "x", taskId: "l3" },
        {
          service: { accessToken: async () => "token" } as OAuthService,
          inference,
          model: "model",
          timeoutMs: 1000,
          tools: {
            write: tool({
              inputSchema: jsonSchema({
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              }),
              execute,
            }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "tool_error" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("aborts before inference and never retries through another provider", async () => {
    const signal = AbortSignal.abort(),
      inference = {
        authProvider: "openai",
        models: vi.fn(),
        complete: vi.fn(),
      };
    await expect(
      runOAuth(
        { prompt: "x", taskId: "l1", abortSignal: signal },
        {
          service: { accessToken: async () => "token" } as OAuthService,
          inference,
          model: "model",
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(inference.complete).not.toHaveBeenCalled();
  });
});

describe("PostgreSQL encrypted OAuth persistence", () => {
  let pool: TestPostgresPool, db: PostgresDatabase;
  beforeEach(() => {
    pool = new TestPostgresPool();
    db = new PostgresDatabase(
      pool,
      instanceSchema(randomBytes(16).toString("hex"), "oauth"),
    );
  });
  afterEach(async () => {
    await pool.end();
  });
  it("survives new vault instances and never stores plaintext tokens or verifier", async () => {
    const vault = new PostgresOAuthVault(db, KEY),
      a = adapter(),
      s = new OAuthService(vault, a, "account");
    const url = new URL(await s.begin("http://127.0.0.1:1455/auth/callback"));
    const state = url.searchParams.get("state")!;
    const rows = await db.query("SELECT encrypted FROM oauth_pending");
    expect(JSON.stringify(rows.rows)).not.toContain(state);
    await s.callback(callback(state));
    const second = new OAuthService(
      new PostgresOAuthVault(db, KEY),
      a,
      "account",
    );
    expect(await second.accessToken()).toBe("access-secret");
    const saved = await db.query("SELECT encrypted FROM oauth_connections");
    expect(JSON.stringify(saved.rows)).not.toContain("secret");
    await expect(
      new OAuthService(
        new PostgresOAuthVault(db, Buffer.alloc(32, 8).toString("base64")),
        a,
        "account",
      ).accessToken(),
    ).rejects.toMatchObject({ code: "storage_error" });
  }, 30000);
  it("isolates account labels and rejects replayed callback after restart", async () => {
    const vault = new PostgresOAuthVault(db, KEY),
      a = adapter(),
      s = new OAuthService(vault, a, "a");
    const u = new URL(await s.begin("http://127.0.0.1:1455/auth/callback"));
    const cb = callback(u.searchParams.get("state")!);
    await s.callback(cb);
    await expect(
      new OAuthService(vault, a, "b").accessToken(),
    ).rejects.toMatchObject({ code: "login_required" });
    await expect(
      new OAuthService(new PostgresOAuthVault(db, KEY), a, "a").callback(cb),
    ).rejects.toMatchObject({ code: "invalid_callback" });
  }, 30000);
  it.skipIf(!process.env.PG_TEST_URL)(
    "serializes refresh across independent native PostgreSQL pools",
    async () => {
      const pool2 = new TestPostgresPool(),
        db2 = new PostgresDatabase(pool2, db.schema);
      const a = adapter();
      const vault = new PostgresOAuthVault(db, KEY);
      await vault.withLock("openai", "same", async (slot) =>
        slot.write(ready(credential({ expiresAt: 0 }))),
      );
      vi.mocked(a.refresh).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return credential({ accessToken: "rotated" });
      });
      try {
        const first = new OAuthService(vault, a, "same"),
          second = new OAuthService(
            new PostgresOAuthVault(db2, KEY),
            a,
            "same",
          );
        expect(
          await Promise.all([
            first.accessToken(),
            second.accessToken(),
            first.accessToken(),
          ]),
        ).toEqual(["rotated", "rotated", "rotated"]);
        expect(a.refresh).toHaveBeenCalledTimes(1);
      } finally {
        await pool2.end();
      }
    },
    30000,
  );
});

it("rejects request-level selection of a different OAuth registration or auth mode", () => {
  for (const override of [
    { llm: { oauth: { account: "other" } } },
    { llm: { oauth: { vaultId: "other" } } },
    { llm: { provider: "openai" } },
  ]) {
    expect(() => validateSeedOAuthOverride("oauth", override)).toThrow(
      OAuthFailure,
    );
  }
  expect(() =>
    validateSeedOAuthOverride("openai", { llm: { provider: "oauth" } }),
  ).toThrow(OAuthFailure);
  expect(() =>
    validateSeedOAuthOverride("oauth", { llm: { model: "chosen" } }),
  ).not.toThrow();
});
