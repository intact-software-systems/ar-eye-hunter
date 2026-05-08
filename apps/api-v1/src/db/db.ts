import type { Sql } from 'postgres';
import postgres from 'postgres';

let sqlInstance: Sql | undefined;

export function getSql(): Sql {
    if (sqlInstance) {
        return sqlInstance;
    }

    sqlInstance = postgres(
        readPostgresConnectionUrl(),
        {
            max: 5, // pool size
            idle_timeout: 20,
        },
    );

    return sqlInstance;
}

export function readPostgresConnectionUrl(): string {
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL missing');
    }

    return toPostgresJsConnectionUrl(databaseUrl);
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
