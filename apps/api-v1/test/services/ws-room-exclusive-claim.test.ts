import assert from 'node:assert/strict';

import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALNackPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import {
    createLiveRoomRuntime,
    readOriginReceipts,
    waitForRoomSends,
    type LiveRoomTestRuntime,
    type RoomLiveSend
} from './ws-room-live-runtime.ts';
import { putRoomSnapshot } from './ws-room-test-runtime.ts';

const HELD_BY_OTHER_DETAIL = 'Exclusive resource is held by another session';

Deno.test('a second session\'s exclusive send on a claimed resource is NACKed held-by-other, reaches no one and starts no receipt', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const claim = pickupSend(room, 'session-2', 'exclusive');
        const contender = pickupSend(room, 'session-1', 'exclusive');

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-2')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 2);
        const refused = await runtime.service.acceptIncomingMessage(contender, 'session-1');
        await waitForRoomSends(() => false);

        assert.deepEqual(refused.right, { kind: 'not-admitted', reason: HELD_BY_OTHER_DETAIL });
        assert.deepEqual(readNackReasons(runtime.sent, 'session-1'), ['held-by-other']);
        assert.deepEqual(readPickupSends(runtime.sent), [
            ['session-1', claim.id.msgId],
            ['session-3', claim.id.msgId]
        ]);
        assert.deepEqual(readOriginReceipts(runtime.sent), []);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('the holder\'s exclusive re-send on its claimed resource is admitted, delivered and moves the claim\'s expiry to its own', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const claim = pickupSend(room, 'session-1', 'exclusive', CLAIM_TTL_MS);
        const renewal = pickupSend(room, 'session-1', 'exclusive');

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-1')).right, { kind: 'admitted' });
        assert.deepEqual((await runtime.service.acceptIncomingMessage(renewal, 'session-1')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 4);
        await waitPastExpiry(claim);
        const contender = await runtime.service.acceptIncomingMessage(pickupSend(room, 'session-2', 'exclusive'), 'session-2');
        await waitForRoomSends(() => false);

        assert.deepEqual(readPickupSends(runtime.sent).filter(([sessionId]) => sessionId === 'session-2'), [
            ['session-2', claim.id.msgId],
            ['session-2', renewal.id.msgId]
        ]);
        assert.deepEqual(readNackReasons(runtime.sent, 'session-1'), []);
        assert.deepEqual(contender.right, { kind: 'not-admitted', reason: HELD_BY_OTHER_DETAIL });
        assert.deepEqual(readNackReasons(runtime.sent, 'session-2'), ['held-by-other']);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('a claim lapses with its message: the next session\'s exclusive send is admitted, delivered and holds the resource', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const claim = pickupSend(room, 'session-1', 'exclusive', CLAIM_TTL_MS);

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-1')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 2);
        await waitPastExpiry(claim);
        const reclaim = pickupSend(room, 'session-2', 'exclusive');
        assert.deepEqual((await runtime.service.acceptIncomingMessage(reclaim, 'session-2')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 4);
        const formerHolder = await runtime.service.acceptIncomingMessage(pickupSend(room, 'session-1', 'exclusive'), 'session-1');
        await waitForRoomSends(() => false);

        assert.deepEqual(readPickupSends(runtime.sent).filter(([, msgId]) => msgId === reclaim.id.msgId), [
            ['session-1', reclaim.id.msgId],
            ['session-3', reclaim.id.msgId]
        ]);
        assert.deepEqual(formerHolder.right, { kind: 'not-admitted', reason: HELD_BY_OTHER_DETAIL });
        assert.deepEqual(readNackReasons(runtime.sent, 'session-1'), ['held-by-other']);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('a shared send on a claimed resource neither consults nor takes the claim, and is delivered', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const claim = pickupSend(room, 'session-1', 'exclusive');
        const shared = pickupSend(room, 'session-2', 'shared');

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-1')).right, { kind: 'admitted' });
        assert.deepEqual((await runtime.service.acceptIncomingMessage(shared, 'session-2')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 4);
        const renewal = pickupSend(room, 'session-1', 'exclusive');
        assert.deepEqual((await runtime.service.acceptIncomingMessage(renewal, 'session-1')).right, { kind: 'admitted' });
        await waitForRoomSends(() => false);

        assert.deepEqual(readPickupSends(runtime.sent).filter(([, msgId]) => msgId === shared.id.msgId), [
            ['session-1', shared.id.msgId],
            ['session-3', shared.id.msgId]
        ]);
        assert.deepEqual(readNackReasons(runtime.sent, 'session-1'), []);
        assert.deepEqual(readNackReasons(runtime.sent, 'session-2'), []);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

const CLAIM_TTL_MS = 300;

interface ClaimRuntime {
    readonly runtime: LiveRoomTestRuntime;
    readonly room: GroupRef;
}

/** The room of `session-1`, `session-2` and `session-3`, its authority current and its router installed. */
async function createClaimRuntime(): Promise<ClaimRuntime> {
    const snapshot: GroupSnapshot = createGroupSnapshot(2, ['session-1', 'session-2', 'session-3']);
    const runtime = createLiveRoomRuntime(Date.now());
    await putRoomSnapshot(runtime.repository, snapshot);
    runtime.cache.observe(snapshot);
    runtime.router.install();
    return { runtime, room: snapshot.group };
}

/** A receiver-acknowledged room broadcast from `senderId` on the one pickup resource every case contends for. */
function pickupSend(room: GroupRef, senderId: string, ownership: 'shared' | 'exclusive', ttlMs = 30_000): ALMessage {
    return newALBroadcastMessage(
        senderId,
        newALRoute('room.pickup', room.groupId, 'pickup-1'),
        'room',
        'room.pickup.v1',
        { pickupId: 'pickup-1' },
        {
            groupRef: { applicationId: room.applicationId, workspaceId: room.workspaceId, groupId: room.groupId },
            reliability: 'at-least-once',
            ack: 'receiver',
            ownership,
            ttlMs
        }
    );
}

async function waitPastExpiry(message: ALMessage): Promise<void> {
    const remainingMs = message.id.ts + CLAIM_TTL_MS - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(remainingMs, 0) + 20));
}

function readPickupSends(sent: readonly RoomLiveSend[]): readonly (readonly [string, string])[] {
    return sent
        .map((send) => [send.sessionId, decodePersistedALMessage(send.encoded)] as const)
        .filter(([, message]) => message.route.topicId === 'room.pickup')
        .map(([sessionId, message]) => [sessionId, message.id.msgId] as const);
}

function readNackReasons(sent: readonly RoomLiveSend[], sessionId: string): readonly string[] {
    return sent
        .filter((send) => send.sessionId === sessionId)
        .map((send) => decodePersistedALMessage(send.encoded))
        .filter((message) => message.payload.typeId === AL_CONTROL_NACK_TYPE_ID)
        .map((message) => decodeALNackPayload(JSON.parse(message.payload.resource)).reason);
}
