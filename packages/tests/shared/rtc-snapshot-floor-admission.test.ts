import {
    newALBroadcastMessage,
    newALMulticastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { room, RtcEndpointFixture } from './rtc-endpoint-fixture.ts';
const endpoints: RtcEndpointFixture[] = [];

afterEach(() => {
    for (const endpoint of endpoints.splice(0)) {
        endpoint.close();
    }
    vi.restoreAllMocks();
});

describe('RTC scoped snapshot-floor admission', () => {
    it.each([undefined, 1, 2, 3])('checks receiver snapshot %s before delivery without an overlay', async (version) => {
        const sender = new RtcEndpointFixture('sender', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'sender');
        endpoints.push(sender, receiver);
        sender.connect(receiver);
        receiver.connect(sender);
        if (version !== undefined) {
            receiver.observe(version);
        }
        const message = roomMessage(2);

        await sender.peer.channel.send(message);

        if (version === undefined || version < 2) {
            expect(receiver.delivered).toEqual([]);
            expect(await sender.nacks(message)).toEqual([expect.objectContaining({
                msgId: message.id.msgId,
                fromPeerId: 'receiver',
                toPeerId: 'sender',
                reason: 'not-yet-in-sync'
            })]);
            expect(receiver.sent).toHaveLength(1);
        }
        else {
            expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
            expect(await sender.nacks(message)).toEqual([]);
        }
    });

    it('does not admit another scope or confuse overlay version with snapshot version', async () => {
        const sender = new RtcEndpointFixture('sender', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'sender');
        endpoints.push(sender, receiver);
        sender.connect(receiver);
        receiver.connect(sender);
        receiver.observe(99, { ...room, workspaceId: 'elsewhere' });
        receiver.observe(1);
        receiver.observeOverlay(99);
        const message = roomMessage(2);

        await sender.peer.channel.send(message);

        expect(receiver.delivered).toEqual([]);
        expect(await sender.nacks(message)).toEqual([expect.objectContaining({ reason: 'not-yet-in-sync' })]);
    });

    it('admits the same message after snapshot advancement without dedup poisoning', async () => {
        const sender = new RtcEndpointFixture('sender', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'sender');
        endpoints.push(sender, receiver);
        sender.connect(receiver);
        receiver.connect(sender);
        receiver.observe(1);
        const message = roomMessage(2);
        await sender.peer.channel.send(message);
        expect(receiver.delivered).toEqual([]);

        receiver.observe(2);
        await sender.peer.channel.send(message);
        await sender.peer.channel.send(message);

        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        expect(await sender.nacks(message)).toEqual([expect.objectContaining({ reason: 'not-yet-in-sync' })]);
    });

    it('rejects a room broadcast below its floor and accepts it when the exact scope advances', async () => {
        const sender = new RtcEndpointFixture('sender', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'sender');
        endpoints.push(sender, receiver);
        sender.connect(receiver);
        receiver.connect(sender);
        const message = newALBroadcastMessage('sender', { topicId: 'data', contextId: 'room', resourceId: 'broadcast' }, 'room', 'data', { value: 1 }, {
            groupRef: room,
            minSnapshotVersion: 2,
            qos: { durability: { algo: 'volatile' } }
        });
        receiver.observe(1);
        await sender.peer.channel.send(message);
        expect(receiver.delivered).toEqual([]);
        expect(await sender.nacks(message)).toEqual([expect.objectContaining({ fromPeerId: 'receiver', msgId: message.id.msgId })]);
        receiver.observe(2);
        await sender.peer.channel.send(message);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
    });

    it('correlates rejection to the immediate forwarding peer while preserving original message identity', async () => {
        const forwarder = new RtcEndpointFixture('forwarder', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'forwarder');
        endpoints.push(forwarder, receiver);
        forwarder.connect(receiver);
        receiver.connect(forwarder);
        const message = roomMessage(2);
        await forwarder.peer.channel.send(message);
        expect(receiver.delivered).toEqual([]);
        expect(await forwarder.nacks(message)).toEqual([expect.objectContaining({
            fromPeerId: 'receiver',
            toPeerId: 'forwarder',
            msgId: message.id.msgId,
            reason: 'not-yet-in-sync'
        })]);
        expect(receiver.sent).toHaveLength(1);
    });

    it('waits for no-floor room authority and then admits the same message', async () => {
        const sender = new RtcEndpointFixture('sender', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'sender');
        endpoints.push(sender, receiver);
        sender.connect(receiver);
        receiver.connect(sender);
        const message = roomMessage(undefined);
        await sender.peer.channel.send(message);
        expect(receiver.delivered).toEqual([]);
        receiver.observe(1);
        await sender.peer.channel.send(message);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
    });

    it('forwards origin to relay to recipient through authorized server edges', async () => {
        const sender = new RtcEndpointFixture('sender', 'relay');
        const relay = new RtcEndpointFixture('relay', ['sender', 'receiver']);
        const receiver = new RtcEndpointFixture('receiver', 'relay');
        endpoints.push(sender, relay, receiver);
        sender.connect(relay);
        relay.connect(sender);
        relay.connect(receiver);
        receiver.connect(relay);
        for (const endpoint of [sender, relay, receiver]) {
            endpoint.observe(1, room, ['sender', 'relay', 'receiver']);
            endpoint.observeOverlay(1);
        }
        const message = roomMessage(undefined);
        const accepted = await sender.multicast.enqueueIfAbsent(message);
        expect(accepted.status).toBe('sent-immediate');
        expect(relay.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        expect(receiver.delivered[0].id.senderId).toBe('sender');
        expect(relay.sent.find((entry) => entry.id.msgId === message.id.msgId)?.forwarding?.nextHopPeerIds).toEqual(['receiver']);
    });

    it.each(['removed-member', 'expired-session', 'foreign-overlay'] as const)(
        'rejects proven %s authority before delivery or control response',
        async (failure) => {
            const sender = new RtcEndpointFixture('sender', 'receiver');
            const receiver = new RtcEndpointFixture('receiver', 'sender');
            endpoints.push(sender, receiver);
            sender.connect(receiver);
            receiver.connect(sender);
            receiver.observe(1);
            receiver.observeOverlay(1);
            const key = toScopedOverlayId(room);
            const current = receiver.groups.read(key)!;
            receiver.groups.set(key, {
                ...current,
                activeSessions: current.activeSessions.map((session) =>
                    failure === 'expired-session' && session.sessionId === 'sender'
                        ? { ...session, expiresAtEpochMs: Date.now() }
                        : session
                ),
                members: current.members.map((member) =>
                    failure === 'removed-member' && member.principalId === 'sender' && member.status === 'active'
                        ? { ...member, status: 'removed', removed: member.updated }
                        : member
                )
            });
            if (failure === 'foreign-overlay') {
                const overlay = receiver.overlays.readAllValues()[0];
                receiver.overlays.set(overlay.overlayId, { ...overlay, groupRef: { ...room, workspaceId: 'elsewhere' } });
            }
            await sender.peer.channel.send(roomMessage(undefined));
            expect(receiver.delivered).toEqual([]);
            expect(receiver.sent).toEqual([]);
        }
    );

    it('does not use forged visit diagnostics to authorize a relay', async () => {
        const relay = new RtcEndpointFixture('relay', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'relay');
        endpoints.push(relay, receiver);
        relay.connect(receiver);
        receiver.connect(relay);
        receiver.observe(1, room, ['sender', 'relay', 'receiver']);
        receiver.observeOverlay(1);
        const current = receiver.overlays.readAllValues()[0];
        receiver.overlays.set(current.overlayId, { ...current, nextHopSessionIds: ['sender'], overlayVersion: 2 });
        const message = { ...roomMessage(undefined), diagnostics: { visitedPeerIds: ['sender', 'relay'] } };
        await relay.peer.channel.send(message);
        expect(receiver.delivered).toEqual([]);
        expect(receiver.sent).toEqual([]);
    });
});

function roomMessage(minSnapshotVersion: number | undefined): ALMessage {
    return newALMulticastMessage('sender', { topicId: 'data', contextId: 'room', resourceId: 'record' }, room, 'data', { value: 1 }, {
        minSnapshotVersion,
        qos: { durability: { algo: 'volatile' } }
    });
}
