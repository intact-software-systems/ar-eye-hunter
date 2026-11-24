import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { allowsGuestRoomFrame } from '../src/runtime/room-guest-websocket.ts';
import { createGroupStateRouteSnapshotWithMember, TEST_GROUP_SCOPE } from './group-state/group-state-route-test-runtime.ts';

test('a guest socket confines send and receive to the admitted room and rejects sender substitution', () => {
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const snapshot = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const frame = newALMulticastMessage({
        createdAtEpochMs: 100, senderId: guest.sessionId, groupRef: guest.roomRef,
        route: { topicId: 'events', resourceId: 'input', contextId: 'market' }, typeId: 'input', resource: {}
    });
    assert.equal(allowsGuestRoomFrame(frame, 'inbound', guest, snapshot, 100), true);
    assert.equal(allowsGuestRoomFrame({ ...frame, id: { ...frame.id, senderId: 'other' } }, 'inbound', guest, snapshot, 100), false);
    for (const direction of ['inbound', 'outbound'] as const) {
        assert.equal(allowsGuestRoomFrame({ ...frame, targets: { mode: 'broadcast', scope: 'world' } }, direction, guest, snapshot, 100), false);
        assert.equal(allowsGuestRoomFrame({ ...frame, targets: { mode: 'multicast', groupRef: { ...guest.roomRef, workspaceId: 'other' } } }, direction, guest, snapshot, 100), false);
    }
});

test('movement bursts use the live room authorization and refresh once it ages out', async () => {
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-websocket.ts');
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const room = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const snapshot = { ...room, members: room.members.map(member => ({ ...member, guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 10000 } })) };
    let reads = 0;
    let now = 100;
    const socket = new RoomGuestSocket(guest, async () => { reads++; return snapshot; }, () => now, 'server');
    const frame = JSON.stringify(newALMulticastMessage({
        createdAtEpochMs: 100, senderId: guest.sessionId, groupRef: guest.roomRef,
        route: { topicId: 'events', resourceId: 'input', contextId: 'market' }, typeId: 'input', resource: {}
    }));
    assert.equal(await socket.authorizeUpgrade(), true);
    for (let i = 0; i < 60; i++) {
        now += 16;
        assert.equal(await socket.allowsInbound(frame), true);
    }
    assert.equal(reads, 1);
    now += 2000;
    assert.equal(await socket.allowsInbound(frame), true);
    assert.equal(reads, 2);
});

test('guest reliability controls can acknowledge only messages delivered on this room socket', async () => {
    const { newALAckControlMessage } = await import('@shared/al-contracts/al-control.ts');
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-websocket.ts');
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const room = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const snapshot = { ...room, members: room.members.map(member => ({ ...member, guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 10000 } })) };
    const socket = new RoomGuestSocket(guest, async () => snapshot, () => 100, 'server');
    const source = newALMulticastMessage({ createdAtEpochMs: 100, senderId: 'sender', groupRef: guest.roomRef,
        route: { topicId: 'events', resourceId: 'action', contextId: 'market' }, typeId: 'action', resource: {},
        options: { reliability: 'at-least-once', ack: 'receiver' } });
    const ack = (subject: string, target: string) => JSON.stringify(newALAckControlMessage(
        { ...source.id, senderId: guest.sessionId, msgId: 'ack' }, { ackedMsgId: subject, fromPeerId: guest.sessionId,
            toPeerId: target, logicalRecipientPeerId: guest.sessionId, originPeerId: 'sender', carrier: 'ws',
            status: 'delivered', observedAtEpochMs: 100, proof: null }));
    assert.equal(await socket.authorizeUpgrade(), true);
    const { configureGroupStateSnapshotRepository } = await import('@shared/repository/group-state-snapshots-repository.ts');
    configureGroupStateSnapshotRepository({ ttlMs: 10000 });
    const transport = socket.wrap({ readyState: 1, send: () => 1, close: () => {} });
    try {
        assert.equal(await socket.allowsInbound(ack(source.id.msgId, 'server')), false);
        assert.equal(transport.send(JSON.stringify(source)), 1);
        assert.equal(await socket.allowsInbound(ack(source.id.msgId, 'server')), true);
        assert.equal(await socket.allowsInbound(ack('unknown', 'server')), false);
        assert.equal(await socket.allowsInbound(ack(source.id.msgId, 'other-room')), false);
    } finally { socket.close(); }
});

test('room labels alone do not authorize a withdrawn unicast recipient or a principal broadcast', async () => {
    const { createGroupSnapshotFixture } = await import('../../../packages/tests/shared-web/authoritative-group-fixtures.ts');
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const snapshot = createGroupSnapshotFixture({ ...guest.roomRef, sessionIds: ['bob'] });
    const leaving = { ...snapshot, members: [] };
    const frame = newALMulticastMessage({ createdAtEpochMs: 3, senderId: guest.sessionId, groupRef: guest.roomRef,
        route: { topicId: 'game', resourceId: 'input', contextId: 'market' }, typeId: 'move', resource: {} });
    const unicast = { ...frame, targets: { mode: 'unicast', toPeerId: 'bob', groupRef: guest.roomRef } } as const;
    assert.equal(allowsGuestRoomFrame(unicast, 'inbound', guest, leaving, 3), false);
    const principal = { ...frame, targets: { mode: 'broadcast', scope: 'principal', groupRef: guest.roomRef,
        principalRef: { ...TEST_GROUP_SCOPE, principalId: 'stranger' } } } as const;
    assert.equal(allowsGuestRoomFrame(principal, 'inbound', guest, snapshot, 3), false);
});
