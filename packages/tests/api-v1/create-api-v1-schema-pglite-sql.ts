import { afterAll, beforeAll } from 'vitest';

import { readApiV1InMemorySchemaSql } from '../../../apps/api-v1/src/db/in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient, PGlite, type PGliteSql } from '../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

let template: Promise<PGlite> | undefined;

/**
 * Registers the hooks of the calling file or suite: a `beforeAll` that builds the template, so its start-up and schema
 * are paid once before the tests instead of inside the first test that needs a database, and an `afterAll` that
 * closes it. Call it where the suite hands out a database; without it, the first clone builds the template.
 */
export function initApiV1SchemaPGliteTemplate(): void {
    beforeAll(async () => {
        await readTemplate();
    });
    afterAll(async () => {
        const closing = template;
        template = undefined;
        await (await closing)?.close();
    });
}

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
    await raw.exec(await readApiV1InMemorySchemaSql());
    return raw;
}
