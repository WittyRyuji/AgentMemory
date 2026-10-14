# Independent OAuth inference

AgentMemory now has its own OAuth login and inference path. It does not read
Hermes, Codex, OpenClaw, browser, or other applications' saved credentials. It
also does not require a host agent to run extraction.

The first implementation is OpenAI Sign in with ChatGPT (SIWC) for an owner's
self-hosted open-source installation. The owner must approve AgentMemory's own
registration, ChatGPT plan permissions, and usage limits. This branch implements
and tests the code; no real account has been signed in, registered, billed, or
deployed during development. Account/workspace eligibility and actual model
availability still need an owner-authorized live check.

## Configuration and first login

1. At the repository root, copy `config/db.example.toml` to **`config/db.toml`**,
   enter the PostgreSQL URL, and restrict the file to the service owner (`0600`).
   All four modules use this shared file. See [database configuration](config/README.md).
2. Provision `AGENTMEMORY_OAUTH_KEY` through the runtime's secret manager: a
   cryptographically random 32-byte key encoded as canonical base64. It is the
   AES-256-GCM encryption key, not an OpenAI API key. Never place it or tokens in
   YAML, TOML, Git, logs, or a chat. Preserve it with protected backups; losing it
   requires reauthorization. No key or client registration is generated on
   application startup. Key rotation/re-encryption tooling is not included.
3. On the machine running your browser, run the owner-only CLI:

   ```sh
   cd MemoryCore
   npm run oauth -- login --account owner --vault-id agentmemory
   npm run oauth -- status --account owner --vault-id agentmemory
   npm run oauth -- models --account owner --vault-id agentmemory
   ```

   The CLI binds an available `127.0.0.1` port before printing a one-time sign-in
   URL. Open that URL yourself and review the permissions. The URL has no saved
   access, refresh, or ID token. A callback expires after ten minutes and is
   consumed once. CLI output never prints saved tokens.
4. Choose a model slug returned by `models` for that account. Add this block to
   the existing gateway YAML (for example `MemoryCore/tdai-gateway.postgres.yaml`):

   ```yaml
   llm:
     provider: oauth
     model: REPLACE_WITH_A_MODEL_SLUG_FROM_MODELS
     timeoutMs: 120000
     oauth:
       adapter: openai-responses
       account: owner
       vaultId: agentmemory
       encryptionKeyEnv: AGENTMEMORY_OAUTH_KEY
   ```

   Then deliberately enable `memory.extraction.enabled` and, if wanted,
   `skill.extraction.enabled` in the existing blocks. OAuth configuration
   automatically supplies the standalone L1/L2/L3/skill runner; no `llm.apiKey`
   is required. In-process plugin users can put the same settings under their
   existing `llm` block with `enabled: true`.

`provider: openai` and `provider: proxy` retain the existing explicitly configured
API-key and Tencent proxy behavior. Selecting `oauth` never falls back to either
of them. Existing API-key variables are ignored by the OAuth transport. An
unknown provider is rejected. Embeddings remain a separate external API and
must have their own URL, key, model, and actual dimensions; ChatGPT OAuth does not
supply an embeddings endpoint. No local model is downloaded.

The example compose file still leaves LLM extraction disabled. To enable it,
provide the encryption key to the Core container via your secret-management
setup and add the YAML above. Database config is mounted read-only. These are
configuration instructions, not evidence of deployment.

## Accounts, remote hosts, and logout

- Use a separate stable `--account` label for each registration/workspace, even
  if email addresses match. The YAML account selects the active registration.
  Complete sign-in first, then change the YAML and restart. There is no public
  gateway login endpoint or way for a request to select another owner's tokens.
- Reauthorization keeps the issued client ID, validated subject, and host ID.
  A new account label creates a separate registration. OAuth identity and
  permissions are validated before credentials are replaced.
- To explicitly request missing plan permission, run `login ... --consent`.
  Ordinary login does not force another consent screen.
- Use a distinct `vaultId` for each independent runtime installation. Workers
  in the same installation share its encrypted vault and refresh lock. This is
  for a trusted owner-controlled deployment, not a public multi-user OAuth or
  credential-sharing service. Restrict database, gateway, and CLI access.
- On a remote host, `127.0.0.1` in the browser reaches your local computer. Use a
  secure SSH loopback port forward for the exact port printed by the CLI, or
  run the CLI on the browser host against the same protected owner-controlled
  vault. Do not expose the callback on `0.0.0.0`, copy browser credentials, or
  borrow another tool's session. Secure credential-file import/export is not
  implemented.
- `npm run oauth -- logout --account owner --vault-id agentmemory` attempts
  provider revocation, clears local tokens and pending login, and retains the
  registration/host mapping. If revocation cannot be confirmed, the CLI says so;
  disconnect the application in ChatGPT Settings. Already in-flight inference
  is not remotely cancelled by this local command.

## Security and persistence

The dedicated `am_oauth_<hash>` PostgreSQL schema stores AES-256-GCM encrypted
credential and pending-attempt envelopes. Associated data binds each envelope
to its schema, provider, account label, and record type. Tokens never enter
business memory, metadata, file, job, or telemetry tables. Protect full database
backups and the encryption key separately; the key is only read from the named
environment variable.

Each sign-in uses cryptographic state, nonce and S256 PKCE. The new registration's
issued client ID is used for token exchange; the bootstrap ID is never persisted
as the issued ID. JWKS signature, issuer, audience, expiration, nonce, and returning
subject are verified. Granted plan scopes gate inference.

Refresh is serialized across processes using a PostgreSQL session advisory lock.
A durable `refreshing` intent is committed before the rotating token is sent.
Successful replacement tokens are saved together. A process crash or ambiguous
network/success-validation outcome blocks reuse and requires fresh sign-in;
the encrypted old credentials remain available only for sign-out/recovery.
Confirmed unusable refresh tokens are cleared. Confirmed temporary HTTP failures
preserve the credentials with bounded backoff. Do not restore an old database
backup and resume rotating tokens blindly; reauthorize restored sessions.

The CLI and runner only emit sanitized errors, known provider error codes and
safe request IDs. Reauthorization intentionally omits optional token hints to
avoid printing retained ID tokens in terminal URLs. Local file tools reject
path traversal and symlinks, including dangling links. Storage-backed L2/L3 tools
continue using the existing PG/Tencent `StorageAdapter` contract.

## Inference and extension contract

- Auth and inference are separate interfaces in `MemoryCore/src/auth/oauth`.
  `OAuthProviderRegistry.registerAuth` only adds authentication.
  An explicitly registered `OAuthInferenceAdapter` is also required before
  inference is allowed. A generic OAuth login alone is not an LLM entitlement.
- New providers implement their own authorized registration/token semantics,
  required inference scopes, validation and supported inference endpoint. Add
  explicit tests and documentation before enabling a provider. URLs and token
  destinations are code-level trusted adapter choices, not caller-controlled.
- OpenAI uses only public `https://api.openai.com/v1/models` and
  `https://api.openai.com/v1/responses`. It does not use private `backend-api`
  routes, app-server, a borrowed client ID, or a host process.
- Responses requests always use `stream: true`, `store: false`, an input array,
  and `instructions` for the system prompt. Unsupported preview fields such as
  `max_output_tokens`, `temperature`, `metadata`, `previous_response_id`, and
  `background` are omitted. Existing `maxTokens`/temperature settings therefore
  do not impose an OAuth output limit; timeout and tool-iteration limits remain.
- Success requires a valid `response.completed` terminal event. Failed,
  incomplete, malformed, interrupted, and oversized streams discard partial
  output. Client-side tools execute only after a completed response, use a
  namespaced tool group, validate arguments, retain stateless history, and have
  bounded iterations. L2/L3 storage tools and caller-provided skill tools work
  through this path. Usage is aggregated across steps.
- Quota, policy, missing consent, unavailable service and unsupported capability
  errors remain distinct. Quota/unavailable responses persist a short shared
  backoff across workers (not an inferred quota reset time). Policy denial blocks
  further inference until the operator resolves it and reauthorizes. There is no automatic alternate model, local model,
  API-key billing, or paid fallback. Review app limits at
  [ChatGPT Settings → Usage](https://chatgpt.com/#settings/Usage).

## Verification

```sh
node scripts/sync-db-config.mjs --check
cd MemoryCore
npm run typecheck:oauth
npm run test:oauth
npm run typecheck:postgres
npm run test:postgres
npm run build:plugin
```

`test:oauth` includes mocked provider/JWKS/SSE tests, actual runner/storage-tool
wiring, encrypted persistence, replay protection and refresh tests. Without
`PG_TEST_URL`, vault storage uses test-only PGlite and the independent native-pool
concurrency test is explicitly skipped. GitHub's PostgreSQL workflow sets a
native PostgreSQL 17 + pgvector disposable database, runs the concurrency test,
and preserves all four modules' PG regression suites. Mocked and database tests
do not establish real-account eligibility or a successful live OpenAI request.
`typecheck:oauth` covers the new auth implementation/CLI and unit tests; the
integration wiring test executes in Vitest alongside the existing plugin build.

## Official protocol references

Verified against OpenAI's documentation on 2026-10-14:
[registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery),
[self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
