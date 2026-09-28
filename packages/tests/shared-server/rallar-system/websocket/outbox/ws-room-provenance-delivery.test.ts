import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installQueueBoxPubSubBridge, toPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundPlanningAuthority } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room' };

describe('verified direct room row delivery', () => {
    it('keeps direct row exclusions at the cluster socket boundary', async () => {
        const fixture = new RoomFixture();
        const bridge = new RecordingBridge();
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: fixture.service,
            bridge,
            channel: 'events',
            publisherId: 'local',
            filterEligibleCapturedSessionIds: (input) => input.candidateSessionIds
        });
        await fixture.publish(['session', 'late'], 'excluded');
        await fixture.engine.executeOnce();
        await expect.poll(() => bridge.published.length).toBe(1);
        expect(fixture.native.get('session')!.sent).toEqual([]);
        expect(fixture.native.get('late')!.sent).toHaveLength(1);
    });
    it('replaces the observed direct key, scope, and audience together when canonical admission wins', async () => {
        const fixture = new RoomFixture();
        const message = newALBroadcastMessage('server', { topicId: 'snapshot', resourceId: 'room', contextId: 'event' }, 'room', 'snapshot.v1', {}, {
            ttlMs: 30_000,
            groupRef: ROOM,
            qos: { durability: { algo: 'local-outbox' } }
        });
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
        const winner = await fixture.service.enqueueOutboxIfAbsent(message, ['winner-peer'], SCOPE);
        expect(winner.verdict.kind).toBe('admitted');
        const authorities: (ALOutboundPlanningAuthority | undefined)[] = [];
        await fixture.stores.admissionStore.readOutgoingMessage({
            msg: message,
            observedCanonicalEntry: entry,
            intent: 'dequeue',
            dequeueAuthority: { admittedAudience: ['session'], recipientScope: { ...SCOPE, workspaceId: 'stale' } },
            planner: (msg, authority) => {
                authorities.push(authority);
                return { msg, persist: true, dropReasonCode: undefined, preparedMessages: [] };
            }
        });
        expect(authorities).toEqual([{
            admittedAudience: ['winner-peer'],
            recipientScope: SCOPE,
            referenceKey: winner.entry!.key
        }]);
    });
    it('publishes the winning canonical row when its admission races the verified direct dequeue', async () => {
        const fixture = new RoomFixture();
        const bridge = new RecordingBridge();
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: fixture.service,
            bridge,
            channel: 'events',
            publisherId: 'local',
            filterEligibleCapturedSessionIds: (input) => input.candidateSessionIds
        });
        const winnerEngine = new InboxOutboxEngine();
        const winnerService = createDefaultWsQueueBoxServerService({
            name: 'server',
            socket: new JsonWebSocketServer(),
            outbox: fixture.stores.workQueue,
            outboundStores: fixture.stores,
            queueEngine: winnerEngine
        });
        onTestFinished(() => {
            winnerService.dispose();
            winnerEngine.stop();
        });
        const readProof = fixture.reader.readProducerProvenance.bind(fixture.reader);
        vi.spyOn(fixture.reader, 'readProducerProvenance').mockImplementationOnce(async (message, entry) => {
            const authority = await readProof(message, entry);
            const winner = await winnerService.enqueueOutboxIfAbsent(message, ['session'], SCOPE);
            expect(winner.verdict.kind).toBe('admitted');
            return authority;
        });
        const { message, entry } = await fixture.publish(['late']);
        await fixture.engine.executeOnce();
        await expect.poll(() => bridge.published.length).toBeGreaterThan(0);
        const winner = await fixture.stores.admissionStore.readSentMessage(message.id.msgId);
        expect(winner?.outboxKey?.topicId).toBe('AL_OUTBOUND_MESSAGE');
        expect(bridge.published.map((publication) => publication.key)).toEqual([winner!.outboxKey]);
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(fixture.native.get('peer-socket')!.sent).toHaveLength(1);
        expect(JSON.parse(fixture.native.get('peer-socket')!.sent[0]!)).toEqual(winner!.msg);
        expect(fixture.native.get('session')!.sent).toEqual([]);
        expect(fixture.native.get('late')!.sent).toEqual([]);
    });
    it('keeps canonical room bridge delivery peer-based with the same captured IDs', async () => {
        const fixture = new RoomFixture();
        const bridge = new RecordingBridge();
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: fixture.service,
            bridge,
            channel: 'events',
            publisherId: 'local',
            filterEligibleCapturedSessionIds: (input) => input.candidateSessionIds
        });
        const message = newALBroadcastMessage('server', { topicId: 'snapshot', resourceId: 'room', contextId: 'event' }, 'room', 'snapshot.v1', {}, {
            ttlMs: 30_000,
            groupRef: ROOM,
            qos: { durability: { algo: 'local-outbox' } }
        });
        await fixture.service.enqueueOutboxIfAbsent(message, ['session'], SCOPE);
        await fixture.engine.executeOnce();
        await expect.poll(() => bridge.published.length).toBe(1);
        expect(fixture.native.get('peer-socket')!.sent).toHaveLength(1);
        expect(fixture.native.get('session')!.sent).toEqual([]);
    });
    it('freezes session identity through first dequeue and restarted delivery after proof removal', async () => {
        const fixture = new RoomFixture();
        const { message, entry } = await fixture.publish(['session']);
        await fixture.engine.executeOnce();
        await expect.poll(() => fixture.native.get('session')!.sent.length).toBe(1);
        expect(fixture.native.get('peer-socket')!.sent).toEqual([]);
        expect(fixture.native.get('late')!.sent).toEqual([]);
        expect(await fixture.service.readCapturedPolicy(message, entry)).toMatchObject({ admittedAudience: ['session'], recipientScope: SCOPE });
        await fixture.repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(entry.key));
        fixture.restart();
        await fixture.redeliver(entry);
        expect(await fixture.service.readCapturedPolicy(message, entry)).toMatchObject({ admittedAudience: ['session'], recipientScope: SCOPE });
        expect(fixture.native.get('peer-socket')!.sent).toEqual([]);
        expect(fixture.native.get('late')!.sent).toEqual([]);
    });

    it('retries a failed native send after restart without its removed producer sidecar', async () => {
        const fixture = new RoomFixture();
        const readProof = fixture.reader.readProducerProvenance.bind(fixture.reader);
        vi.spyOn(fixture.reader, 'readProducerProvenance').mockImplementation(async (message, entry) => {
            const authority = await readProof(message, entry);
            await fixture.repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(entry.key));
            return authority;
        });
        const send = vi.spyOn(fixture.socket, 'sendEncoded').mockImplementation(() => {
            throw new Error('Transport unavailable before restart');
        });
        const { entry } = await fixture.publish(['session']);
        await fixture.engine.executeOnce();
        await expect.poll(() => send.mock.calls.length).toBeGreaterThan(0);
        fixture.restart();
        send.mockRestore();
        expect(await fixture.repository.findEntry(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(entry.key))).toBeUndefined();
        await expect.poll(async () => {
            fixture.engine.wakeAfterExternalWrite();
            await fixture.engine.executeOnce();
            return fixture.native.get('session')!.sent.length;
        }).toBe(1);
        expect(fixture.native.get('peer-socket')!.sent).toEqual([]);
        expect(fixture.native.get('late')!.sent).toEqual([]);
    });

    it.each(['wrong-scope', 'replaced-generation', 'expired-auth', 'empty'] as const)('refuses %s recipients', async (kind) => {
        const fixture = new RoomFixture();
        const { entry } = await fixture.publish(kind === 'empty' ? [] : ['session']);
        if (kind === 'wrong-scope') {
            fixture.authentication.scope = { ...SCOPE, workspaceId: 'other' };
        }
        if (kind === 'expired-auth') {
            fixture.authentication.expiresAtEpochMs = 0;
        }
        if (kind === 'replaced-generation') {
            const encode = fixture.socket.encode.bind(fixture.socket);
            vi.spyOn(fixture.socket, 'encode').mockImplementation((message) => {
                fixture.addSocket('session');
                return encode(message);
            });
        }
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect([...fixture.native.values()].flatMap((native) => native.sent)).toEqual([]);
    });

    it.each(['missing', 'wrong-room', 'broad', 'principal', 'forged-canonical-key'] as const)('refuses %s provenance', async (kind) => {
        const fixture = new RoomFixture();
        const { entry } = await fixture.publish(['session'], kind);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect([...fixture.native.values()].flatMap((native) => native.sent)).toEqual([]);
    });

    it.each(['local', 'remote'] as const)('carries frozen room sessions and scope through the %s bridge send', async (placement) => {
        const fixture = new RoomFixture();
        const bridge = new RecordingBridge();
        const captured: { audience: readonly string[]; scope: StateScope | undefined; }[] = [];
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: fixture.service,
            bridge,
            channel: 'events',
            publisherId: 'local',
            filterEligibleCapturedSessionIds: (input) => {
                captured.push({ audience: input.candidateSessionIds, scope: input.recipientScope });
                return input.candidateSessionIds;
            }
        });
        if (placement === 'remote') {
            fixture.socket.connections.clear();
        }
        const { entry } = await fixture.publish(['session']);
        await fixture.engine.executeOnce();
        await expect.poll(() => bridge.published.length).toBe(1);
        if (placement === 'remote') {
            fixture.addSocket('session');
            fixture.addSocket('late');
            await bridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'remote', entry }));
        }
        expect(fixture.native.get('session')!.sent).toHaveLength(1);
        expect(fixture.native.get('late')!.sent).toEqual([]);
        expect(captured).toContainEqual({ audience: ['session'], scope: SCOPE });
        fixture.authentication.scope = { ...SCOPE, workspaceId: 'other' };
        await bridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'remote', entry }));
        expect(fixture.native.get('session')!.sent).toHaveLength(1);
    });
});

class RoomFixture {
    readonly repository = new FakeRuntimeStateRepository();
    readonly socket = new JsonWebSocketServer();
    readonly native = new Map<string, TestWebSocket>();
    readonly authentication = { scope: SCOPE, expiresAtEpochMs: Date.now() + 60_000 };
    readonly stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    readonly reader = new WsOutboxProvenanceReader({ repository: this.repository, nowMs: Date.now });
    engine = new InboxOutboxEngine();
    service = this.createService();

    constructor() {
        for (const id of ['session', 'peer-socket', 'late']) {
            this.addSocket(id);
        }
        onTestFinished(() => {
            this.service.dispose();
            this.engine.stop();
            vi.restoreAllMocks();
        });
    }

    addSocket(id: string): void {
        const native = new TestWebSocket(`ws://${id}`);
        native.open();
        this.native.set(id, native);
        this.socket.addConnection(new ConnectionContext({ id, socket: native }));
    }

    createService() {
        return createDefaultWsQueueBoxServerService({
            name: 'server',
            socket: this.socket,
            outbox: this.stores.workQueue,
            outboundStores: this.stores,
            queueEngine: this.engine,
            targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'session', connectionId: 'peer-socket' }] },
            readProducerProvenance: (message, entry) => this.reader.readProducerProvenance(message, entry),
            readAuthenticatedConnectionScope: () => this.authentication
        });
    }

    restart(): void {
        this.service.dispose();
        this.engine.stop();
        this.engine = new InboxOutboxEngine();
        this.service = this.createService();
    }

    async redeliver(entry: ResourceEntry): Promise<void> {
        const completed = await this.stores.workQueue.getItem(entry.key);
        if (!completed) {
            throw new Error('Missing completed room row');
        }
        await this.stores.workQueue.replaceIfObserved(completed, { ...completed, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
        this.engine.wakeAfterExternalWrite();
        await this.engine.executeOnce();
        await expect.poll(async () => (await this.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    }

    async publish(audience: readonly string[], corruption = '') {
        const broadcast = newALBroadcastMessage(
            'server',
            { topicId: 'snapshot', resourceId: 'room', contextId: 'event' },
            corruption === 'broad' ? 'all' : 'room',
            'snapshot.v1',
            {},
            {
                ttlMs: 30_000,
                groupRef: ROOM,
                ...(corruption === 'excluded' ? { exceptPeerIds: ['session'] } : {}),
                qos: { durability: { algo: 'local-outbox' } }
            }
        );
        const message: ALMessage = corruption === 'principal'
            ? { ...broadcast, targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...SCOPE, principalId: 'principal' } } }
            : broadcast;
        const raw = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
        expect(decodePersistedALMessage(raw.resource)).toEqual(message);
        const entry = corruption === 'forged-canonical-key' ? { ...raw, key: { ...raw.key, topicId: 'AL_OUTBOUND_MESSAGE' } } : raw;
        const proof = await createProof(message, entry, { audience, wrongRoom: corruption === 'wrong-room' });
        if (corruption !== 'missing') {
            await this.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(entry.key), JSON.stringify(proof), proof.expiresAtMs);
        }
        await this.stores.workQueue.enqueue(entry);
        return { message, entry };
    }
}

interface RoomProofInput {
    readonly audience: readonly string[];
    readonly wrongRoom: boolean;
}

async function createProof(message: ALMessage, entry: ResourceEntry, input: RoomProofInput): Promise<WsOutboxProvenance> {
    const facts: Omit<WsOutboxProvenance, 'digest'> = {
        version: 1,
        producerKind: 'state-sync-snapshot',
        queueKey: entry.key,
        typeId: entry.typeId,
        messageId: message.id.msgId,
        senderId: 'server',
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
        target: { kind: 'scoped-room-broadcast', groupRef: input.wrongRoom ? { ...ROOM, groupId: 'other' } : ROOM, admittedAudience: input.audience }
    };
    return { ...facts, digest: await computeWsOutboxProvenanceDigest(entry, facts) };
}

class RecordingBridge implements QueueBoxPubSubBridge {
    readonly published: QueueBoxPubSubMessage[] = [];
    subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;

    async publish(_channel: string, message: QueueBoxPubSubMessage): Promise<void> {
        this.published.push(message);
    }

    async subscribe(_channel: string, subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1]): Promise<void> {
        this.subscriber = subscriber;
    }
}
