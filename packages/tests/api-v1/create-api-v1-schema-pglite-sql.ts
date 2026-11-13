import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll } from 'vitest';

import { API_V1_IN_MEMORY_SCHEMA_URL } from '../../../apps/api-v1/src/db/in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient, PGlite, type PGliteSql } from '../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

let template: Promise<PGlite> | undefined;

// Registered by importing this module: the template's start-up and schema are paid once per test file, before its
// tests, instead of inside the body of every test that needs a database.
beforeAll(async () => {
    await readTemplate();
});

afterAll(async () => {
    await (await template)?.close();
});

/**
 * A private PGlite database holding the API-v1 in-memory schema, cloned from the template of this test file's worker.
 * Vitest isolation gives each test file its own worker, so no state outlives the file. The caller closes the clone.
 */
export async function createApiV1SchemaPGliteSql(): Promise<PGliteSql> {
    const clone = await (await readTemplate()).clone();
    // PGlite declares clone() as its interface; the instance it returns is a PGlite.
    if (!(clone instanceof PGlite)) {
        throw new TypeError('PGlite.clone() returned an instance that is not a PGlite');
    }
    return createPGliteSqlClient(clone);
}

function readTemplate(): Promise<PGlite> {
    template ??= createApiV1SchemaTemplate();
    return template;
}

async function createApiV1SchemaTemplate(): Promise<PGlite> {
    const raw = new PGlite();
    await raw.exec(await readFile(API_V1_IN_MEMORY_SCHEMA_URL, 'utf8'));
    return raw;
}
