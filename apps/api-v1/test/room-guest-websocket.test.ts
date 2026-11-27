import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { allowsGuestRoomFrame } from '../src/runtime/room-guest-frame-policy.ts';
import { createGroupStateRouteSnapshotWithMember, TEST_GROUP_SCOPE } from './group-state/group-state-route-test-runtime.ts';

test('a guest socket confines send and receive to the admitted room and rejects sender substitution', () => {
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const snapshot = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const frame = newALMulticastMessage({
        createdAtEpochMs: 100,
        senderId: guest.sessionId,
        groupRef: guest.roomRef,
        route: { topicId: 'events', resourceId: 'input', contextId: 'market' },
        typeId: 'input',
        resource: {}
    });
    assert.equal(allowsGuestRoomFrame(frame, { direction: 'inbound', guest, snapshot, now: 100 }), true);
    assert.equal(allowsGuestRoomFrame({ ...frame, id: { ...frame.id, senderId: 'other' } }, { direction: 'inbound', guest, snapshot, now: 100 }), false);
    for (const direction of ['inbound', 'outbound'] as const) {
        assert.equal(allowsGuestRoomFrame({ ...frame, targets: { mode: 'broadcast', scope: 'world' } }, { direction, guest, snapshot, now: 100 }), false);
        assert.equal(
            allowsGuestRoomFrame({ ...frame, targets: { mode: 'multicast', groupRef: { ...guest.roomRef, workspaceId: 'other' } } }, {
                direction,
                guest,
                snapshot,
                now: 100
            }),
            false
        );
    }
});

test('movement bursts use the live room authorization and refresh once it ages out', async () => {
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-socket.ts');
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const room = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const snapshot = { ...room, members: room.members.map((member) => ({ ...member, guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 10000 } })) };
    let reads = 0;
    let now = 100;
    const socket = new RoomGuestSocket({
        guest,
        readSnapshot: async () => {
            reads++;
            return snapshot;
        },
        now: () => now,
        serverPeerId: 'server'
    });
    const frame = JSON.stringify(newALMulticastMessage({
        createdAtEpochMs: 100,
        senderId: guest.sessionId,
        groupRef: guest.roomRef,
        route: { topicId: 'events', resourceId: 'input', contextId: 'market' },
        typeId: 'input',
        resource: {}
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
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-socket.ts');
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const room = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const snapshot = { ...room, members: room.members.map((member) => ({ ...member, guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 10000 } })) };
    const socket = new RoomGuestSocket({ guest, readSnapshot: async () => snapshot, now: () => 100, serverPeerId: 'server' });
    const source = newALMulticastMessage({
        createdAtEpochMs: 100,
        senderId: 'sender',
        groupRef: guest.roomRef,
        route: { topicId: 'events', resourceId: 'action', contextId: 'market' },
        typeId: 'action',
        resource: {},
        options: { reliability: 'at-least-once', ack: 'receiver' }
    });
    const ack = (subject: string, target: string) =>
        JSON.stringify(newALAckControlMessage(
            { ...source.id, senderId: guest.sessionId, msgId: 'ack' },
            {
                ackedMsgId: subject,
                fromPeerId: guest.sessionId,
                toPeerId: target,
                logicalRecipientPeerId: guest.sessionId,
                originPeerId: 'sender',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: 100,
                proof: null
            }
        ));
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
    }
    finally {
        socket.close();
    }
});

// Pins a guest's socket refusing the server's admitted receipt of the guest's own submission, which would leave that
// receipt off the guest's socket and on its row only, or passing an admitted receipt of a message the guest never sent.
test('a guest reads its own admitted', async () => {
    const { newALReceiptControlMessage } = await import('@shared/al-contracts/al-control.ts');
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-socket.ts');
    const room = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    const snapshot = { ...room, members: room.members.map((member) => ({ ...member, guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 10000 } })) };
    const socket = new RoomGuestSocket({ guest: MARKET_GUEST, readSnapshot: async () => snapshot, now: () => 100, serverPeerId: 'server' });
    const submission = newALMulticastMessage({
        createdAtEpochMs: 100,
        senderId: MARKET_GUEST.sessionId,
        groupRef: MARKET_GUEST.roomRef,
        route: { topicId: 'events', resourceId: 'input', contextId: 'market' },
        typeId: 'input',
        resource: {},
        options: { reliability: 'at-least-once', ack: 'receiver' }
    });
    const admitted = (msgId: string) =>
        JSON.stringify(newALReceiptControlMessage(
            { ...submission.id, senderId: 'server', msgId: `receipt-${msgId}` },
            {
                msgId,
                originPeerId: MARKET_GUEST.sessionId,
                expectedRecipientPeerIds: ['sender'],
                confirmedRecipientPeerIds: [],
                outsideAudienceRecipientPeerIds: [],
                snapshotVersion: 1,
                phase: 'admitted',
                observedAtEpochMs: 100
            }
        ));
    assert.equal(await socket.authorizeUpgrade(), true);
    const { configureGroupStateSnapshotRepository } = await import('@shared/repository/group-state-snapshots-repository.ts');
    configureGroupStateSnapshotRepository({ ttlMs: 10000 });
    const transport = socket.wrap({ readyState: 1, send: () => 1, close: () => {} });
    try {
        assert.equal(await socket.allowsInbound(JSON.stringify(submission)), true);
        assert.equal(transport.acceptsOutbound?.(admitted(submission.id.msgId)), true);
        assert.equal(transport.acceptsOutbound?.(admitted('never-submitted')), false);
    }
    finally {
        socket.close();
    }
});

interface ScriptedGuestRoomReads {
    readonly reads: PromiseWithResolvers<GroupSnapshot | undefined>[];
    readonly readSnapshot: () => Promise<GroupSnapshot | undefined>;
}

function createScriptedGuestRoomReads(): ScriptedGuestRoomReads {
    const reads: PromiseWithResolvers<GroupSnapshot | undefined>[] = [];
    return {
        reads,
        readSnapshot: () => {
            const read = Promise.withResolvers<GroupSnapshot | undefined>();
            reads.push(read);
            return read.promise;
        }
    };
}

function createLeasedGuestRoom(groupRevision: number): GroupSnapshot {
    const room = createGroupStateRouteSnapshotWithMember('market', 'guest', 'active');
    return {
        ...room,
        causalRevision: { ...room.causalRevision, groupRevision },
        members: room.members.map((member) => ({ ...member, guestLease: { admittedAtEpochMs: 1, expiresAtEpochMs: 100_000 } }))
    };
}

async function writeGuestRoomChange(snapshot: GroupSnapshot): Promise<void> {
    const { setGroupStateSnapshot, waitForGroupStateSnapshotChangesIdle } = await import('@shared/repository/group-state-snapshots-repository.ts');
    setGroupStateSnapshot(snapshot);
    await waitForGroupStateSnapshotChangesIdle();
}

const MARKET_GUEST = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };

function createGuestInputFrame(): string {
    return JSON.stringify(newALMulticastMessage({
        createdAtEpochMs: 100,
        senderId: MARKET_GUEST.sessionId,
        groupRef: MARKET_GUEST.roomRef,
        route: { topicId: 'events', resourceId: 'input', contextId: 'market' },
        typeId: 'input',
        resource: {}
    }));
}

function createRoomEventFrame(): string {
    return JSON.stringify(newALMulticastMessage({
        createdAtEpochMs: 100,
        senderId: 'sender',
        groupRef: MARKET_GUEST.roomRef,
        route: { topicId: 'events', resourceId: 'action', contextId: 'market' },
        typeId: 'action',
        resource: {}
    }));
}

function waitForPendingReactions(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

test('room changes during a read run one follow-up read after it, and a waiting frame is judged by it', async () => {
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-socket.ts');
    const { configureGroupStateSnapshotRepository } = await import('@shared/repository/group-state-snapshots-repository.ts');
    configureGroupStateSnapshotRepository({ ttlMs: 100_000 });
    const scripted = createScriptedGuestRoomReads();
    let now = 100;
    const socket = new RoomGuestSocket({ guest: MARKET_GUEST, readSnapshot: scripted.readSnapshot, now: () => now, serverPeerId: 'server' });
    const upgrade = socket.authorizeUpgrade();
    scripted.reads[0].resolve(createLeasedGuestRoom(1));
    assert.equal(await upgrade, true);
    const closes: (number | undefined)[] = [];
    const transport = socket.wrap({ readyState: 1, send: () => 1, close: (code) => void closes.push(code) });
    try {
        now = 2_200;
        const inbound = socket.allowsInbound(createGuestInputFrame());
        assert.equal(scripted.reads.length, 2);
        await writeGuestRoomChange(createLeasedGuestRoom(2));
        await writeGuestRoomChange(createLeasedGuestRoom(3));
        await writeGuestRoomChange(createLeasedGuestRoom(4));
        assert.equal(scripted.reads.length, 2, 'no second read starts while one is in flight');
        scripted.reads[1].resolve(createLeasedGuestRoom(1));
        await waitForPendingReactions();
        assert.equal(scripted.reads.length, 3, 'the invalidated read is followed by exactly one read, without the timer');
        assert.equal(transport.acceptsOutbound?.(createRoomEventFrame()), false, 'a read that began before the change grants nothing');
        scripted.reads[2].resolve(createLeasedGuestRoom(4));
        assert.equal(await inbound, true);
        assert.equal(scripted.reads.length, 3);
        assert.equal(transport.send(createRoomEventFrame()), 1);
        assert.deepEqual(closes, []);
    }
    finally {
        socket.close();
    }
});

test('a failed room read keeps the guest socket open and fails frames closed until a read succeeds', async () => {
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-socket.ts');
    const { configureGroupStateSnapshotRepository } = await import('@shared/repository/group-state-snapshots-repository.ts');
    configureGroupStateSnapshotRepository({ ttlMs: 100_000 });
    const scripted = createScriptedGuestRoomReads();
    let now = 100;
    const socket = new RoomGuestSocket({ guest: MARKET_GUEST, readSnapshot: scripted.readSnapshot, now: () => now, serverPeerId: 'server' });
    const upgrade = socket.authorizeUpgrade();
    scripted.reads[0].resolve(createLeasedGuestRoom(1));
    assert.equal(await upgrade, true);
    const closes: (number | undefined)[] = [];
    const transport = socket.wrap({ readyState: 1, send: () => 1, close: (code) => void closes.push(code) });
    try {
        now = 2_200;
        const refused = socket.allowsInbound(createGuestInputFrame());
        scripted.reads[1].reject(new Error('database unavailable'));
        assert.equal(await refused, false);
        assert.equal(transport.send(createRoomEventFrame()), 0);
        assert.deepEqual(closes, [], 'a read error says nothing about the seat');

        const admitted = socket.allowsInbound(createGuestInputFrame());
        scripted.reads[2].resolve(createLeasedGuestRoom(1));
        assert.equal(await admitted, true);
        assert.equal(transport.send(createRoomEventFrame()), 1);

        now = 4_400;
        const ended = socket.allowsInbound(createGuestInputFrame());
        scripted.reads[3].resolve({ ...createLeasedGuestRoom(2), members: [] });
        assert.equal(await ended, false);
        assert.deepEqual(closes, [1008], 'a successful read that withdraws the seat closes with a policy code');
    }
    finally {
        socket.close();
    }
});

test('a failed upgrade read refuses the guest without a cached authorization', async () => {
    const { RoomGuestSocket } = await import('../src/runtime/room-guest-socket.ts');
    const socket = new RoomGuestSocket({
        guest: MARKET_GUEST,
        readSnapshot: () => Promise.reject(new Error('database unavailable')),
        now: () => 100,
        serverPeerId: 'server'
    });
    assert.equal(await socket.authorizeUpgrade(), false);
    assert.equal(await socket.allowsInbound(createGuestInputFrame()), false);
});

test('room labels alone do not authorize a withdrawn unicast recipient or a principal broadcast', async () => {
    const { createGroupSnapshotFixture } = await import('../../../packages/tests/shared-web/authoritative-group-fixtures.ts');
    const guest = { roomRef: { ...TEST_GROUP_SCOPE, groupId: 'market' }, clientId: 'guest', sessionId: 'guest-session' };
    const snapshot = createGroupSnapshotFixture({ ...guest.roomRef, sessionIds: ['bob'] });
    const leaving = { ...snapshot, members: [] };
    const frame = newALMulticastMessage({
        createdAtEpochMs: 3,
        senderId: guest.sessionId,
        groupRef: guest.roomRef,
        route: { topicId: 'game', resourceId: 'input', contextId: 'market' },
        typeId: 'move',
        resource: {}
    });
    const unicast = { ...frame, targets: { mode: 'unicast', toPeerId: 'bob', groupRef: guest.roomRef } } as const;
    assert.equal(allowsGuestRoomFrame(unicast, { direction: 'inbound', guest, snapshot: leaving, now: 3 }), false);
    const principal = {
        ...frame,
        targets: { mode: 'broadcast', scope: 'principal', groupRef: guest.roomRef, principalRef: { ...TEST_GROUP_SCOPE, principalId: 'stranger' } }
    } as const;
    assert.equal(allowsGuestRoomFrame(principal, { direction: 'inbound', guest, snapshot, now: 3 }), false);
});
