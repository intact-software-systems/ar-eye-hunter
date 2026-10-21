import assert from 'node:assert/strict';

import type { PSqlSql, PSqlTransactionWrite } from '@shared-server/postgres/p-sql-sql.ts';

import type { ApiV1DatabaseConfiguration, ApiV1PGliteEvidenceConfiguration } from '../../src/configuration/api-v1-configuration.ts';
import {
    createApiV1DatabaseLifecycle,
    toApiV1PostgresClient,
    toPostgresJsConnectionUrl,
    type ApiV1DatabaseLifecycleOperations,
    type ApiV1PGliteResource,
    type ApiV1PostgresClient,
    type ApiV1PostgresClientInput,
    type CreateApiV1DatabaseLifecycleInput
} from '../../src/db/api-v1-database-lifecycle.ts';
import { PostgresStatementCensus } from '../../src/db/postgres-statement-census.ts';

Deno.test('PostgreSQL client adapter counts the statements of a complete current client and forwards its lifecycle', async () => {
    const events: string[] = [];
    const client = fakePostgresClient(7, events);

    const adapted = toApiV1PostgresClient(client, undefined);
    await adapted`select 1`;
    await adapted.end();
    assert.deepEqual(adapted.getExecutorCounters?.()?.statements, 1);
    assert.deepEqual(events, ['postgres:close:7']);
    assert.throws(
        () =>
            toApiV1PostgresClient(
                Object.assign(() => Promise.resolve([]), {
                    begin: () => Promise.resolve()
                }),
                undefined
            ),
        /required API-v1 capabilities/u
    );
});

Deno.test('database lifecycle constructs PostgreSQL application and listener pools explicitly', async () => {
    const events: string[] = [];
    const clients: ApiV1PostgresClient[] = [];
    const poolInputs: ApiV1PostgresClientInput[] = [];
    const operations = fakeOperations({ events, clients, poolInputs });
    const lifecycle = await createApiV1DatabaseLifecycle(
        toApiV1DatabaseLifecycleInput(postgresConfiguration(), { mode: 'disabled', pollIntervalMs: 25 }),
        operations
    );

    assert.deepEqual(poolInputs, [
        {
            connectionUrl: 'postgres://user:secret@database.test/rallar?search_path=tenant',
            max: 7,
            idleTimeoutSeconds: 23,
            census: undefined
        },
        {
            connectionUrl: 'postgres://user:secret@database.test/rallar?search_path=tenant',
            max: 2,
            idleTimeoutSeconds: 0,
            census: undefined
        }
    ]);
    assert.equal(lifecycle.database, clients[0]);
    assert.ok(lifecycle.notification);
    await lifecycle.readiness;

    const received: string[] = [];
    await lifecycle.notification.notify('rallar-events', { id: 'event-1' });
    await lifecycle.notification.listen('rallar-events', (payload) => {
        received.push(payload);
    });
    assert.deepEqual(events, [
        'postgres:create:7',
        'postgres:create:2',
        'postgres:ready:7',
        'postgres:ready:2',
        'postgres:notify:rallar-events:{"id":"event-1"}',
        'postgres:listen:rallar-events'
    ]);
    assert.deepEqual(received, ['{"id":"remote-event"}']);

    await lifecycle.close();
    await lifecycle.close();
    assert.deepEqual(events.slice(-2), ['postgres:close:2', 'postgres:close:7']);
});

for (const mode of ['pglite-memory', 'pglite-file'] as const) {
    Deno.test(`database lifecycle owns ${mode} readiness, bootstrap, evidence, and close`, async () => {
        const events: string[] = [];
        const resource = fakePGliteResource(events);
        const database = fakeDatabase();
        const operations = fakeOperations({ events, resource, database });
        const evidence: ApiV1PGliteEvidenceConfiguration = mode === 'pglite-memory'
            ? { mode: 'directory', directory: '/private/evidence', pollIntervalMs: 31 }
            : { mode: 'disabled', pollIntervalMs: 31 };
        const dataDirectory = mode === 'pglite-memory' ? 'memory://' : '/private/rallar';
        const lifecycle = await createApiV1DatabaseLifecycle(
            toApiV1DatabaseLifecycleInput(pgliteConfiguration(mode), evidence),
            operations
        );

        assert.equal(lifecycle.database, database);
        assert.equal(lifecycle.notification, null);
        assert.deepEqual(
            events,
            mode === 'pglite-memory'
                ? [
                    `pglite:create:${dataDirectory}`,
                    'pglite:ready',
                    'pglite:bootstrap:auto',
                    'pglite:evidence:/private/evidence:31',
                    'pglite:sql'
                ]
                : [
                    `pglite:create:${dataDirectory}`,
                    'pglite:ready',
                    'pglite:bootstrap:auto',
                    'pglite:sql'
                ]
        );

        await lifecycle.close();
        await lifecycle.close();
        assert.deepEqual(
            events.slice(mode === 'pglite-memory' ? -2 : -1),
            mode === 'pglite-memory'
                ? ['pglite:evidence:stop', 'pglite:close']
                : ['pglite:close']
        );
    });
}

for (const failure of ['listener', 'readiness', 'bootstrap', 'evidence'] as const) {
    Deno.test(`database lifecycle closes partial resources when ${failure} setup fails`, async () => {
        const events: string[] = [];
        const clients: ApiV1PostgresClient[] = [];
        const resource = fakePGliteResource(events);
        const operations = fakeOperations({
            events,
            clients,
            resource,
            fail: failure
        });
        const input = failure === 'listener' || failure === 'readiness'
            ? toApiV1DatabaseLifecycleInput(postgresConfiguration(), { mode: 'disabled', pollIntervalMs: 25 })
            : toApiV1DatabaseLifecycleInput(
                pgliteConfiguration('pglite-memory'),
                { mode: 'directory', directory: '/private/evidence', pollIntervalMs: 25 }
            );

        await assert.rejects(
            () => createApiV1DatabaseLifecycle(input, operations),
            new RegExp(`${failure} setup failed`, 'u')
        );
        assert.equal(
            events.filter((event) => event === 'pglite:close').length,
            failure === 'listener' || failure === 'readiness' ? 0 : 1
        );
        assert.equal(
            events.filter((event) => event === 'postgres:close:7').length,
            failure === 'listener' || failure === 'readiness' ? 1 : 0
        );
        assert.equal(
            events.filter((event) => event === 'postgres:close:2').length,
            failure === 'readiness' ? 1 : 0
        );
    });
}

Deno.test('PostgreSQL URL translation moves only the Prisma schema query to search_path', () => {
    assert.equal(
        toPostgresJsConnectionUrl('postgres://database.test/rallar?schema=tenant&sslmode=require'),
        'postgres://database.test/rallar?sslmode=require&search_path=tenant'
    );
    assert.equal(
        toPostgresJsConnectionUrl('postgres://database.test/rallar?schema=tenant&search_path=owned'),
        'postgres://database.test/rallar?search_path=owned'
    );
});

Deno.test('with timing on, the application pool alone records into a statement census, which stops with the lifecycle', async () => {
    const events: string[] = [];
    const poolInputs: ApiV1PostgresClientInput[] = [];
    const lifecycle = await createApiV1DatabaseLifecycle(
        {
            ...toApiV1DatabaseLifecycleInput(postgresConfiguration(), { mode: 'disabled', pollIntervalMs: 25 }),
            statementCensus: { timing: () => undefined, serviceId: 'server-1' }
        },
        fakeOperations({ events, clients: [], poolInputs })
    );

    assert.deepEqual(poolInputs.map((pool) => [pool.max, pool.census instanceof PostgresStatementCensus]), [[7, true], [2, false]]);
    await lifecycle.close();
});

interface FakeOperationsInput {
    readonly events: string[];
    readonly clients?: ApiV1PostgresClient[];
    readonly poolInputs?: ApiV1PostgresClientInput[];
    readonly resource?: ApiV1PGliteResource;
    readonly database?: PSqlSql;
    readonly fail?: 'listener' | 'readiness' | 'bootstrap' | 'evidence';
}

function fakeOperations(input: FakeOperationsInput): ApiV1DatabaseLifecycleOperations {
    return {
        createPostgresClient: (clientInput) => {
            if (input.fail === 'listener' && input.clients?.length === 1) {
                throw new Error('listener setup failed');
            }
            const client = fakePostgresClient(clientInput.max, input.events);
            input.clients?.push(client);
            input.poolInputs?.push(clientInput);
            input.events.push(`postgres:create:${clientInput.max}`);
            return client;
        },
        readyPostgres: (client) => {
            const max = input.clients?.indexOf(client) === 0 ? 7 : 2;
            input.events.push(`postgres:ready:${max}`);
            return input.fail === 'readiness' && max === 2
                ? Promise.reject(new Error('readiness setup failed'))
                : Promise.resolve();
        },
        createPGlite: (dataDirectory) => {
            input.events.push(`pglite:create:${dataDirectory}`);
            return input.resource ?? fakePGliteResource(input.events);
        },
        bootstrapPGlite: (_resource, configuration) => {
            input.events.push(`pglite:bootstrap:${configuration.schemaInitialization}`);
            if (input.fail === 'bootstrap') {
                return Promise.reject(new Error('bootstrap setup failed'));
            }
            return Promise.resolve();
        },
        startPGliteEvidence: (_resource, configuration) => {
            if (configuration.mode !== 'directory') {
                return Promise.resolve(undefined);
            }
            input.events.push(`pglite:evidence:${configuration.directory}:${configuration.pollIntervalMs}`);
            if (input.fail === 'evidence') {
                return Promise.reject(new Error('evidence setup failed'));
            }
            return Promise.resolve({
                stop: () => {
                    input.events.push('pglite:evidence:stop');
                    return Promise.resolve();
                }
            });
        },
        createPGliteSql: () => {
            input.events.push('pglite:sql');
            return input.database ?? fakeDatabase();
        }
    };
}

function fakePGliteResource(events: string[]): ApiV1PGliteResource {
    return {
        waitReady: Promise.resolve().then(() => {
            events.push('pglite:ready');
        }),
        close: () => {
            events.push('pglite:close');
            return Promise.resolve();
        }
    };
}

function fakePostgresClient(max: number, events: string[]): ApiV1PostgresClient {
    return Object.assign(fakeDatabase(), {
        notify: (channel: string, payload: string) => {
            events.push(`postgres:notify:${channel}:${payload}`);
            return Promise.resolve();
        },
        listen: async (channel: string, listener: (payload: string) => void | Promise<void>) => {
            events.push(`postgres:listen:${channel}`);
            await listener('{"id":"remote-event"}');
        },
        end: () => {
            events.push(`postgres:close:${max}`);
            return Promise.resolve();
        }
    });
}

function fakeDatabase(): PSqlSql {
    return Object.assign(
        function () {
            return Promise.resolve([]);
        },
        {
            begin<T>(_operation: PSqlTransactionWrite<T>): Promise<T> {
                return Promise.reject(new Error('transaction not used'));
            }
        }
    ) as PSqlSql;
}

function toApiV1DatabaseLifecycleInput(
    database: ApiV1DatabaseConfiguration,
    pgliteEvidence: ApiV1PGliteEvidenceConfiguration
): CreateApiV1DatabaseLifecycleInput {
    return { database, pgliteEvidence, statementCensus: undefined };
}

function postgresConfiguration(): ApiV1DatabaseConfiguration {
    return {
        mode: 'postgres',
        url: 'postgres://user:secret@database.test/rallar?schema=tenant',
        schemaInitialization: 'disabled',
        pubSub: 'postgres',
        applicationPool: { maxConnections: 7, idleTimeoutSeconds: 23 },
        listenerPool: { maxConnections: 2, idleTimeoutSeconds: 0 }
    };
}

function pgliteConfiguration(
    mode: 'pglite-memory' | 'pglite-file'
): ApiV1DatabaseConfiguration {
    const common = {
        schemaInitialization: 'auto' as const,
        pubSub: 'local' as const,
        applicationPool: { maxConnections: 5, idleTimeoutSeconds: 20 },
        listenerPool: { maxConnections: 1, idleTimeoutSeconds: 0 }
    };
    if (mode === 'pglite-memory') {
        return {
            ...common,
            mode,
            dataDirectory: 'memory://'
        };
    }
    return {
        ...common,
        mode,
        dataDirectory: '/private/rallar'
    };
}
