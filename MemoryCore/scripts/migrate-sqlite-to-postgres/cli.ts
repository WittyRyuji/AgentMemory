import { loadDatabaseConfig } from "../../src/db-config.js";
import { parseArgs } from "node:util";
import { PostgresDatabase } from "../../src/core/store/postgres/client.js";
import { migrateSqliteToPostgres } from "./migrate.js";
const { values } = parseArgs({
  options: {
    "memory-sqlite": { type: "string" },
    "metadata-sqlite": { type: "string" },
    "files-root": { type: "string" },
    instance: { type: "string" },
    provider: { type: "string", default: "openai" },
    model: { type: "string" },
    dimensions: { type: "string" },
    apply: { type: "boolean", default: false },
    "without-vectors": { type: "boolean", default: false },
    "profile-team": { type: "string" },
    "profile-agent": { type: "string" },
  },
});
let target: PostgresDatabase | undefined;
try {
  if (values.apply)
    target = PostgresDatabase.connect(
      loadDatabaseConfig("core").url ?? "",
      values.instance ?? "",
    );
  const report = await migrateSqliteToPostgres(
    {
      memorySqlite: values["memory-sqlite"],
      metadataSqlite: values["metadata-sqlite"],
      filesRoot: values["files-root"],
      instanceId: values.instance ?? "",
      provider: values.provider!,
      model: values.model ?? "",
      dimensions: Number(values.dimensions),
      apply: values.apply,
      withoutVectors: values["without-vectors"],
      profileIsolation: {
        teamId: values["profile-team"],
        agentId: values["profile-agent"],
      },
    },
    target,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
} finally {
  await target?.close();
}
