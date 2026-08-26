import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { toPSqlSql } from '../../integration/postgres/test-support/postgres-sql-adapter.ts';

export type PostgresSql =
    & PSqlSql
    & Readonly<{
        end(): Promise<void>;
    }>;

export async function createRuntimeStatePostgresSql(
    databaseUrl: string,
    maxConnections = 1
): Promise<PostgresSql> {
    const postgres = await import('postgres');
    const rawSql = postgres.default(databaseUrl, {
        max: maxConnections,
        idle_timeout: 1
    });
    return Object.assign(toPSqlSql(rawSql), {
        end: async (): Promise<void> => await rawSql.end()
    });
}

export function createLifecycleSql(
    query: () => Promise<PSqlRows>,
    end: () => Promise<void>
): PostgresSql {
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ): object | Promise<Result> {
        if (!('raw' in stringsOrValues)) {
            return { values: stringsOrValues };
        }
        return query().then((rows) => rows as Result);
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Lifecycle SQL does not run transactions');
        },
        end
    });
}

export async function withPostgresClients<T>(
    namespace: string,
    clientCount: number,
    createClient: () => Promise<PostgresSql>,
    run: (clients: readonly PostgresSql[]) => Promise<T>
): Promise<T> {
    const clients: PostgresSql[] = [];
    let hasPrimaryFailure = false;

    try {
        for (let index = 0; index < clientCount; index += 1) {
            clients.push(await createClient());
        }
        return await run(clients);
    }
    catch (error) {
        hasPrimaryFailure = true;
        throw error;
    }
    finally {
        await cleanupRuntimeState({ namespace, cleanupSql: clients[0], clients, hasPrimaryFailure });
    }
}

export function requirePostgresClient(clients: readonly PostgresSql[], index: number): PostgresSql {
    const client = clients[index];
    if (!client) {
        throw new Error(`Expected Postgres client at index ${index}.`);
    }
    return client;
}

export function requirePostgresDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}

interface CleanupRuntimeStateInput {
    readonly namespace: string;
    readonly cleanupSql: PostgresSql | undefined;
    readonly clients: readonly PostgresSql[];
    readonly hasPrimaryFailure: boolean;
}

async function cleanupRuntimeState(input: CleanupRuntimeStateInput): Promise<void> {
    const { namespace, cleanupSql, clients, hasPrimaryFailure } = input;
    const failures: Error[] = [];
    if (cleanupSql) {
        const [deleteResult] = await Promise.allSettled([
            Promise.resolve().then(
                () =>
                    cleanupSql`
          delete from runtime_state_store
          where store_namespace = ${namespace}
        `
            )
        ]);
        if (deleteResult?.status === 'rejected') {
            failures.push(toError(deleteResult.reason));
        }
    }

    const closeResults = await Promise.allSettled(clients.map(async (client) => await client.end()));
    for (const closeResult of closeResults) {
        if (closeResult.status === 'rejected') {
            failures.push(toError(closeResult.reason));
        }
    }
    if (!hasPrimaryFailure && failures.length > 0) {
        throw new AggregateError(
            failures,
            'Failed to clean up Postgres runtime-state integration resources.'
        );
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
