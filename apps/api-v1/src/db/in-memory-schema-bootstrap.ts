import {
  type ApiV1DatabaseBackendConfig,
  readApiV1DatabaseBackendConfig,
  resolvePGliteSchemaInitMode,
} from './database-config.ts';

export type InMemorySqlSchemaClient = Readonly<{
  exec(sql: string): Promise<unknown>;
}>;

export const API_V1_IN_MEMORY_SCHEMA_URL = new URL(
  './in-memory-schema.sql',
  import.meta.url,
);

export async function readApiV1InMemorySchemaSql(): Promise<string> {
  return await Deno.readTextFile(API_V1_IN_MEMORY_SCHEMA_URL);
}

export async function applyApiV1InMemorySchema(
  client: InMemorySqlSchemaClient,
  schemaSql?: string,
): Promise<void> {
  await client.exec(schemaSql ?? await readApiV1InMemorySchemaSql());
}

export async function bootstrapApiV1InMemorySchemaIfNeeded(
  client: InMemorySqlSchemaClient,
  config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig(),
): Promise<boolean> {
  if (config.sqlBackend !== 'pglite-memory' && config.sqlBackend !== 'pglite-file') {
    return false;
  }

  if (resolvePGliteSchemaInitMode(config) === 'disabled') {
    return false;
  }

  await applyApiV1InMemorySchema(client);
  return true;
}
