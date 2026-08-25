import assert from 'node:assert/strict';

import type { AuthSession } from '@shared/api/api-config.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { InMemoryRallarCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
import { emptyGroupFormationMetrics } from '@shared-server/rallar-system/observability/formation-metrics.ts';

import { createApiV1AdminServices, readApiV1WebSocketStatus, type CreateApiV1AdminServicesInput } from '../../src/composition/create-api-v1-admin-services.ts';

const NOW_EPOCH_MS = 10_000;
const ADMIN_SESSION: AuthSession = {
    clientId: 'admin',
    username: 'admin',
    accessToken: 'token',
    sessionId: 'session-open',
    expiresAtEpochMs: NOW_EPOCH_MS + 1_000
};

Deno.test('admin services read current websocket status after construction', async () => {
    const socket = new JsonWebSocketServer();
    const services = createApiV1AdminServices(
        createInput(() => readApiV1WebSocketStatus(socket))
    );
    socket.connections.set(
        'connection-open',
        new ConnectionContext('connection-open', createSocket(WebSocket.OPEN))
    );

    const realtime = await services.operations.realtime.execute({
        adminSession: ADMIN_SESSION
    });
    const support = await services.support.explainClient({
        adminSession: ADMIN_SESSION,
        request: {
            scope: { applicationId: 'app', workspaceId: 'workspace' },
            principalId: 'admin'
        }
    });
    const statistics = await services.statistics.readMyRealtimeStatus({
        authSession: ADMIN_SESSION,
        scope: { applicationId: 'app', workspaceId: 'workspace' }
    });

    assert.equal(realtime.websocket.connectionCount, 1);
    assert.equal(realtime.websocket.openConnectionCount, 1);
    assert.equal(
        support.facts.find((fact) => fact.label === 'client.websocket.openConnectionCount')?.value,
        1
    );
    assert.equal(statistics.realtime.currentSessionOpen, false);

    socket.connections.set(
        'session-open',
        new ConnectionContext('session-open', createSocket(WebSocket.OPEN))
    );
    const current = await services.statistics.readMyRealtimeStatus({
        authSession: ADMIN_SESSION,
        scope: { applicationId: 'app', workspaceId: 'workspace' }
    });
    assert.equal(current.realtime.currentSessionOpen, true);
});

Deno.test(
    'admin services propagate websocket status failures without an empty ' +
        'fallback',
    async () => {
        const failure = new Error('websocket status failed');
        const services = createApiV1AdminServices(
            createInput(() => {
                throw failure;
            })
        );

        assert.throws(
            () => services.operations.realtime.execute({ adminSession: ADMIN_SESSION }),
            (error) => error === failure
        );
        await assert.rejects(
            () =>
                services.support.explainClient({
                    adminSession: ADMIN_SESSION,
                    request: {
                        scope: { applicationId: 'app', workspaceId: 'workspace' },
                        principalId: 'admin'
                    }
                }),
            (error) => error === failure
        );
        await assert.rejects(
            () =>
                services.statistics.readMyRealtimeStatus({
                    authSession: ADMIN_SESSION,
                    scope: { applicationId: 'app', workspaceId: 'workspace' }
                }),
            (error) => error === failure
        );
    }
);

function createInput(
    readWebSocketStatus: CreateApiV1AdminServicesInput['readWebSocketStatus']
): CreateApiV1AdminServicesInput {
    return {
        database: createDatabase(),
        databaseMode: 'pglite-memory',
        databasePubSubMode: 'local',
        nowEpochMs: () => NOW_EPOCH_MS,
        serviceId: 'api-test',
        timing: () => {},
        readWebSocketStatus,
        readRtcTopologyMetrics: () => ({ rebuilds: 1 }),
        resetRtcTopologyMetrics: () => {},
        readGroupFormationMetrics: emptyGroupFormationMetrics,
        resetGroupFormationMetrics: () => {},
        crdtAdminRepository: new InMemoryRallarCrdtLogRepository({
            now: () => NOW_EPOCH_MS
        }),
        topologyQuery: {
            readTopologyView: rejectUnusedOperation
        },
        clientStateService: {
            readSnapshot: () => Promise.resolve(undefined),
            readPresenceSnapshot: () => Promise.resolve(undefined),
            listRecentEvents: () => Promise.resolve([])
        },
        groupStateService: {
            readSnapshot: () => Promise.resolve(undefined),
            readCurrentSnapshot: () => Promise.resolve(undefined),
            listRecentEvents: () => Promise.resolve([]),
            listSnapshots: () => Promise.resolve([]),
            listSnapshotsPage: () =>
                Promise.resolve({
                    snapshots: [],
                    scannedGroupCount: 0,
                    hasMore: false
                }),
            listEvents: () => Promise.resolve([])
        },
        appAdminInboxService: {
            pruneExpired: rejectUnusedOperation
        },
        crdtAdminMutations: {
            writeCrdtAdminMutation: () => Promise.reject(new Error('mutation not used'))
        },
        topologyInboxService: {
            processAuthenticatedHttpEntryUntilCompletionResult: rejectUnusedOperation
        }
    };
}

function createDatabase(): PSqlSql {
    return Object.assign(
        function<T> (
            _stringsOrValues: TemplateStringsArray | readonly unknown[],
            ..._values: unknown[]
        ): Promise<T> {
            return Promise.reject(new Error('query not used'));
        },
        {
            begin<T>(_operation: (transaction: PSqlSql) => Promise<T>): Promise<T> {
                return Promise.reject(new Error('transaction not used'));
            }
        }
    );
}

function rejectUnusedOperation<T>(): Promise<T> {
    return Promise.reject(new Error('operation not used'));
}

function createSocket(readyState: WebSocket['readyState']): WebSocket {
    return new TestWebSocket(readyState);
}

class TestWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly url = 'ws://test.invalid';
    readonly readyState: WebSocket['readyState'];
    binaryType: BinaryType = 'blob';
    onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
    onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
    onopen: ((this: WebSocket, event: Event) => unknown) | null = null;

    constructor(readyState: WebSocket['readyState']) {
        super();
        this.readyState = readyState;
    }

    close(): void {}

    send(): void {}
}
