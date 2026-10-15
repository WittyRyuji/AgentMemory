# 共享数据库配置（当前 main）

中文安装步骤及 Embedding Key 示例见 [安装指南](../INSTALL_CN.md)。这里只存数据库地址和环境变量引用，密码只放根 `.env` / 运行时秘密管理器；Embedding 配置在 `MemoryCore/tdai-gateway.postgres.yaml`，密钥在运行时环境。根目录有五份单服务 Compose，PostgreSQL、Core、Panel、Proxy、Knowledge 各自独立启停。

# Database configuration

All four services and their PostgreSQL migration commands read **`config/db.toml`**.

```sh
cp config/db.example.toml config/db.toml
chmod 600 config/db.toml
# Edit the password-free URL and environment references. Never commit private files.
```

`[postgres].url` is shared. `[core].url`, `[knowledge].url`, `[panel].url` and
`[proxy].url` override it for that module. `[core].metadata_url` optionally selects
another database for Core metadata; otherwise metadata shares Core's URL. The Core
SQLite import intentionally uses a single target database for atomic migration.
Use a single URL during that import and split databases only with a separately
planned, verified migration.

## Secrets are supplied through the environment

Recommended shared configuration (also used by all five root Compose files):

```toml
[postgres]
url = "postgresql://agentmemory@postgres:5432/agentmemory"
password_env = "POSTGRES_PASSWORD"
```

Copy root `.env.example` to `.env`, restrict it with `chmod 600`, and fill
`POSTGRES_PASSWORD` once with the **raw**, unencoded password. The loader reads
that process environment variable and percent-encodes it exactly once. Passwords
containing `@`, `:`, `/`, `%`, Unicode or spaces do not need manual URL encoding.
Use single-quoted `.env` values to preserve literal `$` and `#`; for embedded
quotes use the specific environment parser's quoting rules or a secret manager.
Never shell-evaluate an untrusted environment file.

Alternatively, a section can use `url_env = "MY_DATABASE_URL"` for a complete
runtime-supplied URL. `[core].metadata_url_env` supplies a separate metadata URL.
A complete URL must already percent-encode credentials. Do not combine `url_env`
with `url`/`password_env`, or `metadata_url_env` with `metadata_url`.
`password_env` requires a URL containing a username and **no password**.
Module overrides replace the whole shared connection, including its password
reference: put both `url` and `password_env` in that module's section, or use
`url_env`. A selected missing/empty environment reference fails closed, even with
`AGENTMEMORY_DB_OVERRIDE=env`; reference names must be plain environment names.
Only selected shared/module connections are resolved, so unrelated modules need
not receive another module's secrets. All sections are syntax/schema validated.

Legacy literal `url` / `metadata_url` values still work for compatibility, but
storing passwords there is no longer the recommended workflow. The file uses
standard TOML (smol-toml); there is no shell evaluation or `${VARIABLE}` expansion.
Use certificate-verified TLS for remote databases; weak
`sslmode=allow/prefer/no-verify` settings are rejected. Protect configuration,
environment variables and backups; `.env` is plaintext storage, not encryption.

### Native startup

The database loader reads **process.env**, not `.env` files. From a module folder,
use Node 22.18+ with `node --env-file=../.env --import tsx <entrypoint.ts>`
(`tsx/esm` for Proxy), or inject variables through your service manager. For
Panel settings add `--env-file=.env` after the root file; keep database passwords
only in the root file. Existing exported variables take precedence over Node's
environment files. Plain `npm run` does not automatically load the root `.env`.
Use a host-reachable database URL for native processes. The same explicit loading
is required for migration and OAuth CLI commands; see the installation guide.

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
  selected missing/malformed TOML file or unresolved reference still fails; this is not a repair bypass.
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
`docker-compose.core.yaml`, `docker-compose.panel.yaml`,
`docker-compose.proxy.yaml`, and `docker-compose.knowledge.yaml` each do this.
All five separate Compose projects join the external `agentmemory` network;
use the service hostname `postgres` in the file instead of `127.0.0.1`; all five files explicitly pass the same root `.env` `POSTGRES_PASSWORD` to their
container. Compose `.env` interpolation alone does not export variables to containers.
Custom `url_env` / metadata references must likewise be explicitly passed through
the relevant service environment. The database itself is not exposed.
The Proxy runtime UID 10001 must be able to read its bind-mounted configuration;
use narrowly scoped file permissions / ACLs, not world-readable credentials.
Existing installations must select their confirmed old database volume using
`POSTGRES_VOLUME` before starting the new layout. See the installation guide.

The loader is authored once at `config/db-loader.ts`. Run
`node scripts/sync-db-config.mjs` after changes. Checked-in identical copies in
module `src/` directories let independent Docker, npm and TypeScript builds work
without depending on a monorepo parent directory. CI runs the `--check` form and
module configuration/parse tests to prevent drift. Never copy `db.toml` into images.

A URL-only `AGENTMEMORY_DB_OVERRIDE=env` keeps PostgreSQL selected when TOML
is present. Duplicate query parameters, `ssl`, and `uselibpqcompat` are rejected
to prevent driver-specific TLS downgrade surprises. Use the documented `sslmode`
settings; for remote databases prefer `verify-full`.
