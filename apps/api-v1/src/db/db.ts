import { PGlite } from '@electric-sql/pglite';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import {
    type ApiV1DatabaseBackendConfig,
    readApiV1DatabaseBackendConfig,
    requirePostgresDatabaseUrl,
    resolvePGliteDataDir,
} from './database-config.ts';
import { bootstrapApiV1InMemorySchemaIfNeeded } from './in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient, type PGliteSql } from './pglite-sql-adapter.ts';

export type ApiV1Sql = Sql | PSqlSql;

let sqlInstance: ApiV1Sql | undefined;

export function getSql(): ApiV1Sql {
    if (sqlInstance) {
        return sqlInstance;
    }

    sqlInstance = createApiV1SqlClient(readApiV1DatabaseBackendConfig());
    return sqlInstance;
}

export function createApiV1SqlClient(config: ApiV1DatabaseBackendConfig): ApiV1Sql {
    if (config.sqlBackend === 'postgres') {
        return postgres(
            readPostgresConnectionUrl(config),
            {
                max: 5, // pool size
                idle_timeout: 20,
            },
        );
    }

    return createApiV1PGliteSqlClient(config);
}

export function createApiV1PGliteSqlClient(
    config: ApiV1DatabaseBackendConfig,
): PGliteSql {
    const pglite = new PGlite(resolvePGliteDataDir(config));
    return createPGliteSqlClient(pglite, {
        ready: bootstrapApiV1InMemorySchemaIfNeeded(pglite, config),
    });
}

export function readPostgresConnectionUrl(
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig(),
): string {
    return toPostgresJsConnectionUrl(requirePostgresDatabaseUrl(config));
}

export function toPostgresJsConnectionUrl(databaseUrl: string): string {
    const url = new URL(databaseUrl);
    const schema = url.searchParams.get('schema');
    if (!schema) {
        return databaseUrl;
    }

    url.searchParams.delete('schema');
    if (!url.searchParams.has('search_path')) {
        url.searchParams.set('search_path', schema);
    }

    return url.toString();
}

export const sql = new Proxy(
    function sqlProxy() {
    },
    {
        apply(_target, thisArg, argArray) {
            return Reflect.apply(
                getSql() as unknown as (...args: unknown[]) => unknown,
                thisArg,
                argArray,
            );
        },
        get(_target, prop) {
            const instance = getSql() as unknown as Record<PropertyKey, unknown>;
            const value = Reflect.get(instance, prop, instance);
            return typeof value === 'function' ? value.bind(instance) : value;
        },
    },
) as unknown as Sql;
