import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* Effect.ignore(
    sql`
      ALTER TABLE projection_projects
      ADD COLUMN location_json TEXT NOT NULL DEFAULT '{"kind":"local"}'
    `,
  );

  yield* sql`
    UPDATE projection_projects
    SET location_json = '{"kind":"local"}'
    WHERE location_json IS NULL OR TRIM(location_json) = ''
  `;
});
