import { afterAll } from "vitest";
import { TestPostgresPool } from "./test-pool.js";
import { PostgresDatabase, instanceSchema } from "./client.js";
import { PostgresStorageBackend } from "../../storage/postgres-backend.js";
import { runStorageBackendContract } from "../../storage/__contract__/storage-backend.contract.js";
const pool = new TestPostgresPool();
let number = 0;
afterAll(() => pool.end());
runStorageBackendContract("PostgreSQL", async () => {
  const db = new PostgresDatabase(pool, instanceSchema(`objects-${++number}`));
  return { backend: new PostgresStorageBackend(db), cleanup: () => db.drop() };
});
