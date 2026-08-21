import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

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
    return postgres.default(databaseUrl, {
        max: maxConnections,
        idle_timeout: 1
    }) as unknown as PostgresSql;
}

export function createLifecycleSql(
    query: () => Promise<unknown>,
    end: () => Promise<void>
): PostgresSql {
    return Object.assign(() => query(), { end }) as unknown as PostgresSql;
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
        await cleanupRuntimeState(namespace, clients[0], clients, hasPrimaryFailure);
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

async function cleanupRuntimeState(
    namespace: string,
    cleanupSql: PostgresSql | undefined,
    clients: readonly PostgresSql[],
    hasPrimaryFailure: boolean
): Promise<void> {
    const failures: unknown[] = [];
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
            failures.push(deleteResult.reason);
        }
    }

    const closeResults = await Promise.allSettled(clients.map(async (client) => await client.end()));
    for (const closeResult of closeResults) {
        if (closeResult.status === 'rejected') {
            failures.push(closeResult.reason);
        }
    }
    if (!hasPrimaryFailure && failures.length > 0) {
        throw new AggregateError(
            failures,
            'Failed to clean up Postgres runtime-state integration resources.'
        );
    }
}
