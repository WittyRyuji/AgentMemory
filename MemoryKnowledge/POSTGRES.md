# MemoryKnowledge: PostgreSQL storage

## Runtime

Set `KNOWLEDGE_POSTGRES_URL` to a PostgreSQL connection URL, then run `npm install`, `npm run build`, and `npm run dev` (or the existing Docker command). `DATABASE_URL` is a fallback. `KNOWLEDGE_DB_PATH` is no longer a runtime setting. `npm run db:migrate` explicitly creates all runtime tables; startup does the same automatically. The startup migration is transactional/idempotent and does not drop existing tables. Tables live in the connection's default schema; use a dedicated database or a dedicated role/search_path. Five pooled connections plus an in-process build queue support modest machines; no GPU or local embedding model is added. Wiki ingest still uses the existing external LLM configuration.

Only one Knowledge writer may use a database at a time. Startup takes a PostgreSQL session advisory lease before materializing files. Another process fails startup; a lost lease terminates the process. This deliberately prevents stale independent working caches from overwriting one another. Horizontal multi-writer operation is not implemented.

## Authoritative data and caches

PostgreSQL now contains:
- Code-graph/wiki metadata, tenant isolation, status/version, audit rows
- Resource-scoped credentials and per-service LLM bindings
- Wiki source hashes, authors, timestamps, processing outcomes
- Wiki full-text search vectors, page metadata and graph edges
- Raw/wiki Markdown, import maps, ingest logs and engine files in BYTEA artifact snapshots
- Code repository source files and project configuration
- SSH private/public keys, owner markers and known_hosts, including original file modes

The local `KNOWLEDGE_DATA_DIR` and `KNOWLEDGE_SSH_KEY_DIR` remain required working directories for existing file-oriented engines and Git/SSH. Acknowledged file writes are committed to PostgreSQL before responding. Successful wiki ingest commits source lifecycle, search/graph rows and the generated-file snapshot in one transaction. A crash before that commit retains the previous snapshot; an interrupted build is marked failed on startup and can be retried. Code builds persist their sources before becoming ready; local-source builds also persist their submitted source tree before queueing.

Startup restores registered artifact scopes before serving requests, replacing their working-cache contents. Unregistered manually staged directories are left alone. Do not edit an already registered cache directly and expect it to be durable: use the API, or explicitly submit a local code build. PostgreSQL must be backed up; backing up only the cache is insufficient. Database credentials, PATs and SSH keys require appropriate database access controls, encrypted backups and TLS where applicable. Base64 credential encoding is retained for compatibility and is not encryption.

Upstream `@colbymchenry/codegraph` still uses its own SQLite index inside `.codegraph`. This fork does not pretend the vendor engine supports PostgreSQL. That index is derived: the exposed tools are read-only search/explore/callers/callees/impact/node/status/files, and the index is rebuilt from the PG-backed source tree when missing. `.git`, `.codegraph*` directories and `node_modules` are excluded from code-source snapshots; Git history and dependency installations are refetchable, and the default CodeGraph parser does not index them. Repository symlinks are not followed or restored. A single artifact file larger than 128 MiB fails checkpointing rather than being silently omitted. Wiki's old `index.db` is only read by the legacy importer, never used at runtime.

The optional, existing ClickHouse usage telemetry/analytics integration is unchanged and disabled by default. It is external telemetry, not the authoritative resource/content store. OAuth is unchanged/deferred.

## Search compatibility

Chinese bigram/mixed-language tokenization, OR/prefix matching, title boost, snippets, related pages and multi-hop graph expansion are retained. PostgreSQL `tsvector` with GIN and `ts_rank_cd` replaces SQLite FTS5 BM25. Title terms have five times the content-term weight. Ranking values and some orderings are therefore different; this is not a claim of identical BM25 scoring. Existing `hop`, `decay`, and `minScore` options remain; tune numeric thresholds against representative data if relying on exact score cutoffs.

## Existing SQLite installation

1. Stop the old Knowledge process and disable its auto-sync. Back up its complete SQLite database plus the complete data and SSH directories. Keep the backup until end-to-end acceptance succeeds.
2. Point `KNOWLEDGE_POSTGRES_URL` at an empty destination database/schema. Do not start the new service yet.
3. On Node 22.13+ (Node's built-in SQLite reader), run:

   `npm run db:import-sqlite -- /backup/knowledge.db /backup/data [/backup/ssh-keys]`

   The importer opens SQLite read-only and imports metadata, audits with original IDs, credentials/bindings, per-wiki source lifecycle and file snapshots in one PostgreSQL transaction. It refuses a nonempty destination, missing registered resource directories, or older user-scoped credentials that cannot be mapped to a resource. A failure rolls back the import; no partial success or silent conflict merge is reported. Audit sequences are advanced. Search/graph indexes rebuild from the migrated pages at startup. The source SQLite/files are not modified.
4. Start the new service with a fresh working directory to verify recovery from PostgreSQL. Check wiki/raw/page reads, search, graph, imports, code queries, bindings and SSH public keys. Then switch clients to it. Roll back by stopping it and restarting the old version against the preserved backup; writes made only after the PG cutover must be reconciled explicitly.

## Verification

`npm run typecheck`, `npm test`, `npm run build`. Set `PG_TEST_URL` to a disposable database whose name ends in `_test` to run the same integration tests through the real node-postgres network driver. Each test pool creates and drops its own `knowledge_test_*` schema; never use a production database. Without that variable, tests use PGlite.

The test suite uses PostgreSQL via PGlite (not a mocked SQL engine), adapting the node-postgres transport only. It covers tenant isolation, idempotent competing creates, restart failure recovery, credentials/bindings, clean-cache file restore, rollback, source state, Chinese/prefix/title ranking and graph expansion, existing HTTP shapes and private file modes. Real-network PostgreSQL pooling/lease failover, Docker startup, external providers/LLMs and production credentials still require deployment validation.
