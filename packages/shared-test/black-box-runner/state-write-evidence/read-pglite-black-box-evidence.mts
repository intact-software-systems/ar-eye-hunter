import { readFile } from 'node:fs/promises';

import { createPGliteSqlClient, PGlite } from '../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { collectApiV1StateWriteEvidenceFromSql } from '../api-v1-state-write-evidence.ts';

// Runs under `bun run`: opening a PGlite snapshot needs the API's
// own SQL adapter, while the evidence rules belong to the black-box runner. Keeping the bridge here
// means the dependency points from the test runner at the app it exercises, never the reverse.
if (import.meta.main) {
    const [snapshotPath, inputJson] = process.argv.slice(2);
    if (!snapshotPath || !inputJson) {
        throw new Error('Usage: read-pglite-black-box-evidence.ts <snapshot-path> <evidence-json>');
    }
    const snapshot = new Blob([await readFile(snapshotPath)]);
    const database = new PGlite({ loadDataDir: snapshot });
    const sql = createPGliteSqlClient(database);
    try {
        const evidence = await collectApiV1StateWriteEvidenceFromSql(
            JSON.parse(inputJson),
            sql
        );
        console.log(JSON.stringify(evidence));
    }
    finally {
        await sql.close();
    }
}
