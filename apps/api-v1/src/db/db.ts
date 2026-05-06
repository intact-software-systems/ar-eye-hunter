import type { Sql } from 'postgres';
import postgres from 'postgres';

let sqlInstance: Sql | undefined;

export function getSql(): Sql {
    if (sqlInstance) {
        return sqlInstance;
    }

    const DATABASE_URL = Deno.env.get('DATABASE_URL');
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL missing');
    }

    sqlInstance = postgres(
        DATABASE_URL,
        {
            max: 5, // pool size
            idle_timeout: 20,
        },
    );

    return sqlInstance;
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
