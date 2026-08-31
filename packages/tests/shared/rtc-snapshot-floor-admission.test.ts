import { newALBroadcastMessage, newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    it('preserves no-floor, local-plan and control-message behavior', async () => {
        const sender = new RtcEndpointFixture('sender', 'receiver');
        const receiver = new RtcEndpointFixture('receiver', 'sender');
        endpoints.push(sender, receiver);
        sender.connect(receiver);
        receiver.connect(sender);
        const message = roomMessage(undefined);
        await sender.peer.channel.send(message);
        expect(receiver.delivered).toHaveLength(1);
        expect(sender.multicast.planIncomingMessage(roomMessage(99)).dropReason).toBeUndefined();
        const control = newALNackControlMessage('sender', 'receiver', message.id.msgId, 'not-yet-in-sync');
        await sender.peer.channel.send({ ...control, targets: roomMessage(99).targets });
        expect(await receiver.nacks(message)).toEqual([expect.objectContaining({ fromPeerId: 'sender' })]);
        expect(receiver.delivered).toHaveLength(1);
    });
});

function roomMessage(minSnapshotVersion: number | undefined): ALMessage {
    return newALMulticastMessage('sender', { topicId: 'data', contextId: 'room', resourceId: 'record' }, room, 'data', { value: 1 }, {
        minSnapshotVersion,
        qos: { durability: { algo: 'volatile' } }
    });
}
