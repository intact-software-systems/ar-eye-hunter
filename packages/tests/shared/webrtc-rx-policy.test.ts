import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as shared from '@shared/mod.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import type { OnQRtcMessageCallback } from '@shared/webrtc/qrtc-client-callbacks.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { RtcEndpointFixture } from './rtc-endpoint-fixture.ts';
import { waitForALInboundWork } from './wait-for-al-inbound-work.ts';

const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' };

describe('WebRtcRxStreamerService channel receive pipeline', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(['specific', 'wildcard'] as const)('marks a message rejected by the %s consumer NON_RETRYABLE', async (consumer) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const fixture = createRtcReceiveFixture();
        const rejected: string[] = [];
        const callback = {
            onMessage: async (message: shared.ALMessage) => {
                rejected.push(message.id.msgId);
                throw new NonRetryableException('Malformed application payload');
            }
        };
        if (consumer === 'specific') {
            fixture.service.onInboxMessageDo('tasks.job.v1', callback);
        }
        else {
            fixture.service.onAllInboxMessagesDo(callback);
        }
        const message = createUnicast({ acknowledge: false, exclusive: false });

        await fixture.receive(message, 'peer-1');

        const rejectedPage = await fixture.stores.workQueue.readWorkPage({
            typeId: toALInboundWorkType(fixture.stores.admissionStore.namespace),
            status: EntityStatus.NON_RETRYABLE,
            maxToRead: 10,
            cursor: null
        });
        expect(rejectedPage.entries).toHaveLength(1);
        expect(rejectedPage.entries[0]).toMatchObject({ dequeueAudit: { attempts: 1, nextTs: undefined } });

        vi.setSystemTime(Date.now() + 60_000);
        await fixture.receive(message, 'peer-1');

        expect(rejected).toEqual([message.id.msgId]);
        expect(await fixture.stores.workQueue.getItem(rejectedPage.entries[0].key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
    });

    it('keeps accepted channel work unclaimed until a matching consumer registers', async () => {
        const fixture = createRtcReceiveFixture();
        const message = createUnicast({ acknowledge: false, exclusive: false });
        await fixture.receive(message, 'peer-1');
        const keys = await fixture.stores.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        expect(await fixture.stores.workQueue.getItem(keys[0])).toMatchObject({ status: 'NEW', dequeueAudit: { attempts: 0 } });
        const delivered: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (incoming) => {
                delivered.push(incoming.id.msgId);
            }
        });

        await expect.poll(() => fixture.stores.workQueue.getItem(keys[0])).toMatchObject({ status: 'COMPLETED', dequeueAudit: { attempts: 1 } });
        expect(delivered).toEqual([message.id.msgId]);
    });

    it('restarts owned delivery without requiring new channel ingress', async () => {
        const fixture = createRtcReceiveFixture();
        const message = createUnicast({ acknowledge: false, exclusive: false });
        await fixture.receive(message, 'peer-1');
        fixture.service.dispose();
        const resumed = createRtcReceiveFixture(fixture.stores);
        const delivered: string[] = [];
        resumed.service.onInboxMessageDo('tasks.job.v1', {
            onMessage: async (incoming) => {
                delivered.push(incoming.id.msgId);
            }
        });

        await expect.poll(() => delivered).toEqual([message.id.msgId]);
        const keys = await fixture.stores.workQueue.getAllKeys();
        expect(await fixture.stores.workQueue.getItem(keys[0])).toMatchObject({ status: 'COMPLETED', dequeueAudit: { attempts: 1 } });
    });

    it.each([-1, 0, 1])('checks remaining consumer expiry after a handler returns at deadline %+i ms', async (offsetMs) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const fixture = createRtcReceiveFixture();
        const expiresAtMs = Date.now() + 1_000;
        const delivered: string[] = [];
        fixture.service.onInboxMessageDo('tasks.job.v1', {
            onMessage: async () => {
                delivered.push('specific');
                await Promise.resolve();
                vi.setSystemTime(expiresAtMs + offsetMs);
            }
        });
        fixture.service.onAllInboxMessagesDo({
            onMessage: async () => {
                delivered.push('wildcard');
            }
        });
        const message = { ...createUnicast({ acknowledge: false, exclusive: false }), constraints: { expiresAtMs } };

        await fixture.receive(message, 'peer-1');

        expect(delivered).toEqual(offsetMs < 0 ? ['specific', 'wildcard'] : ['specific']);
    });

    it('retries an ordinary consumer failure and completes after the consumer succeeds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const fixture = createRtcReceiveFixture();
        const attempts: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                attempts.push(message.id.msgId);
                if (attempts.length === 1) {
                    throw new Error('Application dependency temporarily unavailable');
                }
            }
        });
        const message = createUnicast({ acknowledge: false, exclusive: false });

        await fixture.receive(message, 'peer-1');

        const retryPage = await fixture.stores.workQueue.readWorkPage({
            typeId: toALInboundWorkType(fixture.stores.admissionStore.namespace),
            status: EntityStatus.RETRY,
            maxToRead: 10,
            cursor: null
        });
        expect(retryPage.entries).toHaveLength(1);
        const retry = retryPage.entries[0];
        expect(retry.dequeueAudit.attempts).toBe(1);
        expect(retry.dequeueAudit.nextTs).toBeDefined();

        vi.setSystemTime(retry.dequeueAudit.nextTs!.epochMilliseconds);
        await fixture.receive(message, 'peer-1');

        await expect.poll(() => fixture.stores.workQueue.getItem(retry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 2, nextTs: undefined }
        });
        expect(attempts).toEqual([message.id.msgId, message.id.msgId]);
    });

    it('does not publish admitted channel work after its owning streamer is disposed', async () => {
        const fixture = createRtcReceiveFixture();
        const delivered: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const commit = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const result = await commit(bundle);
            fixture.service.dispose();
            return result;
        });

        await fixture.receive(createUnicast({ acknowledge: false, exclusive: false }), 'peer-1');

        expect(delivered).toEqual([]);
        expect(await fixture.outbound()).toEqual([]);
    });

    it('stops later consumers when disposed during a handler', async () => {
        const fixture = createRtcReceiveFixture();
        const started = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        onTestFinished(() => resume.resolve());
        const delivered: string[] = [];
        fixture.service.onInboxMessageDo('tasks.job.v1', {
            onMessage: async () => {
                started.resolve();
                await resume.promise;
            }
        });
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const receiving = fixture.receive(createUnicast({ acknowledge: false, exclusive: false }), 'peer-1');
        await started.promise;

        fixture.service.dispose();
        resume.resolve();
        await receiving;

        expect(delivered).toEqual([]);
    });

    it('delivers a repeated channel message once and acknowledges its message identity', async () => {
        const fixture = createRtcReceiveFixture();
        const delivered: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const message = createUnicast({ acknowledge: true, exclusive: false });

        await fixture.receive(message, 'peer-1');
        await fixture.receive(message, 'peer-1');

        expect(delivered).toEqual([message.id.msgId]);
        expect((await fixture.outbound()).map(shared.parseALControlMessage)).toContainEqual({
            type: 'ack',
            payload: expect.objectContaining({ ackedMsgId: message.id.msgId, toPeerId: 'peer-1', status: 'delivered' })
        });
    });

    it('requests current room authority when durable admission waits for a newer snapshot', async () => {
        const roomAuthorityRefresh = {
            afterInboundAdmission: vi.fn(async () => undefined),
            dispose: vi.fn()
        };
        const fixture = createRtcReceiveFixture(
            shared.createDefaultInMemoryALInboundRuntimeStores(),
            roomAuthorityRefresh
        );
        const message = createMulticast({
            seq: 1,
            acknowledgeSubtree: false,
            minSnapshotVersion: 2
        });

        await fixture.receive(message, 'peer-1');

        expect(roomAuthorityRefresh.afterInboundAdmission).toHaveBeenCalledWith(
            message,
            { kind: 'not-admitted', reason: 'not-yet-in-sync: Awaiting the required room snapshot version' }
        );
    });

    it('disposes the owned room-authority refresh with the receive runtime', () => {
        let disposed = false;
        const fixture = createRtcReceiveFixture(
            shared.createDefaultInMemoryALInboundRuntimeStores(),
            {
                afterInboundAdmission: async () => undefined,
                dispose: () => {
                    disposed = true;
                }
            }
        );

        fixture.service.dispose();

        expect(disposed).toBe(true);
    });

    it.each([true, false])('routes exclusive delivery to a specific consumer when registered=%s, otherwise the catch-all', async (specific) => {
        const fixture = createRtcReceiveFixture();
        const delivered: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async () => {
                delivered.push('catch-all');
            }
        });
        if (specific) {
            fixture.service.onInboxMessageDo('tasks.job.v1', {
                onMessage: async () => {
                    delivered.push('specific');
                }
            });
        }

        await fixture.receive(createUnicast({ acknowledge: false, exclusive: true }), 'peer-1');

        expect(delivered).toEqual([specific ? 'specific' : 'catch-all']);
    });

    it('receives an ordered gap through the channel, emits repair controls, then releases local delivery', async () => {
        const fixture = createRtcReceiveFixture();
        const delivered: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const first = createMulticast({ seq: 1, acknowledgeSubtree: false });
        const second = createMulticast({ seq: 2, acknowledgeSubtree: false });

        await fixture.receive(second, 'peer-1');

        expect(delivered).toEqual([]);
        expect(
            (await fixture.outbound()).flatMap((message) => {
                const control = shared.parseALControlMessage(message);
                return control ? [control.type] : [];
            }).sort()
        ).toEqual(['nack', 'repair']);

        await fixture.receive(first, 'peer-1');

        await expect.poll(() => delivered).toEqual([first.id.msgId, second.id.msgId]);
        await expect.poll(async () => (await fixture.outbound()).map((message) => message.id.msgId))
            .toEqual(expect.arrayContaining([first.id.msgId, second.id.msgId]));
    });

    it('keeps child controls out of application delivery and acknowledges upstream after both children', async () => {
        const fixture = createRtcReceiveFixture();
        const delivered: string[] = [];
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const message = createMulticast({ seq: 1, acknowledgeSubtree: true });

        await fixture.receive(message, 'peer-1');
        await fixture.receive(
            shared.newALAckControlMessage({ v: 2, msgId: 'ack-peer-2', ts: Date.now(), senderId: 'peer-2' }, {
                fromPeerId: 'peer-2',
                toPeerId: 'self',
                ackedMsgId: message.id.msgId,
                status: 'delivered',
                observedAtEpochMs: Date.now()
            }),
            'peer-2'
        );
        expect((await fixture.outbound()).filter((outgoing) => shared.parseALControlMessage(outgoing)?.type === 'ack')).toEqual([]);

        await fixture.receive(
            shared.newALAckControlMessage({ v: 2, msgId: 'ack-peer-3', ts: Date.now(), senderId: 'peer-3' }, {
                fromPeerId: 'peer-3',
                toPeerId: 'self',
                ackedMsgId: message.id.msgId,
                status: 'delivered',
                observedAtEpochMs: Date.now()
            }),
            'peer-3'
        );

        expect(delivered).toEqual([message.id.msgId]);
        expect((await fixture.outbound()).map(shared.parseALControlMessage)).toContainEqual({
            type: 'ack',
            payload: expect.objectContaining({ status: 'subtree-complete', toPeerId: 'peer-1', ackedMsgId: message.id.msgId })
        });
    });
});

interface RtcReceiveFixture {
    readonly service: shared.WebRtcRxStreamerService;
    readonly stores: shared.ALInboundRuntimeStores;
    receive(message: shared.ALMessage, peerId: string): Promise<void>;
    outbound(): Promise<shared.ALMessage[]>;
}

function createRtcReceiveFixture(
    stores = shared.createDefaultInMemoryALInboundRuntimeStores(),
    roomAuthorityRefresh?: shared.WebRtcRxStreamerService.Input['roomAuthorityRefresh']
): RtcReceiveFixture {
    const transport = createRtcReceiveTransport();
    const multicast = createRtcRoomMulticast(transport.connections);
    const service = shared.createDefaultWebRtcRxStreamerService({
        multicast,
        sessionId: 'self',
        inboundStores: stores,
        roomAuthorityRefresh
    });
    for (const peer of transport.peers.values()) {
        service.addPeer(peer);
    }
    onTestFinished(() => {
        service.dispose();
        for (const peer of transport.peers.values()) {
            service.removePeer(peer);
        }
        multicast.dispose();
    });
    return {
        service,
        stores,
        async receive(message: shared.ALMessage, peerId: string): Promise<void> {
            await transport.receive(message, peerId);
            await waitForALInboundWork();
        },
        async outbound(): Promise<shared.ALMessage[]> {
            return [...transport.sent];
        }
    };
}

interface RtcChannelPorts {
    readonly signaler: shared.QRtcSignalingTransport;
    readonly iceCandidates: shared.IceConfig;
    readonly receivers: Map<string, OnQRtcMessageCallback>;
    readonly sent: shared.ALMessage[];
}

interface RtcReceiveTransport {
    readonly connections: shared.WebRtcConnectionService;
    readonly peers: Map<string, shared.QRtcPeerDto>;
    readonly sent: shared.ALMessage[];
    receive(message: shared.ALMessage, peerId: string): Promise<void>;
}

function createRtcReceiveTransport(): RtcReceiveTransport {
    const peers = new Map<string, shared.QRtcPeerDto>();
    const receivers = new Map<string, OnQRtcMessageCallback>();
    const sent: shared.ALMessage[] = [];
    const signaler = { send: async () => undefined, connect: async () => undefined };
    const iceCandidates = { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
    const connections = new shared.WebRtcConnectionService(signaler, {
        sessionId: 'self',
        token: 'test-token',
        faultPort: createPassThroughTransportFaultPort(),
        iceCandidates,
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    });
    vi.spyOn(connections, 'readyPeerIdsForLane').mockImplementation(() => [...peers.keys()]);
    vi.spyOn(connections, 'readPeer').mockImplementation((peerId) => peers.get(peerId));
    for (const peerId of ['peer-1', 'peer-2', 'peer-3']) {
        peers.set(peerId, createRtcChannelPeer(peerId, { signaler, iceCandidates, receivers, sent }));
    }
    return {
        connections,
        peers,
        sent,
        async receive(message: shared.ALMessage, peerId: string): Promise<void> {
            const callback = receivers.get(peerId);
            if (!callback) {
                throw new Error(`No RTC receive subscription for ${peerId}`);
            }
            await callback.onMessage(message, new MessageEvent('message', { data: JSON.stringify(message) }));
        }
    };
}

function createRtcChannelPeer(peerId: string, ports: RtcChannelPorts): shared.QRtcPeerDto {
    const connection = new shared.QRtcPeerConnection(ports.signaler, {
        sessionId: 'self',
        peerSessionId: peerId,
        token: 'test-token',
        iceCandidates: ports.iceCandidates,
        isPolite: false
    });
    const channel = new shared.QRtcDataChannel(connection, {
        faultPort: createPassThroughTransportFaultPort(),
        peerId,
        dataChannelName: 'test'
    });
    vi.spyOn(channel, 'onRtcMessageDo').mockImplementation((_id, callback) => {
        ports.receivers.set(peerId, callback);
        return channel;
    });
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...channel.readHealth(), readyState: 'open' });
    vi.spyOn(channel, 'sendJson').mockImplementation((message) => {
        ports.sent.push(decodePersistedALMessageValue(message));
        return { status: 'sent', bufferedAmount: 0 };
    });
    return {
        peerId,
        connection,
        channel,
        channels: new Map([['reliable', channel]]),
        media: new shared.QRtcMediaChannel(connection, { peerId })
    };
}

function createRtcRoomMulticast(
    connections: shared.WebRtcConnectionService
): shared.WebRtcOverlayMulticastManager {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['self', 'peer-1', 'peer-2', 'peer-3'] });
    const groupCache = new shared.LatestRepository<string, GroupSnapshot>();
    groupCache.accept('group-1', {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 }))
    });
    const overlayCache = new shared.LatestRepository<string, shared.OverlayInfo>();
    overlayCache.accept('group-1', {
        sourceGroupStateCausalRevision: snapshot.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: 'group-1',
        groupRef: roomRef,
        topology: 'tree',
        name: 'test',
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        nextHopSessionIds: ['peer-2', 'peer-3'],
        degreeLimit: 2,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    });
    return new shared.WebRtcOverlayMulticastManager({
        connectionService: connections,
        groupCache,
        overlayCache,
        multicasterFactory: (overlayId) => new shared.WebRtcOverlayMulticastService(overlayId, connections),
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
        circuitBreaker: shared.toCircuitBreaker(),
        rateLimiter: shared.toRateLimiter(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
}

function createUnicast(input: { readonly acknowledge: boolean; readonly exclusive: boolean; }): shared.ALMessage {
    return shared.newALUnicastMessage('peer-1', { topicId: 'tasks', resourceId: 'job', contextId: 'queue' }, 'self', 'tasks.job.v1', { text: 'hello' }, {
        qos: {
            ack: { algo: input.acknowledge ? 'hop' : 'none' },
            ownership: { algo: input.exclusive ? 'exclusive' : 'shared' }
        }
    });
}

function createMulticast(input: {
    readonly seq: number;
    readonly acknowledgeSubtree: boolean;
    readonly minSnapshotVersion?: number;
}): shared.ALMessage {
    return shared.newALMulticastMessage(
        'peer-1',
        {
            topicId: 'chat',
            resourceId: `message-${input.seq}`,
            contextId: 'group-1'
        },
        roomRef,
        'chat.message.v1',
        { text: `message ${input.seq}` },
        {
            seq: input.seq,
            reliability: 'at-least-once',
            ack: input.acknowledgeSubtree ? 'all-logical-recipients' : 'none',
            minSnapshotVersion: input.minSnapshotVersion
        }
    );
}

const endpoints: RtcEndpointFixture[] = [];

afterEach(() => {
    for (const endpoint of endpoints.splice(0)) {
        endpoint.close();
    }
    vi.restoreAllMocks();
});

describe('RTC receiver consumer dispatch', () => {
    it('delivers exclusive messages only to the matching consumer', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const receivedByType: string[] = [];
        receiver.streamer.onInboxMessageDo('tasks.job.v1', {
            onMessage: async (message) => {
                receivedByType.push(message.id.msgId);
            }
        });
        const message = exclusiveMessage();

        await sender.sendAndWaitForDelivery(message);
        await sender.sendAndWaitForDelivery(message);

        expect(receivedByType).toEqual([message.id.msgId]);
        expect(receiver.delivered).toEqual([]);
    });

    it('delivers exclusive messages to the wildcard consumer when no type consumer exists', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const message = exclusiveMessage();

        await sender.sendAndWaitForDelivery(message);

        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
    });

    it('delivers shared messages to type and wildcard consumers and sends a correlated receiver ACK', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const receivedByType: string[] = [];
        receiver.streamer.onInboxMessageDo('chat.message.v1', {
            onMessage: async (message) => {
                receivedByType.push(message.id.msgId);
            }
        });
        const message = newALUnicastMessage(
            'sender',
            {
                topicId: 'chat',
                resourceId: 'message',
                contextId: 'conversation'
            },
            'receiver',
            'chat.message.v1',
            { text: 'hello' },
            {
                qos: { ack: { algo: 'hop', opts: { timeoutMs: 1000 } }, durability: { algo: 'volatile' } }
            }
        );

        await sender.sendAndWaitForDelivery(message);

        await expect.poll(() => receivedByType).toEqual([message.id.msgId]);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        await expect.poll(() => receiver.sent.filter((entry) => entry.payload.typeId === AL_CONTROL_ACK_TYPE_ID))
            .toHaveLength(1);
        const acknowledgements = receiver.sent.filter((entry) => entry.payload.typeId === AL_CONTROL_ACK_TYPE_ID);
        expect(JSON.parse(acknowledgements[0].payload.resource)).toMatchObject({
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            ackedMsgId: message.id.msgId,
            status: 'delivered'
        });
    });
});

interface ConnectedEndpoints {
    readonly sender: RtcEndpointFixture;
    readonly receiver: RtcEndpointFixture;
}

function createConnectedEndpoints(): ConnectedEndpoints {
    const sender = new RtcEndpointFixture('sender', 'receiver');
    const receiver = new RtcEndpointFixture('receiver', 'sender');
    endpoints.push(sender, receiver);
    sender.connect(receiver);
    receiver.connect(sender);
    return { sender, receiver };
}

function exclusiveMessage() {
    return newALUnicastMessage(
        'sender',
        {
            topicId: 'tasks',
            resourceId: 'job',
            contextId: 'queue'
        },
        'receiver',
        'tasks.job.v1',
        { text: 'claim me' },
        {
            qos: { ownership: { algo: 'exclusive' }, durability: { algo: 'volatile' } }
        }
    );
}
