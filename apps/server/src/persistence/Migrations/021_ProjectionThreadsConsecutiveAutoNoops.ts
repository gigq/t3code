import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (columns.some((column) => column.name === "consecutive_auto_noops")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN consecutive_auto_noops INTEGER NOT NULL DEFAULT 0
  `;
});
