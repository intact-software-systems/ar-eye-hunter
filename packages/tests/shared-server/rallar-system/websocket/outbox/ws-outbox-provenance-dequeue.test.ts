import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import {
    newALBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

describe('producer provenance through WS dequeue', () => {
    it.each(['same-principal', 'wrong-principal'] as const)(
        'delivers a proven CRDT principal update only to %s captured sessions',
        async (recipient) => {
            const fixture = await createFixture();
            fixture.authentication.principalId = recipient === 'same-principal' ? 'principal' : 'other';
            const message = newALUnicastMessage(
                'server',
                {
                    topicId: 'principal.crdt',
                    resourceId: 'crdt-update',
                    contextId: 'principal'
                },
                'principal',
                'rallar.crdt.update.v1',
                {},
                {
                    ttlMs: 30_000,
                    qos: { durability: { algo: 'local-outbox' } }
                }
            );
            const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
            const facts: Omit<WsOutboxProvenance, 'digest'> = {
                version: 1,
                producerKind: 'crdt',
                queueKey: entry.key,
                typeId: entry.typeId,
                messageId: message.id.msgId,
                senderId: message.id.senderId,
                expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
                target: {
                    kind: 'scoped-principal-unicast',
                    peerId: 'principal',
                    principalRef: { ...SCOPE, principalId: 'principal' },
                    admittedAudience: ['peer']
                }
            };
            const proof = { ...facts, digest: computeWsOutboxProvenanceDigest(entry, facts) };
            await fixture.repository.upsert(
                WS_OUTBOX_PROVENANCE_NAMESPACE,
                toWsOutboxProvenanceKey(entry.key),
                JSON.stringify(proof),
                proof.expiresAtMs
            );

            await fixture.stores.workQueue.enqueue(entry);
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status)
                .not.toBe(EntityStatus.RESERVED);
            await expect.poll(async () => fixture.service.readCapturedPolicy(message, entry)).toMatchObject({
                admittedAudience: ['peer'],
                recipientScope: SCOPE,
                principalTargetId: 'principal'
            });
            expect(fixture.native.sent).toHaveLength(recipient === 'same-principal' ? 1 : 0);
        }
    );

    it.each(['same-scope', 'wrong-scope'] as const)(
        'delivers a proven CRDT world broadcast only to %s subscribers',
        async (recipient) => {
            const fixture = await createFixture();
            const message = newALBroadcastMessage(
                'server',
                {
                    topicId: 'app.crdt',
                    resourceId: 'crdt-update',
                    contextId: 'app'
                },
                'world',
                'rallar.crdt.update.v1',
                {},
                {
                    ttlMs: 30_000,
                    reliability: 'at-least-once',
                    qos: { durability: { algo: 'local-outbox' } }
                }
            );
            const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
            const facts: Omit<WsOutboxProvenance, 'digest'> = {
                version: 1,
                producerKind: 'crdt',
                queueKey: entry.key,
                typeId: entry.typeId,
                messageId: message.id.msgId,
                senderId: message.id.senderId,
                expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
                target: { kind: 'scoped-world-broadcast', scope: SCOPE }
            };
            const proof = { ...facts, digest: computeWsOutboxProvenanceDigest(entry, facts) };
            await fixture.repository.upsert(
                WS_OUTBOX_PROVENANCE_NAMESPACE,
                toWsOutboxProvenanceKey(entry.key),
                JSON.stringify(proof),
                proof.expiresAtMs
            );
            if (recipient === 'wrong-scope') {
                fixture.authentication.scope = { ...SCOPE, workspaceId: 'other' };
            }

            await fixture.stores.workQueue.enqueue(entry);
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status)
                .not.toBe(EntityStatus.RESERVED);
            await expect.poll(async () => fixture.service.readCapturedPolicy(message, entry)).toMatchObject({
                recipientScope: SCOPE
            });
            expect(fixture.native.sent).toHaveLength(recipient === 'same-scope' ? 1 : 0);
        }
    );

    it.each(['missing', 'tampered', 'expired', 'version', 'broadcast', 'session-global'] as const)(
        'fails closed for %s proof before any native send',
        async (kind) => {
            const fixture = await createFixture();
            const proof = {
                ...fixture.proof,
                ...(kind === 'tampered' ? { digest: '0'.repeat(64) } : {}),
                ...(kind === 'expired' ? { expiresAtMs: 1 } : {}),
                ...(kind === 'version' ? { version: 2 } : {}),
                ...(kind === 'session-global' ? { target: { kind: 'session-global', peerId: 'peer', admittedAudience: ['peer'] } } : {})
            };
            if (kind === 'missing') {
                await fixture.repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key);
            }
            else {
                await fixture.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key, JSON.stringify(proof), fixture.proof.expiresAtMs);
            }
            const entry = kind === 'broadcast'
                ? {
                    ...fixture.entry,
                    resource: JSON.stringify(newALBroadcastMessage('server', fixture.message.route, 'room', 'snapshot.v1', {}, {
                        ttlMs: 30_000,
                        groupRef: { ...SCOPE, groupId: 'room' }
                    }))
                }
                : fixture.entry;
            expect(() => decodePersistedALMessage(entry.resource)).not.toThrow();
            await fixture.stores.workQueue.enqueue(entry);
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
            expect(fixture.native.sent).toEqual([]);
        }
    );

    it.each(['same-scope', 'wrong-scope', 'replaced-session'] as const)(
        'uses captured policy after sidecar removal and fences %s delivery',
        async (recipient) => {
            const fixture = await createFixture();
            const replacement = new TestWebSocket('ws://replacement');
            replacement.open();
            const encode = fixture.socket.encode.bind(fixture.socket);
            vi.spyOn(fixture.socket, 'encode').mockImplementation((message) => {
                if (recipient === 'replaced-session') {
                    fixture.socket.addConnection(new ConnectionContext({ id: 'peer', socket: replacement }));
                }
                return encode(message);
            });
            if (recipient === 'wrong-scope') {
                fixture.authentication.scope = { ...SCOPE, workspaceId: 'other' };
            }
            await fixture.stores.workQueue.enqueue(fixture.entry);
            await fixture.engine.executeOnce();
            await expect.poll(() => fixture.settled.length).toBe(1);
            expect(fixture.native.sent).toHaveLength(recipient === 'same-scope' ? 1 : 0);
            expect(replacement.sent).toEqual([]);
            expect(await fixture.repository.findEntry(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key)).toBeUndefined();
            expect(await fixture.service.readCapturedPolicy(fixture.message, fixture.entry)).toMatchObject({
                admittedAudience: ['peer'],
                recipientScope: SCOPE
            });

            const completed = await fixture.stores.workQueue.getItem(fixture.entry.key);
            if (!completed) {
                throw new Error('Missing admitted row');
            }
            await fixture.stores.workQueue.replaceIfObserved(completed, { ...completed, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
            fixture.engine.wakeAfterExternalWrite();
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(fixture.entry.key))?.status).toBe(EntityStatus.COMPLETED);
            expect(await fixture.service.readCapturedPolicy(fixture.message, fixture.entry)).toMatchObject({
                admittedAudience: ['peer'],
                recipientScope: SCOPE
            });
        }
    );
});

interface ProvenanceDequeueFixture {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly proof: WsOutboxProvenance;
    readonly repository: FakeRuntimeStateRepository;
    readonly key: string;
    readonly socket: JsonWebSocketServer;
    readonly native: TestWebSocket;
    readonly authentication: ProvenanceAuthentication;
    readonly engine: InboxOutboxEngine;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly settled: string[];
    readonly service: WsQueueBoxServerService;
}

async function createFixture(): Promise<ProvenanceDequeueFixture> {
    const message = newALUnicastMessage('server', { topicId: 'snapshot', resourceId: 'page', contextId: 'request' }, 'peer', 'snapshot.v1', {}, {
        ttlMs: 30_000,
        qos: { durability: { algo: 'local-outbox' } }
    });
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
    const proof = createProof(message.id.msgId, entry);
    const repository = new FakeRuntimeStateRepository();
    const key = toWsOutboxProvenanceKey(entry.key);
    await repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, key, JSON.stringify(proof), proof.expiresAtMs);
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const authentication = { scope: SCOPE, principalId: 'principal', expiresAtEpochMs: Date.now() + 30_000 };
    const engine = new InboxOutboxEngine();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const settled: string[] = [];
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        name: 'server',
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        readProducerProvenance: async (message, entry) => {
            const authority = await reader.readProducerProvenance(message, entry);
            await repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, key);
            return authority;
        },
        readAuthenticatedConnectionScope: () => authentication,
        outboundSettlements: (event) => {
            if (event.kind === 'attempt-settled') {
                settled.push(event.outcome);
            }
        }
    });
    onTestFinished(async () => {
        const cleanup = await Promise.allSettled([service.dispose(), engine.stop()]);
        vi.restoreAllMocks();
        const failure = cleanup.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    return { message, entry, proof, repository, key, socket, native, authentication, engine, stores, settled, service };
}

function createProof(messageId: string, entry: ResourceEntry): WsOutboxProvenance {
    const facts: Omit<WsOutboxProvenance, 'digest'> = {
        version: 1,
        producerKind: 'state-sync',
        queueKey: entry.key,
        typeId: entry.typeId,
        messageId,
        senderId: 'server',
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
        target: { kind: 'scoped-unicast', peerId: 'peer', scope: SCOPE, admittedAudience: ['peer'] }
    };
    return { ...facts, digest: computeWsOutboxProvenanceDigest(entry, facts) };
}

interface ProvenanceAuthentication {
    scope: typeof SCOPE;
    principalId: string;
    readonly expiresAtEpochMs: number;
}
