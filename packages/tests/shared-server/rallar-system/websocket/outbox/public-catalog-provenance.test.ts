import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { computeViewInvalidationPublication } from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { computeWsOutboxProvenanceRecord, WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { validateWsQueueBoxServerRecipientAuthority } from '@shared/services/ws-queue-box-server/scope/requires-ws-queue-box-server-recipient-scope.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { expect, it, onTestFinished } from 'vitest';
import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const scope = { applicationId: 'game', workspaceId: 'workspace' };
const publication = computeViewInvalidationPublication({
    resource: 'tournament-catalog',
    scope,
    principalIds: null,
    changeId: 'opaque-change',
    createdAtEpochMs: Date.now(),
    retentionMs: 60000,
    serviceId: 'api-a',
    traceId: 'trace'
});
const entry = publication.outbox[0]!.entry;
const message = decodePersistedALMessageRow(entry);

it.each(['local', 'remote'] as const)('delivers public catalog changes only to authenticated scope readers through %s dispatch', async (placement) => {
    const fixture = new PublicCatalogFixture();
    await fixture.seedProof();
    if (placement === 'local') {
        fixture.connectReaders();
    }
    const published: QueueBoxPubSubMessage[] = [];
    let receive: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;
    await installQueueBoxPubSubBridge({
        wsQBoxServerService: fixture.service,
        bridge: {
            async publish(_channel, value) {
                published.push(value);
            },
            async subscribe(_channel, listener) {
                receive = listener;
            }
        },
        channel: 'events',
        publisherId: 'api-a',
        filterEligibleCapturedSessionIds: async (input) => input.candidateSessionIds
    });
    await fixture.stores.workQueue.enqueue(entry);
    await fixture.engine.executeOnce();
    await expect.poll(() => published.length).toBe(1);
    if (placement === 'remote') {
        fixture.connectReaders();
        await receive?.({ ...published[0]!, publisherId: 'api-b' });
    }
    await expect.poll(() => fixture.sockets.get('reader')!.sent.length).toBe(1);
    expect(fixture.sockets.get('other-workspace')!.sent).toEqual([]);
    expect(fixture.sockets.get('other-game')!.sent).toEqual([]);
    expect(fixture.sockets.get('signed-out')!.sent).toEqual([]);
});

it.each(['wrong-workspace', 'wrong-producer'] as const)('rejects a valid-digest catalog proof with %s', async (violation) => {
    const fixture = new PublicCatalogFixture();
    const record = computeWsOutboxProvenanceRecord({
        producerKind: violation === 'wrong-producer' ? 'crdt' : 'view-invalidation',
        entry,
        message,
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
        target: { kind: 'scoped-world-broadcast', scope: violation === 'wrong-workspace' ? { ...scope, workspaceId: 'other' } : scope }
    });
    await fixture.repository.upsert(record);
    await expect(fixture.reader.readProducerProvenance(message, entry)).rejects.toThrow();
});

it('roundtrips only the exact public scope and connection in persisted prepared recipients', () => {
    const prepared = {
        kind: 'scoped-recipient',
        peerId: 'session',
        connectionId: 'session',
        generationId: 'generation',
        recipientScope: scope,
        message: toALOutboundTransportMessage(message)
    };
    expect(decodeWsQueueBoxServerPreparedMessage(JSON.parse(JSON.stringify(prepared)), message, entry.key)).toEqual(prepared);
    for (
        const changed of [
            { recipientScope: { ...scope, workspaceId: 'other' } },
            { principalTargetId: 'alice' },
            { peerId: 'different-session' }
        ]
    ) {
        expect(() => decodeWsQueueBoxServerPreparedMessage({ ...prepared, ...changed }, message, entry.key)).toThrow();
    }
});

it('refuses a captured catalog policy with another workspace or a frozen private audience', () => {
    const authority = { recipientScope: scope, admittedAudience: undefined };
    expect(validateWsQueueBoxServerRecipientAuthority(message, authority, entry.key)).toEqual([]);
    for (
        const changed of [
            { recipientScope: { ...scope, workspaceId: 'other' } },
            { principalTargetId: 'alice' },
            { admittedAudience: ['session'] },
            { recipientScope: undefined }
        ]
    ) {
        expect(validateWsQueueBoxServerRecipientAuthority(message, { ...authority, ...changed }, entry.key)).not.toEqual([]);
    }
});

class PublicCatalogFixture {
    readonly repository = new FakeRuntimeStateRepository();
    readonly reader = new WsOutboxProvenanceReader({
        repository: this.repository,
        nowMs: Date.now,
        readPrincipalSessionIds: async () => {
            throw new Error('Public catalogs must not capture a private audience');
        }
    });
    readonly socket = new JsonWebSocketServer();
    readonly sockets = new Map<string, TestWebSocket>();
    readonly stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    readonly engine = new InboxOutboxEngine();
    readonly service = createDefaultWsQueueBoxServerService({
        name: 'api-a',
        socket: this.socket,
        inboundVolatileStores: undefined,
        outbox: this.stores.workQueue,
        outboundStores: this.stores,
        queueEngine: this.engine,
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolveBroadcastRecipients: () => [...this.sockets.keys()].map((id) => ({ peerId: id, connectionId: id }))
        },
        readProducerProvenance: (msg, row) => this.reader.readProducerProvenance(msg, row),
        readAuthenticatedConnectionScope: (connection) =>
            connection.id === 'signed-out' ? undefined : {
                scope: connection.id === 'other-workspace'
                    ? { ...scope, workspaceId: 'other' }
                    : connection.id === 'other-game'
                    ? { ...scope, applicationId: 'other' }
                    : scope,
                principalId: connection.id,
                expiresAtEpochMs: Date.now() + 60000
            }
    });

    constructor() {
        onTestFinished(async () => {
            await this.service.dispose();
            await this.engine.stop();
        });
    }

    async seedProof(): Promise<void> {
        for (const record of publication.provenance) {
            if (record.operation !== 'insert') {
                throw new Error('Expected immutable proof');
            }
            await this.repository.upsert({ namespace: record.namespace, key: record.key, value: record.value, expireAtTimestamp: record.expireAtTimestamp });
        }
        expect(await this.reader.readProducerProvenance(message, entry)).toEqual({
            admittedAudience: undefined,
            recipientScope: scope,
            broadWorld: true
        });
    }

    connectReaders(): void {
        for (const id of ['reader', 'other-workspace', 'other-game', 'signed-out']) {
            const native = new TestWebSocket(`ws://${id}`);
            native.open();
            this.sockets.set(id, native);
            this.socket.addConnection(new ConnectionContext({ id, socket: native }));
        }
    }
}
