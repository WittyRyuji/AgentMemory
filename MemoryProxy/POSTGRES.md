# Proxy PostgreSQL state

Database settings are centralized in [`../config/db.toml`](../config/README.md). Copy the root example and follow its precedence/mount rules. The environment variables below remain supported for older deployments when that file is absent.


Old SQLite/filesystem/COS/Redis modes remain available. PostgreSQL is explicitly enabled:

```sh
PROXY_STORAGE_BACKEND=postgres
PROXY_POSTGRES_URL=postgresql://user:password@postgres:5432/agentmemory
# DATABASE_URL is accepted when PROXY_POSTGRES_URL is unset.
```

Or set YAML `storage.enabled: true`, `storage.backend: postgres`, and `storage.postgres.url`. The environment backend takes precedence; selecting PostgreSQL enables unified storage even if an old YAML file has `storage.enabled: false`. Keep URLs outside committed files. TLS follows node-postgres settings.

Before accepting requests, startup creates/verifies `proxy_kv`, `proxy_rate_limit_windows`, `proxy_turn_sequences` and their SQL functions. An unavailable PG backend fails startup; it never falls back to SQLite, Redis, filesystem or memory. Database errors from authoritative binding/session writes, reads, skill version pins, rate limits and turn allocation propagate instead of being reported as successful local writes. Hook prewarming remains a best-effort cache. Existing legacy modes retain their previous degradation behavior.

Stored features:

- Full session-init state and permanent session bindings, including all existing identity fields
- Skill-version pins with atomic insert-if-absent
- Existing unified KV state under the same `ttl/` and `nottl/` key layout
- Admin rate-limit defaults and per-instance/model overrides, plus atomic database-timed 60-second TPM/QPM windows
- Monotonic turn sequence allocation, including per-lane deduplication and context-compaction handling

The five-minute sweeper removes only expired `ttl/` KV entries, inactive short-lived rate windows and expired turn-sequence records. Permanent bindings/pins/settings stay under `nottl/`. Turn-sequence lifetime uses the existing `redis.turnSeqTtlDays` setting (30 days by default) even when Redis is disabled.

Optional private cost-guard and request-preparation extensions retain their existing opaque Redis state/cache contracts. Those extensions may still require Redis; their private implementations are not part of this migration. ClickHouse/telemetry and optional JSONL log archives also remain unchanged. There is no new embedding model or OAuth implementation here.

## Import existing sources

Stop all Proxy writers, take consistent backups (including SQLite WAL as applicable), and use the importer from `MemoryProxy`:

```sh
npm run migrate:postgres -- --fs-root /path/to/proxy-state --sqlite /path/to/proxy.db
# Default dry run reads sources only; no PostgreSQL connection.
npm run migrate:postgres -- --fs-root /path/to/proxy-state --sqlite /path/to/proxy.db --apply
```

Either source is optional. Filesystem import reads only `ttl/` and `nottl/`. SQLite import covers `proxy_kv`, legacy four-part `sessions`, and `hook_cache`; terminal legacy sessions also produce permanent bindings when no explicit binding exists. Ambiguous legacy session IDs, symlinks, temporary files, or conflicting duplicate source keys stop the import rather than silently dropping data. The SQLite source opens read-only; native `better-sqlite3` must be available for that source.

If migrating dynamic rate-limit policy from Redis, export the existing authenticated `GET /v3/admin/rate-limits` response before stopping the old service, then include `--rate-limits /path/to/export.json` in the same dry-run/apply command. The exporter accepts either that success envelope or its `data` object. Apply requires an empty `proxy_kv`, holds an exclusive table lock, verifies counts and commits all rows in one transaction. All source files remain unchanged; import errors roll back target writes. Existing live Redis session/turn-counter/private-extension data and COS objects are not directly imported by this file/SQLite tool. For a Redis/COS deployment, export/reconcile that state before cutover or explicitly accept resetting its ephemeral state; do not assume it was migrated by an empty import. New PG turn counters start fresh unless migrated separately, which can affect continuity of existing trace/usage sequence identifiers.

After import, enable PG, verify real client sessions and admin limits, and retain backups. Do not point old writers at source state after cutover. A rollback after new PG writes needs reconciliation first.

## Validation

```sh
npm run typecheck
npm test
# Native PG (isolated disposable *_test database only):
PG_TEST_URL=postgresql://user:password@localhost:5432/agentmemory_test npm test
```

Default tests use PGlite, not a network PostgreSQL server. Native runs create/drop an isolated random schema. Coverage includes cross-store persistence, literal-prefix isolation, CAS, TTL, binding timestamps, session state, version pins, strict errors, rate limits/counters, turn lanes, atomic import rollback, source integrity, and native SQLite source reading in an isolated process. This does not substitute for a live multi-node server/load test or private-extension integration tests.
