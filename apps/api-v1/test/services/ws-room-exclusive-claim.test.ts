import assert from 'node:assert/strict';

import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALNackPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import {
    createLiveRoomRuntime,
    waitForRoomSends,
    type LiveRoomTestRuntime,
    type RoomLiveSend
} from './ws-room-live-runtime.ts';
import { putRoomSnapshot } from './ws-room-test-runtime.ts';

const HELD_BY_OTHER_DETAIL = 'Exclusive resource is held by another session';

Deno.test('a second session\'s exclusive send on a claimed resource is NACKed held-by-other, reaches no one and starts no receipt', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const claim = createPickupSend({ room, senderId: 'session-2', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
        const contender = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: SEND_TTL_MS });

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
        assert.deepEqual(readReceiptPhases(runtime.sent, 'session-1'), []);
        assert.deepEqual(readReceiptPhases(runtime.sent, 'session-2'), [[claim.id.msgId, 'admitted']]);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('two sessions claiming one free resource at once: the loser is retained on the conflict, NACKed held-by-other on its replay and reaches no one', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const first = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
        const second = createPickupSend({ room, senderId: 'session-2', ownership: 'exclusive', ttlMs: SEND_TTL_MS });

        const [firstAcceptance, secondAcceptance] = await Promise.all([
            runtime.service.acceptIncomingMessage(first, 'session-1'),
            runtime.service.acceptIncomingMessage(second, 'session-2')
        ]);
        await waitForRoomSends(() => readNackReasons(runtime.sent, 'session-2').length > 0);
        await waitForRoomSends(() => false);

        assert.deepEqual(firstAcceptance.right, { kind: 'admitted' });
        assert.deepEqual(secondAcceptance.right, { kind: 'pending-admission' });
        assert.deepEqual(readNackReasons(runtime.sent, 'session-2'), ['held-by-other']);
        assert.deepEqual(readNackReasons(runtime.sent, 'session-1'), []);
        assert.deepEqual(readPickupSends(runtime.sent), [
            ['session-2', first.id.msgId],
            ['session-3', first.id.msgId]
        ]);
        // The retained claim started its receipt before the replay judged it; the NACK is what ends it at the origin.
        assert.deepEqual(readReceiptPhases(runtime.sent, 'session-2'), [[second.id.msgId, 'admitted']]);
        assert.deepEqual(readReceiptPhases(runtime.sent, 'session-1'), [[first.id.msgId, 'admitted']]);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('the holder\'s exclusive re-send on its claimed resource is admitted, delivered and moves the claim\'s expiry to its own', async () => {
    const { runtime, room } = await createClaimRuntime();
    try {
        const claim = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: CLAIM_TTL_MS });
        const renewal = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: SEND_TTL_MS });

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-1')).right, { kind: 'admitted' });
        assert.deepEqual((await runtime.service.acceptIncomingMessage(renewal, 'session-1')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 4);
        await waitPastExpiry(claim);
        const contenderSend = createPickupSend({ room, senderId: 'session-2', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
        const contender = await runtime.service.acceptIncomingMessage(contenderSend, 'session-2');
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
        const claim = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: CLAIM_TTL_MS });

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-1')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 2);
        await waitPastExpiry(claim);
        const reclaim = createPickupSend({ room, senderId: 'session-2', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
        assert.deepEqual((await runtime.service.acceptIncomingMessage(reclaim, 'session-2')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 4);
        const formerHolderSend = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
        const formerHolder = await runtime.service.acceptIncomingMessage(formerHolderSend, 'session-1');
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
        const claim = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
        const shared = createPickupSend({ room, senderId: 'session-2', ownership: 'shared', ttlMs: SEND_TTL_MS });

        assert.deepEqual((await runtime.service.acceptIncomingMessage(claim, 'session-1')).right, { kind: 'admitted' });
        assert.deepEqual((await runtime.service.acceptIncomingMessage(shared, 'session-2')).right, { kind: 'admitted' });
        await waitForRoomSends(() => readPickupSends(runtime.sent).length >= 4);
        const renewal = createPickupSend({ room, senderId: 'session-1', ownership: 'exclusive', ttlMs: SEND_TTL_MS });
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
const SEND_TTL_MS = 30_000;

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

interface PickupSendInput {
    readonly room: GroupRef;
    readonly senderId: string;
    readonly ownership: 'shared' | 'exclusive';
    readonly ttlMs: number;
}

/** A receiver-acknowledged room broadcast from `senderId` on the one pickup resource every case contends for. */
function createPickupSend({ room, senderId, ownership, ttlMs }: PickupSendInput): ALMessage {
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

function readReceiptPhases(sent: readonly RoomLiveSend[], sessionId: string): readonly (readonly [string, string])[] {
    return sent
        .filter((send) => send.sessionId === sessionId)
        .map((send) => decodePersistedALMessage(send.encoded))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)))
        .map((receipt) => [receipt.msgId, receipt.phase] as const);
}
