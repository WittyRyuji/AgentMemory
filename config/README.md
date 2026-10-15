# 共享数据库配置（当前 main）

中文安装步骤及 Embedding Key 示例见 [安装指南](../INSTALL_CN.md)。这里只存数据库 URL；Embedding 配置在 `MemoryCore/tdai-gateway.postgres.yaml`，密钥在运行时环境。根 Compose 只启动 Core / 可选 Knowledge，不含 Panel / Proxy。

# Database configuration

All four services and their PostgreSQL migration commands read **`config/db.toml`**.

```sh
cp config/db.example.toml config/db.toml
chmod 600 config/db.toml
# Edit the URL and optional per-module overrides. Never commit this file.
```

`[postgres].url` is shared. `[core].url`, `[knowledge].url`, `[panel].url` and
`[proxy].url` override it for that module. `[core].metadata_url` optionally selects
another database for Core metadata; otherwise metadata shares Core's URL. The Core
SQLite import intentionally uses a single target database for atomic migration.
Use a single URL during that import and split databases only with a separately
planned, verified migration.

The file uses standard TOML (smol-toml), not shell syntax. Put a literal
PostgreSQL URL in it; `${VARIABLE}` interpolation is deliberately not supported.
Percent-encode reserved characters in credentials. Use a certificate-verified TLS
connection for a remote database; weak `sslmode=allow/prefer/no-verify` settings
are rejected. Protect config files, environment variables and database backups.

## Location and precedence

- Starting from the repository root: `./config/db.toml`.
- Starting from `MemoryCore`, `MemoryKnowledge`, `MemoryPanel` or `MemoryProxy`:
  `../config/db.toml`. There is no unbounded ancestor-directory search.
- Standalone packages or other working directories: `./config/db.toml`.
- To use an explicit location, set `AGENTMEMORY_DB_CONFIG=/absolute/path/db.toml`.
  A missing or unreadable explicitly selected file is an error.
- An existing malformed file, unknown section/field, wrong value type or invalid
  URL is a startup error. Errors never print the connection value or parser input.
- TOML is authoritative. A conflicting legacy module URL, `DATABASE_URL`, YAML
  database URL or explicitly selected non-PG backend fails startup. Remove old
  duplicate settings. Matching values are accepted.
- Intentional temporary environment override: `AGENTMEMORY_DB_OVERRIDE=env`.
  The module-specific URL then wins over `DATABASE_URL` and TOML. An explicitly
  selected missing/malformed TOML file still fails; this is not a repair bypass.
- If the optional default file is absent, existing environment/YAML configuration
  continues to work. Existing Tencent/Mongo/SQLite/COS modes remain available.

A TOML URL selects PostgreSQL for that module. Core also defaults pipeline state
to PostgreSQL, profile files to rowfs, and other object files to PostgreSQL. An
explicitly conflicting storage setting is still rejected by gateway validation.
Embedding endpoint/model/dimensions/key and LLM authorization are separate from
this database file. No model is loaded or called by this configuration loader.

## Containers and packaged installs

Mount the private file read-only at `/app/config/db.toml` and set
`AGENTMEMORY_DB_CONFIG=/app/config/db.toml` in **each** container. The root
`docker-compose.postgres.yaml` does this for Core and Knowledge. In that example,
use the service hostname `postgres` in the file instead of `127.0.0.1`; the server's
`POSTGRES_PASSWORD` must agree with the URL. Panel/Proxy use the same mount and
variable in their existing deployment. The database itself is not exposed.

The loader is authored once at `config/db-loader.ts`. Run
`node scripts/sync-db-config.mjs` after changes. Checked-in identical copies in
module `src/` directories let independent Docker, npm and TypeScript builds work
without depending on a monorepo parent directory. CI runs the `--check` form and
module configuration/parse tests to prevent drift. Never copy `db.toml` into images.

A URL-only `AGENTMEMORY_DB_OVERRIDE=env` keeps PostgreSQL selected when TOML
is present. Duplicate query parameters, `ssl`, and `uselibpqcompat` are rejected
to prevent driver-specific TLS downgrade surprises. Use the documented `sslmode`
settings; for remote databases prefer `verify-full`.
