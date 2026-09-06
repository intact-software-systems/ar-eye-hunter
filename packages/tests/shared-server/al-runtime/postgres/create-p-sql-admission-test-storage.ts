import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { onTestFinished } from 'vitest';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { API_V1_IN_MEMORY_SCHEMA_URL } from '../../../../../apps/api-v1/src/db/in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient, type PGliteSql } from '../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

export interface PSqlAdmissionTestStorage {
    readonly sql: PGliteSql;
    readonly repository: PSqlRuntimeStateRepository;
}

export async function createPSqlAdmissionTestStorage(): Promise<PSqlAdmissionTestStorage> {
    const sql = createPGliteSqlClient(new PGlite());
    onTestFinished(() => sql.close());
    await sql.exec(await readFile(API_V1_IN_MEMORY_SCHEMA_URL, 'utf8'));
    return { sql, repository: new PSqlRuntimeStateRepository(sql) };
}
