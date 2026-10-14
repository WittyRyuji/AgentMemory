# Panel PostgreSQL state

Database settings are centralized in [`../config/db.toml`](../config/README.md). Copy the root example and follow its precedence/mount rules. The environment variables below remain supported for older deployments when that file is absent.


Existing file mode remains the default. To use PostgreSQL:

```sh
PANEL_STATE_BACKEND=postgres
PANEL_POSTGRES_URL=postgresql://user:password@postgres:5432/agentmemory
# DATABASE_URL is accepted when PANEL_POSTGRES_URL is unset.
```

The URL is a deployment secret; do not commit it. TLS follows the node-postgres connection settings. Tables `panel_identities` and `panel_agent_templates` are shared across Panel instances. Queries retain instance/provider/subject or instance/team isolation. PostgreSQL must initialize before the HTTP listener starts; a PG failure never switches to local JSON.

Identity bindings retain their existing AES-GCM ciphertext. Keep the existing `PANEL_AUTH_SESSION_SECRET_FILE` securely mounted at the same value during migration and across Panel replicas. It remains configuration, not a database record. Losing or replacing this secret prevents decrypting existing identity keys. The metadata instance registry is also configuration and remains a file. Login sessions, consumed login nonces, ingest progress and knowledge callback tracking retain their existing in-memory lifecycle; this change does not make those caches restart-persistent or make IdP login multi-replica safe without session affinity.

## Import existing files

Stop all Panel writers, back up the JSON/template directories and secret file, and run from `MemoryPanel`:

```sh
npm run migrate:postgres -- --identities ./data/panel-auth-identities.json --templates ./data/agent-templates
# Inspect counts; the default dry run reads sources only and does not connect to PG.
npm run migrate:postgres -- --identities ./data/panel-auth-identities.json --templates ./data/agent-templates --apply
```

Either source may be omitted when it does not exist. An explicitly supplied missing/malformed source is an error. Apply uses a dedicated connection, one transaction, exclusive target table locks, an empty-target guard and a row-count verification before commit. It never deletes source files or replaces target data. On import failure the transaction rolls back. Cut over only after successful import; rolling back after new PG writes requires reconciling those writes first.

## Validation

```sh
npm run typecheck
npm test
# Optional real-server run against an isolated disposable database:
PG_TEST_URL=postgresql://user:password@localhost:5432/agentmemory_test npm test
```

Without `PG_TEST_URL`, tests use PGlite (the PostgreSQL engine in WASM), not a network PostgreSQL server. Native runs create and drop a random test schema and reject database names without `_test`. Tests cover encrypted identity round trips, instance/provider isolation, template overwrite, local-file compatibility, fail-closed storage errors, source integrity, atomic import/rollback and empty-target protection. They do not exercise a live external IdP.
