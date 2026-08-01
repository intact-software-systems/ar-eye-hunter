import { PGlite } from '@electric-sql/pglite';
import {
  collectApiV1StateWriteEvidenceFromSql,
} from '../../../../packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts';
import { createPGliteSqlClient } from './pglite-sql-adapter.ts';

if (import.meta.main) {
  const [snapshotPath, inputJson] = Deno.args;
  if (!snapshotPath || !inputJson) {
    throw new Error('Usage: read-pglite-black-box-evidence.ts <snapshot-path> <evidence-json>');
  }
  const snapshot = new Blob([await Deno.readFile(snapshotPath)]);
  const database = new PGlite({ loadDataDir: snapshot });
  const sql = createPGliteSqlClient(database);
  try {
    const evidence = await collectApiV1StateWriteEvidenceFromSql(
      JSON.parse(inputJson),
      sql,
    );
    console.log(JSON.stringify(evidence));
  } finally {
    await sql.close();
  }
}
