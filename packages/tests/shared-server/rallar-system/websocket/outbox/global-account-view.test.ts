import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { WsQueueBoxServerDeliveryReporting } from '@shared/services/ws-queue-box-server/ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerOutboundPlanning } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { expect, it, onTestFinished, vi } from 'vitest';
import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { captureALOutboundPolicy, decodeALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { applyALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsServerInboundConnectionScopeProof } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { attachTestWebSocket } from '../../../../shared/websocket/attach-test-web-socket.ts';

interface AccountPublicationFixture {
    readonly publication: ViewInvalidationPublication;
    readonly entry: Readonly<ResourceEntry>;
    readonly message: ALMessage;
    readonly reader: WsOutboxProvenanceReader;
}

interface AccountNodeFixture {
    readonly socket: JsonWebSocketServer;
    readonly engine: InboxOutboxEngine;
    readonly service: WsQueueBoxServerService;
    readonly proofs: Map<string, WsServerInboundConnectionScopeProof>;
    readonly natives: Map<string, TestWebSocket>;
}

const ACCOUNT = { version: 1 as const, principalId: 'alice' };

it('binds global proof to the exact account notice without querying scoped session authority', async () => {
    const fixture = await createPublication();
    expect(await fixture.reader.readProducerProvenance(fixture.message, fixture.entry)).toEqual({
        admittedAudience: undefined,
        recipientScope: undefined,
        accountView: ACCOUNT
    });
    expect(fixture.message.targets).toEqual({ mode: 'unicast', toPeerId: 'alice' });
    const forged = {
        ...fixture.message,
        payload: { ...fixture.message.payload, resource: JSON.stringify({ ...JSON.parse(fixture.message.payload.resource), principalId: 'bob' }) }
    };
    await expect(fixture.reader.readProducerProvenance(forged, { ...fixture.entry, resource: JSON.stringify(forged) })).rejects.toBeInstanceOf(
        ALAdmissionCorruptionError
    );
});

it.each(['prepared', 'cluster-local', 'cluster-remote'] as const)(
    'delivers through %s to current own sockets across scopes, including a scope opened after compute',
    async (path) => {
        const fixture = await createPublication();
        const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
        const publisher = createNode(fixture.reader, stores);
        const receiver = path === 'cluster-remote' ? createNode(fixture.reader, stores) : publisher;
        for (const id of ['ar', 'relic', 'bob', 'expired', 'anonymous']) {
            connect(receiver, id);
        }
        const bridge = new RecordingBridge();
        const remoteBridge = new RecordingBridge();
        if (path !== 'prepared') {
            await installQueueBoxPubSubBridge({ wsQBoxServerService: publisher.service, bridge, channel: 'views', publisherId: 'publisher' });
        }
        if (path === 'cluster-remote') {
            await installQueueBoxPubSubBridge({ wsQBoxServerService: receiver.service, bridge: remoteBridge, channel: 'views', publisherId: 'receiver' });
        }
        await stores.workQueue.enqueue(fixture.entry);
        await publisher.engine.executeOnce();
        await expect.poll(async () => (await stores.workQueue.getItem(fixture.entry.key))?.status).toBe('COMPLETED');
        if (path === 'cluster-remote') {
            connect(receiver, 'new-workspace');
            expect(bridge.published).toHaveLength(1);
            expect(JSON.stringify(bridge.published)).not.toContain('alice');
            await remoteBridge.subscriber?.(bridge.published[0]!);
            expect(receiver.natives.get('new-workspace')!.sent).toHaveLength(1);
        }
        await expect.poll(() => receiver.natives.get('ar')!.sent.length).toBe(1);
        expect(receiver.natives.get('relic')!.sent).toHaveLength(1);
        for (const id of ['bob', 'expired', 'anonymous']) {
            expect(receiver.natives.get(id)!.sent).toHaveLength(0);
        }
        const policy = await publisher.service.readCapturedPolicy(fixture.message, fixture.entry, undefined);
        expect(policy.accountView).toEqual(ACCOUNT);
        expect(policy.admittedAudience).toBeUndefined();
        expect(policy.recipientScope).toBeUndefined();
    }
);

it.each(['prepared', 'cluster'] as const)('denies a replacement generation during %s native encoding', async (path) => {
    const fixture = await createPublication();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const node = createNode(fixture.reader, stores);
    const first = connect(node, 'ar');
    const encode = node.socket.encode.bind(node.socket);
    let replacement: TestWebSocket | undefined;
    vi.spyOn(node.socket, 'encode').mockImplementation((message) => {
        replacement = connect(node, 'ar');
        return encode(message);
    });
    if (path === 'cluster') {
        await installQueueBoxPubSubBridge({ wsQBoxServerService: node.service, bridge: new RecordingBridge(), channel: 'views', publisherId: 'publisher' });
    }
    await stores.workQueue.enqueue(fixture.entry);
    await node.engine.executeOnce();
    await expect.poll(async () => (await stores.workQueue.getItem(fixture.entry.key))?.status).toBe('COMPLETED');
    expect(first.sent).toHaveLength(0);
    expect(replacement?.sent).toHaveLength(0);
});

it('rejects missing, mixed, malformed and mismatched account authority at live send and persisted decoding', async () => {
    const fixture = await createPublication();
    const node = createNode(fixture.reader);
    const native = connect(node, 'ar');
    for (
        const input of [
            { message: fixture.message },
            { message: { ...fixture.message, constraints: { expiresAtMs: 0 } }, accountView: ACCOUNT },
            { message: fixture.message, accountView: { ...ACCOUNT, principalId: 'bob' } },
            { message: fixture.message, accountView: ACCOUNT, recipientScope: { applicationId: 'ar', workspaceId: 'default' } },
            { message: { ...fixture.message, payload: { ...fixture.message.payload, typeId: 'forged' } }, accountView: ACCOUNT }
        ]
    ) {
        expect(node.service.sendToTargetsWithResult({ ...input, sentPositions: null }).sentCount).toBe(0);
    }
    const prepared = { kind: 'account-view', accountView: ACCOUNT, message: toALOutboundTransportMessage(fixture.message) };
    expect(() =>
        decodeWsQueueBoxServerPreparedMessage(
            {
                kind: 'scoped-recipient',
                peerId: 'alice',
                connectionId: 'alice',
                generationId: 'generation',
                recipientScope: { applicationId: 'ar', workspaceId: 'default' },
                message: prepared.message
            },
            fixture.message,
            fixture.entry.key
        )
    ).toThrow();
    expect(decodeWsQueueBoxServerPreparedMessage(prepared, fixture.message, fixture.entry.key)).toEqual(prepared);
    expect(() => decodeWsQueueBoxServerPreparedMessage({ ...prepared, accountView: { ...ACCOUNT, principalId: 'bob' } }, fixture.message, fixture.entry.key))
        .toThrow();
    expect(() =>
        decodeWsQueueBoxServerPreparedMessage(
            { ...prepared, recipientScope: { applicationId: 'ar', workspaceId: 'default' } },
            fixture.message,
            fixture.entry.key
        )
    ).toThrow();
    const policy = captureALOutboundPolicy({
        msg: fixture.message,
        lane: 'durable',
        dropReasonCode: undefined,
        preparedMessages: [prepared],
        accountView: ACCOUNT
    });
    expect(decodeALOutboundCapturedPolicy(policy).accountView).toEqual(ACCOUNT);
    expect(applyALOutboundCapturedPolicy({ msg: fixture.message, lane: 'volatile', dropReasonCode: undefined, preparedMessages: [] }, policy).accountView)
        .toEqual(ACCOUNT);
    for (
        const extra of [{ admittedAudience: [] }, { recipientScope: { applicationId: 'ar', workspaceId: 'default' } }, { principalTargetId: 'alice' }, {
            accountView: { version: 2, principalId: 'alice' }
        }]
    ) {
        expect(() => decodeALOutboundCapturedPolicy({ ...policy, ...extra })).toThrow();
    }
    expect(native.sent).toHaveLength(0);
});

it('retries a retained prepared account send for a scope opened after the first failed attempt', async () => {
    const fixture = await createPublication();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const node = createNode(fixture.reader, stores);
    const native = connect(node, 'ar');
    let second: TestWebSocket | undefined;
    vi.spyOn(native, 'send').mockImplementationOnce(() => {
        second = connect(node, 'new-scope');
        throw new Error('temporary native failure');
    });
    await stores.workQueue.enqueue(fixture.entry);
    await node.engine.executeOnce();
    node.engine.start();
    await expect.poll(() => second?.sent.length, { timeout: 10000 }).toBe(1);
    const captured = await node.service.readCapturedPolicy(fixture.message, fixture.entry, undefined);
    expect(captured.accountView).toEqual(ACCOUNT);
    expect(captured.admittedAudience).toBeUndefined();
    expect(native.sent).toHaveLength(1);
});

it('retains explicit account authority in repair planning and refuses substituted account or scoped authority', async () => {
    const fixture = await createPublication();
    const node = createNode(fixture.reader);
    const planner = new WsQueueBoxServerOutboundPlanning({
        serverPeerId: 'server',
        qosProvider: {},
        targetResolution: new WsQueueBoxServerTargetResolution({ socket: node.socket, targetResolver: { requiresFrozenAudience: () => false } }),
        deliveryReporting: new WsQueueBoxServerDeliveryReporting({})
    });
    const request = {
        accountView: ACCOUNT,
        referenceKey: fixture.entry.key,
        trigger: 'repair' as const,
        repair: { enabled: true, algo: 'none' as const, maxAttempts: 1 },
        failedPeerIds: ['departed-session'],
        completedHopPeerIds: [],
        missingRanges: []
    };
    const plan = planner.planRepairMessage(fixture.message, request);
    expect(plan?.accountView).toEqual(ACCOUNT);
    expect(plan?.preparedMessages).toEqual([{ kind: 'account-view', accountView: ACCOUNT, message: toALOutboundTransportMessage(fixture.message) }]);
    expect(planner.planRepairMessage(fixture.message, { ...request, accountView: { ...ACCOUNT, principalId: 'bob' } })).toBeUndefined();
    expect(planner.planRepairMessage(fixture.message, { ...request, recipientScope: { applicationId: 'ar', workspaceId: 'default' } })).toBeUndefined();
});

it('rechecks authenticated account expiry immediately before native submission', async () => {
    const fixture = await createPublication();
    const node = createNode(fixture.reader);
    const native = connect(node, 'ar');
    const encode = node.socket.encode.bind(node.socket);
    vi.spyOn(node.socket, 'encode').mockImplementation((message) => {
        node.proofs.set('ar', { scope: { applicationId: 'ar', workspaceId: 'default' }, principalId: 'alice', expiresAtEpochMs: 0 });
        return encode(message);
    });
    expect(node.service.sendToTargetsWithResult({ message: fixture.message, accountView: ACCOUNT, sentPositions: null }).sentCount).toBe(0);
    expect(native.sent).toHaveLength(0);
});

async function createPublication(): Promise<AccountPublicationFixture> {
    const publication = computeViewInvalidationPublication({
        resource: 'friends',
        scope: null,
        principalIds: ['alice'],
        changeId: crypto.randomUUID(),
        createdAtEpochMs: Date.now(),
        retentionMs: 60000,
        serviceId: 'server',
        traceId: 'trace'
    });
    const entry = publication.outbox[0]!.entry;
    const message = decodePersistedALMessageRow(entry);
    const repository = new FakeRuntimeStateRepository();
    for (const proof of publication.provenance) {
        if (proof.operation !== 'insert') {
            throw new Error('Expected insert');
        }
        await repository.upsert({ namespace: proof.namespace, key: proof.key, value: proof.value, expireAtTimestamp: proof.expireAtTimestamp });
    }
    const reader = new WsOutboxProvenanceReader({
        repository,
        nowMs: Date.now,
        readPrincipalSessionIds: async () => {
            throw new Error('Global account view must not enumerate durable scopes or sessions');
        }
    });
    return { publication, entry, message, reader };
}

function createNode(
    reader: WsOutboxProvenanceReader,
    stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage })
): AccountNodeFixture {
    const socket = new JsonWebSocketServer();
    const engine = new InboxOutboxEngine();
    const proofs = new Map<string, WsServerInboundConnectionScopeProof>();
    const natives = new Map<string, TestWebSocket>();
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        socket,
        inboundVolatileStores: undefined,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry),
        readAuthenticatedConnectionScope: (connection) => proofs.get(connection.id)
    });
    onTestFinished(async () => {
        await service.dispose();
        await engine.stop();
    });
    return { socket, engine, service, proofs, natives };
}

function connect(node: AccountNodeFixture, id: string): TestWebSocket {
    const native = new TestWebSocket(`ws://${id}`);
    native.open();
    node.natives.set(id, native);
    attachTestWebSocket(node.socket, new ConnectionContext({ id, socket: native, generationId: crypto.randomUUID() }));
    if (id !== 'anonymous') {
        node.proofs.set(id, {
            scope: { applicationId: id, workspaceId: 'default' },
            principalId: id === 'bob' ? 'bob' : 'alice',
            expiresAtEpochMs: id === 'expired' ? 0 : Date.now() + 60000
        });
    }
    return native;
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
