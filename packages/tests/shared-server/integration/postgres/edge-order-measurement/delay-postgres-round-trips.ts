import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { createPostgresSqlCall } from '../test-support/create-postgres-sql-call.ts';

/** How many round trips one run's instances made: the denominator-free cost a message is reported against. */
export interface PostgresRoundTripCount {
    statements: number;
    transactions: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A database that is `delayMs` away: every statement, and every transaction's BEGIN and COMMIT, waits that long
 * before it runs. Counts the statements and transactions as they are issued. Forwards a client's `savepoint`.
 */
export function delayPostgresRoundTrips(source: PSqlSql, delayMs: number, count: PostgresRoundTripCount): PSqlSql {
    const delayed = createPostgresSqlCall(
        source,
        async <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result> => {
            count.statements += 1;
            await sleep(delayMs);
            return await source<Result>(strings, ...values);
        }
    );
    const within = async <T>(open: PSqlSql['begin'], write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
        await sleep(delayMs);
        const result = await open(async (inner) => await write(delayPostgresRoundTrips(inner, delayMs, count)));
        await sleep(delayMs);
        return result;
    };
    const savepoint = (source as Partial<{ savepoint: PSqlSql['begin']; }>).savepoint;
    return Object.assign(delayed, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            count.transactions += 1;
            return await within(source.begin.bind(source), write);
        },
        ...(savepoint === undefined ? {} : {
            savepoint: async <T>(write: (inner: PSqlSql) => Promise<T>): Promise<T> => await within(savepoint.bind(source), write)
        })
    });
}
