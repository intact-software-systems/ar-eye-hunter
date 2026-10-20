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
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace
} from '../../../../packages/tests/shared-server/integration/postgres/test-support/postgres-app-inbox-worker-runtime.ts';
import { putAuthorisedWsTestTicket } from '../../../../packages/tests/shared-server/rallar-system/client-state/authorised-ws-test-ticket.ts';
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

/**
 * `after-commit`: the upgrade route registers the socket only after its connect commits, so the row can be
 * delivered while the session is expected but not yet open; the hold delivers it when the socket opens.
 */
for (
    const [placement, registration] of [
        ['publisher', 'before-delivery'],
        ['remote', 'before-delivery'],
        ['publisher', 'after-commit'],
        ['remote', 'after-commit'],
        ['unbridged', 'before-delivery'],
        ['unbridged', 'after-commit']
    ] as const
) {
    // `unbridged`: RALLAR_DB_PUBSUB=disabled installs no cluster bridge; the dequeuing server's own sends deliver.
    Deno.test(`committed client snapshot reaches ${placement} socket registered ${registration} through the cluster bridge`, async () => {
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
            const recipientSocket = new JsonWebSocketServer();
            if (registration === 'before-delivery') {
                native.open();
                registerRecipientConnection(recipientSocket, recipient, native);
            }
            else {
                recipientSocket.expectedConnections.expect({
                    id: recipient.sessionId,
                    generationId: 'generation',
                    expiresAtEpochMs: recipient.now + 60_000
                });
            }
            const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
            const publisherEngine = new InboxOutboxEngine();
            const remoteEngine = new InboxOutboxEngine();
            const publisherSocket = placement === 'remote' ? new JsonWebSocketServer() : recipientSocket;
            const remoteSocket = placement === 'remote' ? recipientSocket : new JsonWebSocketServer();
            const publisher = createDefaultWsQueueBoxServerService({
                inboundVolatileStores: undefined,
                name: 'publisher',
                socket: publisherSocket,
                outbox: stores.workQueue,
                outboundStores: stores,
                queueEngine: publisherEngine,
                readAuthenticatedConnectionScope: readAuthorisedWsConnectionEligibility,
                readProducerProvenance: (message, row) => reader.readProducerProvenance(message, row)
            });
            const remote = createDefaultWsQueueBoxServerService({
                inboundVolatileStores: undefined,
                name: 'remote',
                socket: remoteSocket,
                outbox: stores.workQueue,
                outboundStores: stores,
                queueEngine: remoteEngine,
                readAuthenticatedConnectionScope: readAuthorisedWsConnectionEligibility
            });
            const bridge = new SnapshotBridge();
            let bodyFailure: Error | undefined;
            try {
                const bridged = placement === 'unbridged' ? [] : [[publisher, publisherSocket, 'publisher'], [remote, remoteSocket, 'remote']] as const;
                for (const [service, socket, id] of bridged) {
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
                assert.equal(bridge.published.length, placement === 'unbridged' ? 0 : 1);
                if (registration === 'after-commit') {
                    assert.equal(native.sent.length, 0);
                    registerRecipientConnection(recipientSocket, recipient, native);
                    native.open();
                }
                assert.equal(native.sent.length, 1);
            }
            catch (caught) {
                bodyFailure = toError(caught);
            }
            const cleanup = await Promise.allSettled([
                publisher.dispose(),
                remote.dispose(),
                publisherEngine.stop(),
                remoteEngine.stop()
            ]);
            releaseAuthorisedWsCloseFacts({
                sessionId: recipient.sessionId,
                generationId: 'generation',
                generationStartedAtEpochMs: recipient.now,
                disconnectedAtEpochMs: Date.now(),
                reason: 'test-finished'
            });
            const failure = cleanup.find((outcome) => outcome.status === 'rejected');
            if (bodyFailure) {
                if (failure?.status === 'rejected') {
                    try {
                        console.error('Snapshot bridge cleanup failed after body failure:', failure.reason);
                    }
                    catch { /* Diagnostic failure cannot replace the original body error. */ }
                }
                throw bodyFailure;
            }
            if (failure?.status === 'rejected') {
                throw failure.reason;
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
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql,
        serviceId: 'producer',
        newLaneHeldRows: undefined,
        atEpochMs: recipient.now,
        trace: createPostgresAppInboxWorkerTrace()
    });
    await runtime.authSessions.putSession(authSession);
    const ticketDigest = await putAuthorisedWsTestTicket(runtime.authSessions, authSession);
    const result = await runtime.runUntilCompletion(() =>
        runtime.client.writeAuthorisedWsClientConnect({
            authSession,
            generationId: 'generation',
            ticketDigest,
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

function registerRecipientConnection(socket: JsonWebSocketServer, recipient: SnapshotRecipient, native: TestWebSocket): void {
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
