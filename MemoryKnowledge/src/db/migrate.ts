import { loadDatabaseConfig } from "../db-config.js";
import "dotenv/config";
import { createDb } from "./client.js";

try {
  const { raw } = await createDb({
    connectionString:
      loadDatabaseConfig("knowledge").url ?? "",
  });
  await raw.end();
  console.log("Knowledge PostgreSQL schema ready");
} catch {
  console.error(
    "Knowledge PostgreSQL migration failed; check connection settings and database permissions",
  );
  process.exitCode = 1;
}
