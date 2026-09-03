import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';

export interface ApiV1SchemaBootstrapConfiguration {
    readonly mode: ApiV1DatabaseConfiguration['mode'];
    readonly schemaInitialization: ApiV1DatabaseConfiguration['schemaInitialization'];
}

export type InMemorySqlSchemaClient = Readonly<{
    exec(sql: string): Promise<unknown>;
}>;

export const API_V1_IN_MEMORY_SCHEMA_URL = new URL(
    './in-memory-schema.sql',
    import.meta.url
);
/**
 * The migrations a PGlite data directory replays after the base schema: the
 * scoped-queue-key upgrade and the data backfills that later readers require.
 * Every file guards its own rows, so replaying on each boot is idempotent.
 */
export const API_V1_PGLITE_SCHEMA_UPGRADE_URLS: readonly URL[] = [
    '../../prisma/migrations/20260714093000_resource_inbox_scoped_queue_keys/migration.sql',
    '../../prisma/migrations/20260902150000_coalesced_work_window_anchor/migration.sql',
    '../../prisma/migrations/20260902200000_connect_trigger_latch_settle/migration.sql'
].map((path) => new URL(path, import.meta.url));

export async function readApiV1InMemorySchemaSql(): Promise<string> {
    return await Deno.readTextFile(API_V1_IN_MEMORY_SCHEMA_URL);
}

export async function readApiV1PGliteSchemaUpgradeSql(): Promise<string> {
    const files = await Promise.all(API_V1_PGLITE_SCHEMA_UPGRADE_URLS.map((url) => Deno.readTextFile(url)));
    return files.join('\n');
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
    configuration: ApiV1SchemaBootstrapConfiguration
): Promise<boolean> {
    if (configuration.mode === 'postgres') {
        return false;
    }
    if (configuration.schemaInitialization === 'disabled') {
        return false;
    }

    await applyApiV1InMemorySchema(client);
    await applyApiV1PGliteSchemaUpgrade(client);
    return true;
}
