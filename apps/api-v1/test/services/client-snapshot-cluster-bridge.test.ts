import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace
} from '../../../../packages/tests/shared-server/integration/postgres/test-support/postgres-app-inbox-worker-runtime.ts';
import { TestWebSocket } from '../../../../packages/tests/shared/websocket/test-web-socket.ts';
import {
    readAuthorisedWsConnectionEligibility,
    releaseAuthorisedWsCloseFacts,
    rememberAuthorisedWsConnection
} from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { filterEligibleDurableWsSessionIds } from '../../src/services/filter-eligible-live-ws-session-ids.ts';
import { withPGliteSql } from '../db/pglite-auth-test-harness.ts';

interface SnapshotRecipient {
    readonly sessionId: string;
    readonly now: number;
    readonly scope: StateScope;
}

for (const placement of ['publisher', 'remote'] as const) {
    Deno.test(`committed client snapshot reaches ${placement} socket through registered cluster bridge`, async () => {
        await withPGliteSql(async (sql) => {
            const recipient: SnapshotRecipient = {
                sessionId: crypto.randomUUID(),
                now: Date.now(),
                scope: { applicationId: 'snapshot-bridge', workspaceId: 'workspace' }
            };
            const entry = await commitClientSnapshot(sql, recipient);
            const reader = new WsOutboxProvenanceReader({ repository: new PSqlRuntimeStateRepository(sql), nowMs: Date.now });
            assert.deepEqual(await reader.readProducerProvenance(decodePersistedALMessage(entry.resource), entry), {
                admittedAudience: [recipient.sessionId],
                recipientScope: recipient.scope
            });
            const native = new TestWebSocket('ws://recipient');
            native.open();
            const recipientSocket = createRecipientSocket(recipient, native);
            const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
            const publisherEngine = new InboxOutboxEngine();
            const remoteEngine = new InboxOutboxEngine();
            const publisherSocket = placement === 'publisher' ? recipientSocket : new JsonWebSocketServer();
            const remoteSocket = placement === 'remote' ? recipientSocket : new JsonWebSocketServer();
            const publisher = createDefaultWsQueueBoxServerService({
                name: 'publisher',
                socket: publisherSocket,
                outbox: stores.workQueue,
                outboundStores: stores,
                queueEngine: publisherEngine,
                readAuthenticatedConnectionScope: readAuthorisedWsConnectionEligibility,
                readProducerProvenance: (message, row) => reader.readProducerProvenance(message, row)
            });
            const remote = createDefaultWsQueueBoxServerService({
                name: 'remote',
                socket: remoteSocket,
                outbox: stores.workQueue,
                outboundStores: stores,
                queueEngine: remoteEngine,
                readAuthenticatedConnectionScope: readAuthorisedWsConnectionEligibility
            });
            const bridge = new SnapshotBridge();
            try {
                for (const [service, socket, id] of [[publisher, publisherSocket, 'publisher'], [remote, remoteSocket, 'remote']] as const) {
                    await installQueueBoxPubSubBridge({
                        wsQBoxServerService: service,
                        bridge,
                        channel: 'snapshot',
                        publisherId: id,
                        filterEligibleCapturedSessionIds: (captured) =>
                            filterEligibleDurableWsSessionIds({ ...captured, socketServer: socket, nowMs: Date.now() })
                    });
                }
                await stores.workQueue.enqueue(entry);
                await publisherEngine.executeOnce();
                for (let attempt = 0; attempt < 100 && (await stores.workQueue.getItem(entry.key))?.status !== EntityStatus.COMPLETED; attempt++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert.equal((await stores.workQueue.getItem(entry.key))?.status, EntityStatus.COMPLETED);
                assert.equal(bridge.published.length, 1);
                assert.equal(native.sent.length, 1);
            }
            finally {
                publisher.dispose();
                remote.dispose();
                publisherEngine.stop();
                remoteEngine.stop();
                releaseAuthorisedWsCloseFacts({
                    sessionId: recipient.sessionId,
                    generationId: 'generation',
                    generationStartedAtEpochMs: recipient.now,
                    disconnectedAtEpochMs: Date.now(),
                    reason: 'test-finished'
                });
            }
        });
    });
}

async function commitClientSnapshot(sql: PSqlSql, recipient: SnapshotRecipient): Promise<ResourceEntry> {
    const authSession = {
        clientId: recipient.sessionId,
        username: recipient.sessionId,
        sessionId: recipient.sessionId,
        accessToken: 'test-only',
        issuedAtEpochMs: recipient.now - 1_000,
        expiresAtEpochMs: recipient.now + 60_000
    };
    const runtime = createPostgresAppInboxWorkerRuntime({ sql, serviceId: 'producer', atEpochMs: recipient.now, trace: createPostgresAppInboxWorkerTrace() });
    await runtime.authSessions.putSession(authSession);
    const result = await runtime.runUntilCompletion(() =>
        runtime.client.processAuthorisedWsClientConnect({
            authSession,
            generationId: 'generation',
            input: {
                ...recipient.scope,
                clientInstanceId: 'browser',
                connectedAtEpochMs: recipient.now,
                expiresAtEpochMs: recipient.now + 60_000
            }
        })
    );
    assert.ok(result.right);
    const rows = await sql<ResourceInboxRow[]>`
        select * from resource_inbox
        where ri_type_id = 'WS_OUTBOX' and ri_resource::jsonb->'targets'->>'toPeerId' = ${recipient.sessionId}
    `;
    assert.equal(rows.length, 1);
    return toDomain(rows[0]!);
}

function createRecipientSocket(recipient: SnapshotRecipient, native: TestWebSocket): JsonWebSocketServer {
    const socket = new JsonWebSocketServer();
    socket.addConnection(
        new ConnectionContext({ id: recipient.sessionId, socket: native, generationId: 'generation', generationStartedAtEpochMs: recipient.now })
    );
    rememberAuthorisedWsConnection(recipient.sessionId, 'generation', {
        authSession: {
            clientId: recipient.sessionId,
            username: recipient.sessionId,
            sessionId: recipient.sessionId,
            issuedAtEpochMs: recipient.now - 1_000,
            expiresAtEpochMs: recipient.now + 60_000
        },
        generationId: 'generation',
        generationStartedAtEpochMs: recipient.now,
        scope: recipient.scope,
        principalId: recipient.sessionId,
        clientInstanceId: 'browser',
        displayName: recipient.sessionId,
        userAgent: null,
        platform: 'web',
        capabilities: [],
        expiresAtEpochMs: recipient.now + 60_000
    });
    return socket;
}

class SnapshotBridge implements QueueBoxPubSubBridge {
    readonly published: QueueBoxPubSubMessage[] = [];
    readonly subscribers: Parameters<QueueBoxPubSubBridge['subscribe']>[1][] = [];

    async publish(_channel: string, message: QueueBoxPubSubMessage): Promise<void> {
        this.published.push(message);
        for (const subscriber of this.subscribers) {
            await subscriber(message);
        }
    }

    subscribe(_channel: string, subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1]): Promise<void> {
        this.subscribers.push(subscriber);
        return Promise.resolve();
    }
}
