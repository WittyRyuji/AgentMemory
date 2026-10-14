# PostgreSQL migration (development branch)

This is an in-place backend migration of TencentDB Agent Memory. The existing gateway, Panel/SDK API shapes, metadata services and team/agent ACLs are retained. It does not replace the product with a separate memory server.

## Implemented

- Core: all `IMetadataStore` operations (users/keys, teams, members, agents, tasks, assets, ACLs, configuration and upstream bindings) use PostgreSQL.
- Core: L0/L1 data and pgvector embeddings; L2/L3 profile rows; prompts, audit and generation references; legacy v2 entities; skill versions, text/vector search and resources.
- Core: conversation/session archives, checkpoints and other object bytes use PostgreSQL `bytea`. Existing `StorageAdapter` paths remain the contract; `rowfs` maps persona/scene files to profile rows.
- Core: pipeline state, buffers, timers, job claims/retries, owner-checked locks and skill agent queues are durable PostgreSQL tables. The scanner's timer-to-job transition is atomic.
- Panel: encrypted identity bindings and per-instance/team agent templates use PG; existing file mode remains optional. See [Panel details](MemoryPanel/POSTGRES.md).
- Proxy: permanent session bindings, unified KV state, skill pins, dynamic rate-limit policy/windows and monotonic turn sequences use PG. See [Proxy details](MemoryProxy/POSTGRES.md).
- Knowledge: metadata, source lifecycle, credentials, LLM bindings, wiki search and durable source/artifact snapshots use PostgreSQL. Existing wiki and CodeGraph tools remain. See [Knowledge details](MemoryKnowledge/POSTGRES.md).

Each Core instance has separate hashed memory/metadata schemas. PostgreSQL has an application connection pool, not one connection per instance. The metadata and memory URL may differ, but the import utility uses a single database to make their import one transaction.

### Runtime boundaries

The CodeGraph vendor engine still builds a local SQLite search index. This is a derived cache rebuilt from PG-backed source files, not authoritative business storage. Git checkouts, tool working directories, temporary files, server logs and configuration remain on disk. Knowledge currently enforces one active writer per database because upstream engines mutate working directories. Optional external observability sinks (including ClickHouse) are unchanged.

Panel retains its signing/encryption secret and instance registry as configuration files. Keep the existing secret unchanged during migration. Login sessions/nonces and callback/progress registries remain ephemeral; this does not provide restart-persistent login or multi-replica IdP sessions. Optional private Proxy cost-guard/request-preparation extensions retain opaque Redis contracts outside this public migration. Direct import of legacy Redis/COS state is not implemented; export/reconcile it before cutover, as described in the Proxy guide.

## Runtime configuration

Use `MemoryCore/tdai-gateway.postgres.yaml` with:

- `STORE_MODE=postgres`
- `TDAI_POSTGRES_URL=postgresql://…`
- `STATE_BACKEND=postgres`
- `FILE_STORE_MODE=rowfs`
- `FILE_STORE_OTHERS=postgres`
- Explicit external embedding URL, API key, model and correct output dimensions

Enable the other modules explicitly with `KNOWLEDGE_POSTGRES_URL`, `PANEL_STATE_BACKEND=postgres` plus `PANEL_POSTGRES_URL`, and `PROXY_STORAGE_BACKEND=postgres` plus `PROXY_POSTGRES_URL`. Each accepts `DATABASE_URL` as a fallback. Their public-schema tables do not conflict with Core schemas. The local compose example covers Core/Knowledge; keep existing Panel/Proxy deployment configuration and add these switches.

Metadata defaults to the same PG URL. Remove old explicit SQLite/Mongo metadata settings; conflicting backends fail startup. PG startup errors fail loudly instead of creating SQLite or switching to local model inference. Embedding configuration changes also fail startup until an explicit re-embedding migration is performed.

`docker-compose.postgres.yaml` is a local validation example, not an already-deployed service. It runs PostgreSQL 17 with pgvector and binds Core/Knowledge ports to loopback. Set passwords and keys outside Git. Percent-encode a password when constructing a URL. Do not expose the database; use authenticated TLS termination before exposing the gateway. For an external database, require certificate-verified TLS using the node-postgres connection configuration, and provision `vector` in `public` before starting if the application role cannot create extensions. The application role needs schema/table creation privileges for the selected database. Back up the full database (including all `am_*` schemas and Knowledge tables).

The YAML deliberately leaves memory/skill LLM extraction disabled until a provider is explicitly configured. Existing extraction code is retained; no independent OpenAI OAuth is implemented in this phase and no paid LLM fallback is introduced. Embedding API access is separate and required. The normal clients continue using the existing gateway endpoints, authentication and tenant identifiers. For PG-backed shared memory use the gateway; legacy in-process plugin storage modes retain their old behavior.

The example uses low worker concurrency. Start with a small workload: vector search currently uses exact pgvector cosine distance (no approximate ANN index), and file listings may materialize matching keys for pagination. Native PG full-text ranking replaces SQLite FTS5's score; ordering/scores are not mathematically identical. Chinese tokenization remains available without a GPU. Load/quality benchmarking and ANN tuning are still required before a large production corpus.

## Offline Core migration

Stop all writers and take restorable backups of the SQLite databases, storage root and PG target. Do not migrate a live source. Run from `MemoryCore` with Node 22.18+ (Node 24 is used in CI):

```sh
npm run migrate:postgres -- \
  --instance default \
  --memory-sqlite /backup/vectors.db \
  --metadata-sqlite /backup/metadata.db \
  --files-root /backup/memory-files \
  --provider openai --model YOUR_EXISTING_MODEL --dimensions 1536 \
  --profile-team YOUR_TEAM_ID --profile-agent YOUR_AGENT_ID
```

This defaults to a source-only dry run: it does not connect to or change PG. Review the counts and skipped file/table list. The root must be the actual per-instance storage directory, not a general home/config directory. Symlinks are refused. Unscoped historical persona/scene files require explicit ownership; scoped `profiles/...` files retain their recorded owners. The utility copies credentials already stored in metadata into the target database, so both backups and target must be protected accordingly.

After inspection, set `TDAI_POSTGRES_URL` securely and rerun with `--apply`. The target must have no business rows in either instance schema. Schema setup is idempotent; all imported metadata, rows, vectors, profiles and object bytes are committed together or rolled back. Source files are read-only. Reapplying to an occupied target fails rather than overwriting. Identity sequences are reset after copying IDs.

When provider/model/dimensions match, sqlite-vec embeddings are copied without an API call. Missing or zero placeholder vectors are counted. To intentionally discard old vectors, pass `--without-vectors`; text/profile data remain available, but semantic recall is incomplete until explicit external re-embedding. The utility never calls an embedding/LLM API. Skill history is retained; only the source's head-vector index can be copied when the old engine had no historical embeddings. FTS indexes are regenerated locally from imported text.

Known exclusions: drained in-memory/Redis pipeline work has no SQLite representation and must be completed before cutover; configuration manifests, caches and unknown business tables are not silently treated as memory data. Unknown business tables block `--apply`. Knowledge has its own offline migration procedure in its linked guide. Keep the old deployment stopped but intact until counts, ACL access and representative searches have been checked. Rollback before accepting new writes means selecting the untouched old deployment; after new PG writes, restoring old SQLite alone would lose them.

## Verification evidence

Locally run against PostgreSQL WASM (PGlite), not a mocked SQL engine:

- Core PG suites: 124 tests including 94 unchanged metadata contract cases, 12 unchanged storage contract cases, pgvector/Chinese search, profiles, queues/locks, migration rollback and per-instance gateway wiring.
- Actual gateway startup/shutdown is tested with only the HTTP listener stubbed; storage, metadata, state, skills and scanner/worker assembly execute normally. This does not establish TCP reachability or native PostgreSQL pooling.
- Core focused `npm run typecheck:postgres` and plugin `npm run build:plugin` pass.
- Full upstream gateway strict type-check is not clean: the untouched upstream and this fork showed the same 197 diagnostics with the same installed dependency set (normalized file paths/line positions), including absent private integrations and existing generated-schema/SDK typing issues.
- Knowledge: 18 tests pass, one native-session lease test is skipped without `PG_TEST_URL`; type-check/build and real native CodeGraph indexing/cache reconstruction pass.
- Panel: full type-check and 6 tests pass. Proxy: full type-check and 12 tests pass, including native SQLite import fixtures in isolated processes.

`.github/workflows/postgres.yml` runs all four modules against a native PostgreSQL 17 + pgvector service. Set `PG_TEST_URL` locally only to a disposable database ending in `_test`; tests drop their test schemas. Do not use production data. Native network, pooling and lease behavior are not considered verified until that CI run succeeds. Docker startup and live external-provider/LLM calls have not been run in this workspace.
