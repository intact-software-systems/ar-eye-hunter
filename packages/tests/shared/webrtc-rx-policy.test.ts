import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage, decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as shared from '@shared/mod.ts';
import type { OnQRtcMessageCallback } from '@shared/webrtc/QRtcClientCallbacks.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { RtcEndpointFixture } from './rtc-endpoint-fixture.ts';

const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' };

describe('WebRtcRxStreamerService channel receive pipeline', () => {
    afterEach(() => vi.restoreAllMocks());

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

        expect(delivered).toEqual([first.id.msgId, second.id.msgId]);
        expect((await fixture.outbound()).map((message) => message.id.msgId)).toEqual(expect.arrayContaining([first.id.msgId, second.id.msgId]));
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
        await fixture.receive(shared.newALAckControlMessage('peer-2', 'self', message.id.msgId, 'delivered'), 'peer-2');
        expect((await fixture.outbound()).filter((outgoing) => shared.parseALControlMessage(outgoing)?.type === 'ack')).toEqual([]);

        await fixture.receive(shared.newALAckControlMessage('peer-3', 'self', message.id.msgId, 'delivered'), 'peer-3');

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

function createRtcReceiveFixture(): RtcReceiveFixture {
    const transport = createRtcReceiveTransport();
    const outbox = new shared.InMemoryQueueBox(new Map());
    const multicast = createRtcRoomMulticast(transport.connections, outbox);
    const stores = shared.createDefaultInMemoryALInboundRuntimeStores();
    const service = shared.createDefaultWebRtcRxStreamerService({
        inbox: new shared.InMemoryQueueBox(new Map()),
        multicast,
        sessionId: 'self',
        inboundStores: stores
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
        receive: transport.receive,
        async outbound(): Promise<shared.ALMessage[]> {
            const messages = [...transport.sent];
            for (const key of await outbox.getAllKeys()) {
                const entry = await outbox.getItem(key);
                if (entry) {
                    messages.push(decodePersistedALMessage(entry.resource));
                }
            }
            return messages;
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
    const channel = new shared.QRtcDataChannel(connection, { peerId, dataChannelName: 'test' });
    vi.spyOn(channel, 'onRtcMessageDo').mockImplementation((_id, callback) => {
        ports.receivers.set(peerId, callback);
        return channel;
    });
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...channel.readHealth(), readyState: 'open' });
    vi.spyOn(channel, 'send').mockImplementation(async (message) => {
        ports.sent.push(decodePersistedALMessageValue(message));
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
    connections: shared.WebRtcConnectionService,
    outbox: shared.InMemoryQueueBox
): shared.WebRtcOverlayMulticastManager {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['self', 'peer-1', 'peer-2', 'peer-3'] });
    const groupCache = new shared.LatestRepository<string, GroupSnapshot>();
    groupCache.accept('group-1', snapshot);
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
        outbox,
        connectionService: connections,
        groupCache,
        overlayCache,
        multicasterFactory: (overlayId) => new shared.WebRtcOverlayMulticastService(overlayId, connections),
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundRuntime: createDefaultALOutboundRuntimeResources(),
        circuitBreaker: shared.toCircuitBreaker(),
        rateLimiter: shared.toRateLimiter()
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

function createMulticast(input: { readonly seq: number; readonly acknowledgeSubtree: boolean; }): shared.ALMessage {
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
            ack: input.acknowledgeSubtree ? 'all-logical-recipients' : 'none'
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

        await sender.peer.channel.send(message);
        await sender.peer.channel.send(message);

        expect(receivedByType).toEqual([message.id.msgId]);
        expect(receiver.delivered).toEqual([]);
    });

    it('delivers exclusive messages to the wildcard consumer when no type consumer exists', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const message = exclusiveMessage();

        await sender.peer.channel.send(message);

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

        await sender.peer.channel.send(message);

        expect(receivedByType).toEqual([message.id.msgId]);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        const acknowledgements = receiver.sent.filter((entry) => entry.payload.typeId === AL_CONTROL_ACK_TYPE_ID);
        expect(acknowledgements).toHaveLength(1);
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
