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
