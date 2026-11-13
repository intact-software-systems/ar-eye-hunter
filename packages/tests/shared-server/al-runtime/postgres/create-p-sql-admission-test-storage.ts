import { onTestFinished } from 'vitest';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import type { PGliteSql } from '../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createApiV1SchemaPGliteSql } from '../../../api-v1/create-api-v1-schema-pglite-sql.ts';

export interface PSqlAdmissionTestStorage {
    readonly sql: PGliteSql;
    readonly repository: PSqlRuntimeStateRepository;
}

export async function createPSqlAdmissionTestStorage(): Promise<PSqlAdmissionTestStorage> {
    const storage = await createClosablePSqlAdmissionTestStorage();
    onTestFinished(() => storage.sql.close());
    return storage;
}

export async function createClosablePSqlAdmissionTestStorage(): Promise<PSqlAdmissionTestStorage> {
    const sql = await createApiV1SchemaPGliteSql();
    return { sql, repository: new PSqlRuntimeStateRepository(sql) };
}
