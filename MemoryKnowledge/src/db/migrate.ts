import "dotenv/config";
import { createDb } from "./client.js";

try {
  const { raw } = await createDb({
    connectionString:
      process.env.KNOWLEDGE_POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
  });
  await raw.end();
  console.log("Knowledge PostgreSQL schema ready");
} catch {
  console.error(
    "Knowledge PostgreSQL migration failed; check connection settings and database permissions",
  );
  process.exitCode = 1;
}
