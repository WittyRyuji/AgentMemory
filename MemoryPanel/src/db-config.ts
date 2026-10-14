/** Generated from config/db-loader.ts. Run node scripts/sync-db-config.mjs after edits.
 * Kept inside each independently shipped module so Docker/npm builds need no parent tree.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { parse } from "smol-toml";

export type DbModule = "core" | "knowledge" | "panel" | "proxy";
export interface DatabaseConfig {
  url?: string;
  metadataUrl?: string;
  fromFile: boolean;
  envOverride?: boolean;
}
const MODULE_DIRS = [
  "MemoryCore",
  "MemoryKnowledge",
  "MemoryPanel",
  "MemoryProxy",
];
const ENV_NAMES = {
  core: "TDAI_POSTGRES_URL",
  knowledge: "KNOWLEDGE_POSTGRES_URL",
  panel: "PANEL_POSTGRES_URL",
  proxy: "PROXY_POSTGRES_URL",
} as const;

function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid database configuration table");
  return value as Record<string, unknown>;
}
function url(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error("Database URL must be a nonempty string");
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2
    )
      throw new Error();
    // Avoid driver defaults that weaken TLS verification. Local socket/host TLS remains optional.
    // pg-connection-string applies the LAST duplicate parameter, unlike URLSearchParams.get.
    // Disallow ambiguous options and the libpq compatibility switch that weakens `require`.
    const seen = new Set<string>();
    for (const [key] of parsed.searchParams) {
      if (seen.has(key)) throw new Error();
      seen.add(key);
    }
    if (
      parsed.searchParams.has("uselibpqcompat") ||
      parsed.searchParams.has("ssl")
    )
      throw new Error();
    const sslmode = parsed.searchParams.get("sslmode");
    if (
      sslmode !== null &&
      !["disable", "require", "verify-ca", "verify-full"].includes(sslmode)
    )
      throw new Error();
  } catch {
    throw new Error(
      "Invalid PostgreSQL URL in database configuration (value redacted)",
    );
  }
  return value;
}

/** TOML is authoritative. Conflicting legacy URL values fail unless the operator explicitly
 * sets AGENTMEMORY_DB_OVERRIDE=env. Missing optional default file retains legacy behavior.
 * No ancestor walk: use CWD/config/db.toml, or repo/config/db.toml from a module directory.
 */
export function loadDatabaseConfig(
  module: DbModule,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): DatabaseConfig {
  const explicit = env.AGENTMEMORY_DB_CONFIG?.trim();
  const file = explicit
    ? resolve(cwd, explicit)
    : resolve(
        MODULE_DIRS.includes(basename(cwd)) ? dirname(cwd) : cwd,
        "config/db.toml",
      );
  let document: Record<string, unknown> | undefined;
  if (explicit || existsSync(file)) {
    try {
      document = table(parse(readFileSync(file, "utf8")));
    } catch {
      throw new Error(
        "Cannot read or parse config/db.toml; database configuration was not applied (details redacted)",
      );
    }
    for (const key of Object.keys(document)) {
      if (!["postgres", "core", "knowledge", "panel", "proxy"].includes(key))
        throw new Error("Unknown database configuration section");
      const section = table(document[key]);
      for (const field of Object.keys(section)) {
        if (field !== "url" && !(key === "core" && field === "metadata_url"))
          throw new Error("Unknown database configuration field");
        url(section[field]);
      }
    }
  }
  const shared = document?.postgres ? table(document.postgres) : {};
  const specific = document?.[module] ? table(document[module]) : {};
  const configured = url(specific.url ?? shared.url);
  const metadata =
    module === "core" ? (url(specific.metadata_url) ?? configured) : undefined;
  const override = env.AGENTMEMORY_DB_OVERRIDE;
  if (override && override !== "env")
    throw new Error("AGENTMEMORY_DB_OVERRIDE must be env or unset");
  const legacy =
    env[ENV_NAMES[module]]?.trim() || env.DATABASE_URL?.trim() || undefined;
  const legacyMeta =
    module === "core"
      ? env.TDAI_METADATA_POSTGRES_URL?.trim() || undefined
      : undefined;
  if (
    override !== "env" &&
    ((configured && legacy && configured !== legacy) ||
      (metadata && legacyMeta && metadata !== legacyMeta))
  ) {
    throw new Error(
      "Database URL conflict: update config/db.toml or explicitly set AGENTMEMORY_DB_OVERRIDE=env (values redacted)",
    );
  }
  return {
    url: override === "env" ? (legacy ?? configured) : (configured ?? legacy),
    metadataUrl:
      override === "env"
        ? (legacyMeta ?? legacy ?? metadata)
        : (metadata ?? legacyMeta),
    // File presence selects PostgreSQL even when the operator overrides only its URL.
    fromFile: !!configured,
    ...(override === "env" ? { envOverride: true } : {}),
  };
}

/** An explicitly contradictory backend must not silently win over TOML. */
export function databaseBackend(
  config: DatabaseConfig,
  explicit: string | undefined,
  fallback: string,
): string {
  if (config.fromFile && explicit && explicit !== "postgres")
    throw new Error("Database backend conflicts with config/db.toml");
  return config.fromFile ? "postgres" : explicit || fallback;
}
