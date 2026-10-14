#!/usr/bin/env node
/** Owner-only CLI. It never reads another application's credentials or prints saved tokens. */
import { createServer } from "node:http";
import {
  createOAuthRuntime,
  closeOAuthRuntimes,
  parseOAuthConfig,
} from "../../src/auth/oauth/runtime.js";
import { safeFailure, OAuthFailure } from "../../src/auth/oauth/types.js";
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const value = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
  };
  if (!["login", "status", "models", "logout"].includes(command)) {
    console.log(
      "Usage: npm run oauth -- <login|status|models|logout> [--account LABEL] [--vault-id ID] [--adapter openai-responses] [--consent]\nRequires config/db.toml and AGENTMEMORY_OAUTH_KEY (base64 AES-256 key). Run login on the browser host; use an SSH loopback tunnel for a remote host.",
    );
    return;
  }
  const runtime = createOAuthRuntime(
    parseOAuthConfig({
      account: value("--account", "default"),
      vaultId: value("--vault-id", "agentmemory"),
      adapter: value("--adapter", "openai-responses"),
    }),
  );
  if (command === "status")
    console.log(JSON.stringify(await runtime.service.status(), null, 2));
  else if (command === "models")
    console.log(
      JSON.stringify(
        await runtime.inference.models(
          await runtime.service.accessToken(),
          AbortSignal.timeout(30_000),
        ),
        null,
        2,
      ),
    );
  else if (command === "logout") {
    const { revoked } = await runtime.service.logout();
    console.log(
      revoked
        ? "Signed out; renewable session revoked."
        : "Signed out locally. Remote revocation was not confirmed; disconnect AgentMemory in ChatGPT Settings.",
    );
  } else await login(runtime.service, args.includes("--consent"));
}
async function login(
  service: ReturnType<typeof createOAuthRuntime>["service"],
  consent: boolean,
) {
  let settle!: (e?: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (e) => (e ? reject(e) : resolve());
  });
  let handling = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    if (
      req.method !== "GET" ||
      !req.url?.startsWith("/auth/callback?") ||
      handling
    ) {
      res.writeHead(404).end("Not found");
      return;
    }
    handling = true;
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new OAuthFailure("configuration_error");
      if (req.headers.host !== `127.0.0.1:${address.port}`)
        throw new OAuthFailure("invalid_callback");
      await service.callback(`http://127.0.0.1:${address.port}${req.url}`);
      res.end("AgentMemory sign-in complete. You can close this tab.");
      settle();
    } catch (e) {
      const safe = safeFailure(e);
      res.writeHead(400).end(safe.message);
      // A stray invalid request must not cancel the legitimate pending sign-in.
      if (safe.code === "invalid_callback") handling = false;
      else settle(safe);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new OAuthFailure("configuration_error");
  const timer = setTimeout(
    () => settle(new OAuthFailure("invalid_callback")),
    10 * 60_000,
  );
  try {
    const url = await service.begin(
      `http://127.0.0.1:${address.port}/auth/callback`,
      consent,
    );
    console.log(
      "Continue with ChatGPT. Open this URL in your browser. It grants AgentMemory access to your ChatGPT plan; review its limits and permissions before authorizing.",
    );
    console.log(url); // Contains one-time PKCE state, never retained ID/access/refresh tokens.
    console.log(
      `Callback listens only on 127.0.0.1:${address.port}. For a remote runtime, forward this port securely before opening the URL.`,
    );
    await done;
    console.log(
      "Sign-in saved securely. Run the models command to choose an available model.",
    );
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
main()
  .catch((e) => {
    const safe = safeFailure(e);
    console.error(`${safe.code}: ${safe.message}`);
    process.exitCode = 1;
  })
  .finally(closeOAuthRuntimes);
