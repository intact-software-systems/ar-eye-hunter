import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { createDefaultBackgroundTimers, type Timers } from '@shared/resilience/timers.ts';
import { tryWith } from '@shared/resilience/try-with-policy.ts';

import type {
    ApiV1DatabaseConfiguration,
    ApiV1PGliteEvidenceConfiguration
} from '../configuration/api-v1-configuration.ts';
import { bootstrapApiV1InMemorySchemaIfNeeded } from './in-memory-schema-bootstrap.ts';
import {
    startPGliteBlackBoxSnapshotPublisher,
    type PGliteBlackBoxSnapshotPublisher
} from './pglite-black-box-evidence-snapshot.ts';
import { createPGliteSqlClient } from './pglite-sql-adapter.ts';
import { createPostgresSqlClient, type PostgresSqlClientSource } from './postgres-sql-adapter.ts';
import { PostgresStatementCensus, startPostgresStatementCensusTiming } from './postgres-statement-census.ts';

export interface ApiV1DatabaseLifecycle {
    readonly database: PSqlSql;
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly readiness: Promise<void>;
    close(): Promise<void>;
}

export interface ApiV1DatabaseNotificationPort {
    notify(channel: string, message: object): Promise<void>;
    listen(
        channel: string,
        onMessage: (payload: string) => void | Promise<void>
    ): Promise<void>;
}

export interface ApiV1PGliteResource {
    readonly waitReady: Promise<void>;
    close(): Promise<void>;
}

export interface ApiV1PostgresClient extends PSqlSql {
    notify(channel: string, payload: string): Promise<void | object>;
    listen(
        channel: string,
        onMessage: (payload: string) => void | Promise<void>
    ): Promise<void | object>;
    end(): Promise<void>;
}

export interface ApiV1PostgresClientInput {
    readonly connectionUrl: string;
    readonly max: number;
    readonly idleTimeoutSeconds: number;
    readonly census: PostgresStatementCensus | undefined;
}

/** Where the statement census of the application pool goes while timing is on. */
export interface ApiV1StatementCensusTiming {
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
}

export interface ApiV1DatabaseLifecycleOperations {
    createPostgresClient(input: ApiV1PostgresClientInput): ApiV1PostgresClient;
    readyPostgres(client: ApiV1PostgresClient): Promise<void>;
    createPGlite(dataDirectory: string): ApiV1PGliteResource;
    bootstrapPGlite(
        resource: ApiV1PGliteResource,
        configuration: Exclude<ApiV1DatabaseConfiguration, { mode: 'postgres'; }>
    ): Promise<void>;
    startPGliteEvidence(
        resource: ApiV1PGliteResource,
        configuration: ApiV1PGliteEvidenceConfiguration
    ): Promise<Pick<PGliteBlackBoxSnapshotPublisher, 'stop'> | undefined>;
    createPGliteSql(resource: ApiV1PGliteResource): PSqlSql;
    /** The clock of the statement census's emission. */
    readonly timers: Timers;
}

export interface CreateApiV1DatabaseLifecycleInput {
    readonly database: ApiV1DatabaseConfiguration;
    readonly pgliteEvidence: ApiV1PGliteEvidenceConfiguration;
    /** Undefined with timing off: no statement is recorded. A PGlite database keeps no census. */
    readonly statementCensus: ApiV1StatementCensusTiming | undefined;
}

const STATEMENT_CENSUS_INTERVAL_MS = 5_000;

export async function createDefaultApiV1DatabaseLifecycle(
    input: CreateApiV1DatabaseLifecycleInput
): Promise<ApiV1DatabaseLifecycle> {
    return await createApiV1DatabaseLifecycle(input, PRODUCTION_OPERATIONS);
}

export async function createApiV1DatabaseLifecycle(
    input: CreateApiV1DatabaseLifecycleInput,
    operations: ApiV1DatabaseLifecycleOperations
): Promise<ApiV1DatabaseLifecycle> {
    return input.database.mode === 'postgres'
        ? await createPostgresLifecycle(input.database, input.statementCensus, operations)
        : await createPGliteLifecycle(input, operations);
}

export function toPostgresJsConnectionUrl(databaseUrl: string): string {
    const url = new URL(databaseUrl);
    const schema = url.searchParams.get('schema');
    if (schema === null) {
        return databaseUrl;
    }
    url.searchParams.delete('schema');
    if (!url.searchParams.has('search_path')) {
        url.searchParams.set('search_path', schema);
    }
    return url.toString();
}

interface ApiV1StatementCensusRun {
    readonly census: PostgresStatementCensus | undefined;
    readonly stop: () => void;
}

interface ApiV1PostgresPools {
    readonly application: ApiV1PostgresClient;
    readonly listener: ApiV1PostgresClient;
}

async function createPostgresLifecycle(
    configuration: Extract<ApiV1DatabaseConfiguration, { mode: 'postgres'; }>,
    statementCensus: ApiV1StatementCensusTiming | undefined,
    operations: ApiV1DatabaseLifecycleOperations
): Promise<ApiV1DatabaseLifecycle> {
    const census = startApiV1StatementCensus(statementCensus, operations.timers);
    let pools: ApiV1PostgresPools;
    try {
        pools = await createReadyPostgresPools(configuration, census.census, operations);
    }
    catch (error) {
        census.stop();
        throw error;
    }
    const { application, listener } = pools;
    let closing: Promise<void> | undefined;
    return {
        database: application,
        notification: createPostgresNotificationPort(application, listener),
        readiness: Promise.resolve(),
        close: () => {
            census.stop();
            closing ??= closePostgresClients(listener, application);
            return closing;
        }
    };
}

/** The census of the application pool and its emission, while timing is on. */
function startApiV1StatementCensus(
    statementCensus: ApiV1StatementCensusTiming | undefined,
    timers: Timers
): ApiV1StatementCensusRun {
    if (statementCensus === undefined) {
        return { census: undefined, stop: () => undefined };
    }
    const census = new PostgresStatementCensus();
    return {
        census,
        stop: startPostgresStatementCensusTiming({
            census,
            timers,
            ...statementCensus,
            intervalMs: STATEMENT_CENSUS_INTERVAL_MS
        })
    };
}

async function createReadyPostgresPools(
    configuration: Extract<ApiV1DatabaseConfiguration, { mode: 'postgres'; }>,
    census: PostgresStatementCensus | undefined,
    operations: ApiV1DatabaseLifecycleOperations
): Promise<ApiV1PostgresPools> {
    const connectionUrl = toPostgresJsConnectionUrl(configuration.url);
    const application = operations.createPostgresClient({
        connectionUrl,
        max: configuration.applicationPool.maxConnections,
        idleTimeoutSeconds: configuration.applicationPool.idleTimeoutSeconds,
        census
    });
    let listener: ApiV1PostgresClient;
    try {
        listener = operations.createPostgresClient({
            connectionUrl,
            max: configuration.listenerPool.maxConnections,
            idleTimeoutSeconds: configuration.listenerPool.idleTimeoutSeconds,
            census: undefined
        });
    }
    catch (error) {
        await application.end();
        throw error;
    }
    try {
        await operations.readyPostgres(application);
        await operations.readyPostgres(listener);
    }
    catch (error) {
        await closePostgresClients(listener, application);
        throw error;
    }
    return { application, listener };
}

async function createPGliteLifecycle(
    input: CreateApiV1DatabaseLifecycleInput,
    operations: ApiV1DatabaseLifecycleOperations
): Promise<ApiV1DatabaseLifecycle> {
    if (input.database.mode === 'postgres') {
        throw new TypeError('PGlite lifecycle requires a PGlite database configuration.');
    }
    const resource = operations.createPGlite(input.database.dataDirectory);
    let evidence: Pick<PGliteBlackBoxSnapshotPublisher, 'stop'> | undefined;
    try {
        await resource.waitReady;
        await operations.bootstrapPGlite(resource, input.database);
        evidence = await operations.startPGliteEvidence(resource, input.pgliteEvidence);
        const database = operations.createPGliteSql(resource);
        let closing: Promise<void> | undefined;
        return {
            database,
            notification: null,
            readiness: Promise.resolve(),
            close: () => {
                closing ??= closePGliteResources(resource, evidence);
                return closing;
            }
        };
    }
    catch (error) {
        await closePGliteResources(resource, evidence);
        throw error;
    }
}

function createPostgresNotificationPort(
    application: ApiV1PostgresClient,
    listener: ApiV1PostgresClient
): ApiV1DatabaseNotificationPort {
    return {
        notify: async (channel, message) => {
            const payload = JSON.stringify(message);
            if (payload === undefined) {
                throw new TypeError('Database notification must be JSON serializable.');
            }
            await application.notify(channel, payload);
        },
        listen: async (channel, onMessage) => {
            await tryWith({
                handler: async () => await listener.listen(channel, onMessage),
                retryIntervalMsecs: 500,
                maxAttempts: Number.MAX_VALUE,
                maxRetryIntervalMsecs: 20_000
            });
        }
    };
}

async function closePostgresClients(
    listener: ApiV1PostgresClient,
    application: ApiV1PostgresClient
): Promise<void> {
    const failures: Error[] = [];
    for (const client of [listener, application]) {
        try {
            await client.end();
        }
        catch (error) {
            failures.push(
                error instanceof Error
                    ? error
                    : new Error('PostgreSQL client cleanup threw a non-Error value.', { cause: error })
            );
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close API-v1 PostgreSQL resources.');
    }
}

async function closePGliteResources(
    resource: ApiV1PGliteResource,
    evidence: Pick<PGliteBlackBoxSnapshotPublisher, 'stop'> | undefined
): Promise<void> {
    const failures: Error[] = [];
    if (evidence !== undefined) {
        try {
            await evidence.stop();
        }
        catch (error) {
            failures.push(
                error instanceof Error
                    ? error
                    : new Error('PGlite evidence cleanup threw a non-Error value.', { cause: error })
            );
        }
    }
    try {
        await resource.close();
    }
    catch (error) {
        failures.push(
            error instanceof Error
                ? error
                : new Error('PGlite resource cleanup threw a non-Error value.', { cause: error })
        );
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close API-v1 PGlite resources.');
    }
}

const PRODUCTION_OPERATIONS: ApiV1DatabaseLifecycleOperations = {
    createPostgresClient: (input) =>
        toApiV1PostgresClient(
            postgres(input.connectionUrl, {
                max: input.max,
                idle_timeout: input.idleTimeoutSeconds,
                types: {
                    timestampWithoutTimeZone: createPostgresTimestampWithoutTimeZoneTextType()
                }
            }),
            input.census
        ),
    readyPostgres: async (client) => {
        await client`select 1`;
    },
    createPGlite: (dataDirectory) => new PGlite(dataDirectory),
    bootstrapPGlite: async (resource, configuration) => {
        await bootstrapApiV1InMemorySchemaIfNeeded(
            resource as PGlite,
            configuration
        );
    },
    startPGliteEvidence: async (resource, configuration) => {
        if (configuration.mode === 'disabled') {
            return undefined;
        }
        return await startPGliteBlackBoxSnapshotPublisher(
            resource as PGlite,
            {
                directory: configuration.directory,
                pollIntervalMs: configuration.pollIntervalMs
            }
        );
    },
    createPGliteSql: (resource) =>
        createPGliteSqlClient(resource as PGlite, {
            ready: Promise.resolve()
        }),
    timers: createDefaultBackgroundTimers()
};

/**
 * The counting adapter over a complete postgres.js client; every statement the application issues passes through it,
 * and into the census when one is given.
 */
export function toApiV1PostgresClient(
    client: object,
    census: PostgresStatementCensus | undefined
): ApiV1PostgresClient {
    if (
        typeof client !== 'function' ||
        !hasCallableProperty(client, 'begin') ||
        !hasCallableProperty(client, 'notify') ||
        !hasCallableProperty(client, 'listen') ||
        !hasCallableProperty(client, 'end')
    ) {
        throw new TypeError('Postgres client does not expose the required API-v1 capabilities.');
    }
    return createPostgresSqlClient(client as PostgresSqlClientSource, census);
}

function hasCallableProperty(value: object, property: string): boolean {
    return typeof Reflect.get(value, property) === 'function';
}
