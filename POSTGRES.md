# PostgreSQL storage and migration (current main)

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

中文安装步骤、Embedding Key 和启动命令见 [当前安装指南](INSTALL_CN.md)。

## Runtime configuration

Database settings now live in root **`config/db.toml`**, shared by Core, Knowledge,
Panel and Proxy. Copy `config/db.example.toml` to that path, replace the example
URL, and protect the file with `chmod 600`. Per-module URL overrides and separate
Core metadata URL are supported. See [configuration rules](config/README.md) for
exact path resolution, compatibility, conflict handling and container mounts.
The private file is gitignored; no actual credentials are included in this branch.

Use `MemoryCore/tdai-gateway.postgres.yaml` for the existing gateway settings.
Configure the external embedding URL, API key, model and real dimensions there
or through the shown environment variables. The TOML URL selects PostgreSQL and
sets PG-compatible default storage modes. Old module-specific URL variables and
`DATABASE_URL` remain supported when the default file is absent. With a file,
conflicting legacy values fail instead of silently selecting another database.

The root deployment now has five separate, single-service Compose files:
`docker-compose.postgres.yaml`, `docker-compose.core.yaml`,
`docker-compose.panel.yaml`, `docker-compose.proxy.yaml`, and
`docker-compose.knowledge.yaml`. PostgreSQL + Core are the minimum two containers.
Each file has its own project name and joins one explicitly created external network;
start PostgreSQL and wait for health before starting applications. Do not merge the
files with multiple `-f` arguments or override them all with the same project name.
All four applications mount `config/db.toml` read-only; use hostname `postgres`.
Published HTTP ports bind to loopback. Panel serves its built UI in the same container.
These are deployment examples, not an already validated live Compose deployment.

**Existing installations:** the former combined root file is preserved under
`deploy/legacy/docker-compose.postgres.yaml` only as a migration aid. Stop it using
the original project name, without `-v`, before starting the new layout. Set
`POSTGRES_VOLUME` to the actual old named volume; the new PostgreSQL file requires
an existing external volume and will not create one implicitly. Never mount the
same PG data directory in two running servers. Preserve Panel's encryption secret
when moving an existing Panel. See the [Chinese installation guide](INSTALL_CN.md)
for exact preparation, migration, startup and permissions steps.

Do not expose PostgreSQL. Use authenticated TLS termination for the gateway and
certificate-verified TLS for a remote database. Provision `vector` in `public`
when the application role cannot create extensions. Back up the full database.

The YAML deliberately leaves memory/skill LLM extraction disabled until a provider is explicitly configured. Existing extraction code is retained. Independent OpenAI OAuth is now available as an explicit opt-in; see [OAuth setup and verification](OAUTH.md). No paid LLM fallback is introduced. Embedding API access is separate and required. The normal clients continue using the existing gateway endpoints, authentication and tenant identifiers. For PG-backed shared memory use the gateway; legacy in-process plugin storage modes retain their old behavior.

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

After inspection, configure `config/db.toml` securely and rerun with `--apply`. The target must have no business rows in either instance schema. Schema setup is idempotent; all imported metadata, rows, vectors, profiles and object bytes are committed together or rolled back. Source files are read-only. Reapplying to an occupied target fails rather than overwriting. Identity sequences are reset after copying IDs.

When provider/model/dimensions match, sqlite-vec embeddings are copied without an API call. Missing or zero placeholder vectors are counted. To intentionally discard old vectors, pass `--without-vectors`; text/profile data remain available, but semantic recall is incomplete until explicit external re-embedding. The utility never calls an embedding/LLM API. Skill history is retained; only the source's head-vector index can be copied when the old engine had no historical embeddings. FTS indexes are regenerated locally from imported text.

Known exclusions: drained in-memory/Redis pipeline work has no SQLite representation and must be completed before cutover; configuration manifests, caches and unknown business tables are not silently treated as memory data. Unknown business tables block `--apply`. Knowledge has its own offline migration procedure in its linked guide. Keep the old deployment stopped but intact until counts, ACL access and representative searches have been checked. Rollback before accepting new writes means selecting the untouched old deployment; after new PG writes, restoring old SQLite alone would lose them.

## Verification evidence

Baseline: `3f8aee8` on `main`, checked on 2026-10-14. The four-module GitHub PostgreSQL CI completed with 297 passing tests. A separate native PostgreSQL 17.11 + pgvector 0.8.0 run passed 253 tests: Core PG 124, Core OAuth 46, Knowledge 34, Panel 21, Proxy 28, with no skips in that selected run. Counts differ because CI includes additional Core configuration/tokenization/checkpoint suites.

The separate actual Core HTTP smoke verified `/health`, `/capture`, `/search/conversations`, hybrid `/search/memories`, and retrieval after both Gateway and PostgreSQL restart. Production-adapter checks also covered vector / full-text search, L2 profiles, object bytes, buffers, queued tasks and tenant isolation. Embeddings came from a synthetic local fixture, not an external provider; this verifies wiring and persistence, not embedding or extraction quality.

Panel, Proxy and Knowledge passed native database contracts/integration suites; their independent HTTP entrypoints and full restart flows were not exercised in that smoke. OAuth CLI callback/state/Host checks ran locally, while provider/JWKS/SSE tests used fixtures. Real account authorization, registration, model entitlement and inference remain unverified; the test browser could not reach the shell's loopback callback.

Core focused PostgreSQL/OAuth type checks and plugin build passed. The full upstream gateway strict type check is not clean: the upstream and this fork showed the same 197 diagnostics with the same dependency set, including absent private integrations and existing generated-schema/SDK typing issues. Do not interpret the focused CI as a clean full-project strict type check.

[The PostgreSQL workflow](.github/workflows/postgres.yml) runs native PostgreSQL 17 + pgvector. Set `PG_TEST_URL` only to a disposable database ending in `_test`; tests create/drop test schemas. Without it, relevant tests use PGlite and native-only cases may skip. Docker Compose deployment, production migration, external Embedding, live OAuth/LLM calls and load/quality benchmarks still require operator validation.
