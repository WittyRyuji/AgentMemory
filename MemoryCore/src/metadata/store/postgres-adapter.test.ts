import { afterAll } from "vitest";
import {
  PostgresDatabase,
  instanceSchema,
} from "../../core/store/postgres/client.js";
import { TestPostgresPool } from "../../core/store/postgres/test-pool.js";
import { PostgresMetadataStore } from "./postgres-adapter.js";
import { runMetadataStoreContract } from "./metadata-store.contract.js";
const pool = new TestPostgresPool();
let db: PostgresDatabase;
let sequence = 0;
runMetadataStoreContract(
  "PostgreSQL",
  async () => {
    db = new PostgresDatabase(
      pool,
      instanceSchema(`test-${sequence++}`, "metadata"),
    );
    return new PostgresMetadataStore(db);
  },
  async (store) => {
    await store.close();
    await db.drop();
  },
);
afterAll(() => pool.end());
