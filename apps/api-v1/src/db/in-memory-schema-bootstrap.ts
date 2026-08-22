import {
    readApiV1DatabaseBackendConfig,
    resolvePGliteSchemaInitMode,
    type ApiV1DatabaseBackendConfig
} from './database-config.ts';

export type InMemorySqlSchemaClient = Readonly<{
    exec(sql: string): Promise<unknown>;
}>;

export const API_V1_IN_MEMORY_SCHEMA_URL = new URL(
    './in-memory-schema.sql',
    import.meta.url
);
export const API_V1_PGLITE_SCHEMA_UPGRADE_URL = new URL(
    '../../prisma/migrations/20260714093000_resource_inbox_scoped_queue_keys/migration.sql',
    import.meta.url
);

export async function readApiV1InMemorySchemaSql(): Promise<string> {
    return await Deno.readTextFile(API_V1_IN_MEMORY_SCHEMA_URL);
}

export async function readApiV1PGliteSchemaUpgradeSql(): Promise<string> {
    return await Deno.readTextFile(API_V1_PGLITE_SCHEMA_UPGRADE_URL);
}

export async function applyApiV1InMemorySchema(
    client: InMemorySqlSchemaClient,
    schemaSql?: string
): Promise<void> {
    await client.exec(schemaSql ?? await readApiV1InMemorySchemaSql());
}

export async function applyApiV1PGliteSchemaUpgrade(
    client: InMemorySqlSchemaClient
): Promise<void> {
    await client.exec(await readApiV1PGliteSchemaUpgradeSql());
}

export async function bootstrapApiV1InMemorySchemaIfNeeded(
    client: InMemorySqlSchemaClient,
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): Promise<boolean> {
    if (config.sqlBackend !== 'pglite-memory' && config.sqlBackend !== 'pglite-file') {
        return false;
    }

    if (resolvePGliteSchemaInitMode(config) === 'disabled') {
        return false;
    }

    await applyApiV1InMemorySchema(client);
    await applyApiV1PGliteSchemaUpgrade(client);
    return true;
}
