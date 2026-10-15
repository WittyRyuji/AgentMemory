import { loadGatewayConfig } from "./gateway/config.js";
import { loadStoreConfig } from "./metadata/store/factory.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDatabaseConfig, databaseBackend } from "./db-config.js";
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "am-db-config-"));
  mkdirSync(join(cwd, "config"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const shared = "postgresql://user:p%40ss@localhost:5432/agentmemory";
function write(text: string) {
  writeFileSync(join(cwd, "config/db.toml"), text);
}
describe("shared database configuration", () => {
  it("preserves optional-file legacy settings", () => {
    expect(
      loadDatabaseConfig("core", { TDAI_POSTGRES_URL: shared }, cwd),
    ).toMatchObject({ url: shared, fromFile: false });
    expect(loadDatabaseConfig("panel", {}, cwd).url).toBeUndefined();
  });
  it("loads real TOML quoting, comments and module overrides", () => {
    write(
      `[postgres]\nurl = '${shared}' # comment\n[core]\nmetadata_url = "postgresql://meta/db"\n[panel]\nurl = "postgresql://panel/db"`,
    );
    expect(loadDatabaseConfig("core", {}, cwd)).toEqual({
      url: shared,
      metadataUrl: "postgresql://meta/db",
      fromFile: true,
    });
    expect(loadDatabaseConfig("knowledge", {}, cwd).url).toBe(shared);
    expect(loadDatabaseConfig("panel", {}, cwd).url).toBe(
      "postgresql://panel/db",
    );
    expect(loadDatabaseConfig("proxy", {}, cwd).url).toBe(shared);
  });
  it("finds repository config from module CWD without walking arbitrary ancestors", () => {
    write(`[postgres]\nurl = '${shared}'`);
    expect(loadDatabaseConfig("core", {}, join(cwd, "MemoryCore")).url).toBe(
      shared,
    );
    expect(
      loadDatabaseConfig("core", {}, join(cwd, "unrelated")).url,
    ).toBeUndefined();
  });
  it("supports an explicit mount path and fails if missing", () => {
    write(`[postgres]\nurl = '${shared}'`);
    expect(
      loadDatabaseConfig(
        "core",
        { AGENTMEMORY_DB_CONFIG: join(cwd, "config/db.toml") },
        "/tmp",
      ).url,
    ).toBe(shared);
    expect(() =>
      loadDatabaseConfig("core", { AGENTMEMORY_DB_CONFIG: "missing" }, cwd),
    ).toThrow("Cannot read or parse");
  });
  it.each([
    '[postgres\nurl="secret"',
    '[postgres]\nurl = "secret"',
    "[postgres]\nurl = 42",
    '[posgres]\nurl = "postgresql://a/db"',
    '[postgres]\npassword="secret"',
    '[postgres]\nurl="postgresql://a/db?sslmode=no-verify"',
  ])(
    "rejects malformed/unknown configuration without exposing values: %s",
    (text) => {
      write(text);
      try {
        loadDatabaseConfig("core", {}, cwd);
        throw new Error("expected failure");
      } catch (err) {
        expect(String(err)).not.toContain("secret");
        expect(String(err)).not.toContain("expected failure");
      }
    },
  );
  it("rejects mismatched legacy URLs and permits explicit env override", () => {
    write(`[postgres]\nurl = '${shared}'`);
    expect(() =>
      loadDatabaseConfig(
        "proxy",
        { DATABASE_URL: "postgresql://other/db" },
        cwd,
      ),
    ).toThrow("conflict");
    expect(
      loadDatabaseConfig("proxy", { DATABASE_URL: shared }, cwd).fromFile,
    ).toBe(true);
    expect(
      loadDatabaseConfig(
        "proxy",
        {
          DATABASE_URL: "postgresql://other/db",
          AGENTMEMORY_DB_OVERRIDE: "env",
        },
        cwd,
      ),
    ).toMatchObject({ url: "postgresql://other/db", fromFile: true });
    expect(() =>
      loadDatabaseConfig(
        "core",
        { TDAI_METADATA_POSTGRES_URL: "postgresql://other/db" },
        cwd,
      ),
    ).toThrow("conflict");
    expect(() =>
      loadDatabaseConfig("core", { AGENTMEMORY_DB_OVERRIDE: "typo" }, cwd),
    ).toThrow("OVERRIDE");
  });
  it("selects PG from TOML and rejects a conflicting explicit backend", () => {
    const config = { url: shared, fromFile: true };
    expect(databaseBackend(config, undefined, "sqlite")).toBe("postgres");
    expect(() => databaseBackend(config, "sqlite", "sqlite")).toThrow(
      "conflicts",
    );
    expect(databaseBackend({ fromFile: false }, undefined, "sqlite")).toBe(
      "sqlite",
    );
  });
});

it.each([false, true])("wires TOML into actual module configuration (env reference: %s)", (reference) => {
  write(reference
    ? `[postgres]\nurl = "postgresql://user@localhost:5432/agentmemory"\npassword_env = "SYNTHETIC_DB_PASSWORD"`
    : `[postgres]\nurl = '${shared}'`);
  vi.stubEnv("SYNTHETIC_DB_PASSWORD", "p@ss");
  vi.stubEnv("AGENTMEMORY_DB_CONFIG", join(cwd, "config/db.toml"));
  try {
    writeFileSync(join(cwd, "empty.yaml"), "{}");
    vi.stubEnv("TDAI_GATEWAY_CONFIG", join(cwd, "empty.yaml"));
    for (const key of [
      "STORE_MODE",
      "TDAI_POSTGRES_URL",
      "TDAI_METADATA_POSTGRES_URL",
      "TDAI_METADATA_MONGO_URI",
      "TDAI_METADATA_SQLITE_BASE_DIR",
      "DATABASE_URL",
      "AGENTMEMORY_DB_OVERRIDE",
    ])
      vi.stubEnv(key, "");
    vi.stubEnv("STORE_MODE", undefined);
    const config = loadGatewayConfig();
    expect(config.memory.postgres.url).toBe(shared);
    expect(config.memory.storeBackend).toBe("postgres");
    expect(config.stateBackend).toBe("postgres");
    expect(config.data.fileStore).toBe("rowfs");
    expect(config.metadata.store?.postgresUrl).toBe(shared);
    expect(loadStoreConfig().backend).toBe("postgres");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects duplicate TLS parameters and libpq verification bypasses", () => {
  for (const query of [
    "sslmode=verify-full&sslmode=no-verify",
    "sslmode=require&uselibpqcompat=true",
    "sslmode=unknown",
    "ssl=false",
  ]) {
    write(
      `[postgres]\nurl = "postgresql://owner:secret@db/agentmemory?${query}"`,
    );
    expect(() => loadDatabaseConfig("core", {}, cwd)).toThrow("redacted");
  }
});
it("keeps the PostgreSQL backend when only the TOML URL is overridden", () => {
  write(`[postgres]\nurl = '${shared}'`);
  const config = loadDatabaseConfig(
    "core",
    {
      AGENTMEMORY_DB_OVERRIDE: "env",
      TDAI_POSTGRES_URL: "postgresql://override/db",
    },
    cwd,
  );
  expect(config.url).toBe("postgresql://override/db");
  expect(databaseBackend(config, undefined, "sqlite")).toBe("postgres");
});

it("uses the explicit env URL override with an existing matching YAML and TOML URL", () => {
  write(`[postgres]\nurl = '${shared}'`);
  writeFileSync(
    join(cwd, "gateway.yaml"),
    `memory:\n  postgres:\n    url: "${shared}"\nmetadata:\n  store:\n    postgresUrl: "${shared}"\n`,
  );
  vi.stubEnv("AGENTMEMORY_DB_CONFIG", join(cwd, "config/db.toml"));
  vi.stubEnv("TDAI_GATEWAY_CONFIG", join(cwd, "gateway.yaml"));
  vi.stubEnv("AGENTMEMORY_DB_OVERRIDE", "env");
  vi.stubEnv("TDAI_POSTGRES_URL", "postgresql://override/db");
  for (const key of [
    "STORE_MODE",
    "DATABASE_URL",
    "TDAI_METADATA_POSTGRES_URL",
  ])
    vi.stubEnv(key, undefined);
  try {
    const config = loadGatewayConfig();
    expect(config.memory.storeBackend).toBe("postgres");
    expect(config.memory.postgres.url).toBe("postgresql://override/db");
    expect(config.metadata.store?.postgresUrl).toBe("postgresql://override/db");
    expect(config.stateBackend).toBe("postgres");
  } finally {
    vi.unstubAllEnvs();
  }
});
