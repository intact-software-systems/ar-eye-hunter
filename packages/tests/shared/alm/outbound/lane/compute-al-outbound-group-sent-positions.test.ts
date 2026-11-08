import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundAdmissionMutation } from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import type { ALOutboundCommitBundle, ALOutboundSentPositions } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    computeALOutboundGroupChainedReads,
    toALOrderingBatchSequences,
    toALOrderingPendingPredecessors,
    toALOutboundFollowerOrder,
    toALOutboundGroupPositionWrites,
    toALOutboundLeftBehindPredecessors,
    type ALOutboundGroupMemberRead
} from '@shared/alm/outbound/lane/compute-al-outbound-group-sent-positions.ts';

const TRACK_KEY = 'game-1:a:1';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

function message(seq: number, priorSeqByRecipient?: Readonly<Record<string, number>>): ALMessage {
    const base = newALBroadcastMessage('a', newALRoute('room.round.event', ROOM.groupId, `event-${seq}`), 'room', 'round.event.v1', {}, { groupRef: ROOM });
    return { ...base, ordering: { orderingKey: 'game-1', epoch: 1, seq, ...(priorSeqByRecipient === undefined ? {} : { priorSeqByRecipient }) } };
}

/** A member read: its positions as the group's shared turn read them, and whether its admission stamped its copy. */
function memberRead(positions: ALOutboundSentPositions | undefined, stamped = false): ALOutboundGroupMemberRead {
    const original = message(positions?.seq ?? 1);
    return {
        storedMessage: stamped ? undefined : {},
        originalMsg: original,
        msg: stamped ? message(original.ordering!.seq!, {}) : original,
        sentPositions: positions
    };
}

function positionsOf(read: ALOutboundGroupMemberRead): Readonly<Record<string, number>> | undefined {
    return read.sentPositions?.priorSeqByRecipient;
}

function positionWrite(recipientPeerId: string, seq: number): ALOutboundAdmissionMutation {
    return { kind: 'set-sent-position', namespace: 'pair', trackKey: TRACK_KEY, recipientPeerId, seq, expireAtTimestamp: 1 };
}

describe('the sent positions of one commit group', () => {
    it('reads each member past what an earlier member of the group sends a recipient on the track', () => {
        const chained = computeALOutboundGroupChainedReads([
            memberRead({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 4, c: 4 } }),
            memberRead({ trackKey: TRACK_KEY, seq: 6, priorSeqByRecipient: { b: 4 } }),
            memberRead({ trackKey: TRACK_KEY, seq: 7, priorSeqByRecipient: { b: 4, c: 4 } })
        ]);

        expect(chained?.map(positionsOf)).toEqual([{ b: 4, c: 4 }, { b: 5 }, { b: 6, c: 5 }]);
    });

    it('chains in sequence order whatever order the rows were claimed in, so no member skips a row the group holds', () => {
        const chained = computeALOutboundGroupChainedReads([
            memberRead({ trackKey: TRACK_KEY, seq: 2, priorSeqByRecipient: { b: 0 } }),
            memberRead({ trackKey: TRACK_KEY, seq: 1, priorSeqByRecipient: { b: 0 } })
        ]);

        expect(chained?.map(positionsOf)).toEqual([{ b: 1 }, { b: 0 }]);
    });

    it('never moves a recipient back: a row the track already passed reads the position past it', () => {
        const chained = computeALOutboundGroupChainedReads([
            memberRead({ trackKey: TRACK_KEY, seq: 3, priorSeqByRecipient: { b: 5 } }),
            memberRead({ trackKey: TRACK_KEY, seq: 6, priorSeqByRecipient: { b: 5 } })
        ]);

        expect(chained?.map(positionsOf)).toEqual([{ b: 5 }, { b: 5 }]);
    });

    it('keeps the members of another track, and a member that records nothing, as they read', () => {
        const other = memberRead({ trackKey: 'game-2:a:1', seq: 3, priorSeqByRecipient: { b: 1 } });
        const unrecorded = memberRead(undefined);

        const chained = computeALOutboundGroupChainedReads([
            memberRead({ trackKey: TRACK_KEY, seq: 3, priorSeqByRecipient: { b: 2 } }),
            other,
            unrecorded
        ]);

        expect(chained?.[1]).toEqual(other);
        expect(chained?.[2]).toBe(unrecorded);
    });

    it('cannot chain a member whose admission stamped its copy: the group commits its members one by one', () => {
        expect(computeALOutboundGroupChainedReads([
            memberRead({ trackKey: TRACK_KEY, seq: 1, priorSeqByRecipient: { b: 0 } }, true),
            memberRead({ trackKey: TRACK_KEY, seq: 2, priorSeqByRecipient: { b: 0 } }, true)
        ])).toBeUndefined();
    });

    it('writes each position row once, at the highest sequence the group moves it to', () => {
        const bundle = (mutations: readonly ALOutboundAdmissionMutation[]) =>
            ({ senderId: 'a', mutations, durableEffects: [] }) satisfies ALOutboundCommitBundle<never>;

        const bundles = toALOutboundGroupPositionWrites([
            bundle([positionWrite('b', 6)]),
            bundle([positionWrite('b', 5), positionWrite('c', 5)]),
            bundle([{ kind: 'set-msg-owner', msgId: 'event-7', senderId: 'a' }])
        ]);

        expect(bundles.map((written) => written.mutations)).toEqual([
            [positionWrite('b', 6)],
            [positionWrite('c', 5)],
            [{ kind: 'set-msg-owner', msgId: 'event-7', senderId: 'a' }]
        ]);
    });
});

describe('the rows of a dequeued batch that follow their predecessor on the track', () => {
    it('leaves a follower whose predecessor the batch did not admit, and its own follower with it', () => {
        const dispatches = [follower(4, [3]), follower(3, [2]), leader(1), follower(5, [4])];

        expect([...toALOutboundLeftBehindPredecessors(dispatches)].map(toSeq)).toEqual([3, 4, 5]);
    });

    it('keeps a follower whose predecessor the batch admits ahead of it, whatever order they were claimed in', () => {
        const dispatches = [follower(3, [2]), follower(2, [1]), leader(1)];

        expect(toALOutboundLeftBehindPredecessors(dispatches)).toEqual(new Set());
    });

    it('leaves a follower of two pending sequences when only the first is admitted ahead of it, and keeps it behind both', () => {
        expect([...toALOutboundLeftBehindPredecessors([follower(3, [1, 2]), leader(1)])].map(toSeq)).toEqual([3]);
        expect(toALOutboundLeftBehindPredecessors([follower(3, [1, 2]), leader(1), leader(2)])).toEqual(new Set());
    });

    it('never leaves a row that does not follow its predecessor, admitted or not', () => {
        expect(toALOutboundLeftBehindPredecessors([leader(7), leader(9)])).toEqual(new Set());
    });

    it('orders a track that holds a follower by ascending sequence in the places it holds, leaving other rows where they are', () => {
        const untracked = { msg: { ...message(0), ordering: undefined }, batchPredecessorSeqs: [] };
        const otherTrack = { msg: { ...message(5), ordering: { orderingKey: 'game-2', epoch: 1, seq: 5 } }, batchPredecessorSeqs: [] };
        const rows = [follower(3, [2]), untracked, otherTrack, leader(1), follower(2, [1])];

        expect(toALOutboundFollowerOrder(rows, (row) => row)).toEqual([rows[3], untracked, otherTrack, rows[4], rows[0]]);
    });

    it('keeps the order of a track no row of which follows its predecessor', () => {
        const rows = [leader(2), leader(1)];

        expect(toALOutboundFollowerOrder(rows, (row) => row)).toEqual(rows);
    });

    it('keeps a row without a message in its place among a track it orders', () => {
        const rows = [follower(2, [1]), undefined, leader(1)];

        expect(toALOutboundFollowerOrder(rows, (row) => row)).toEqual([rows[2], undefined, rows[0]]);
    });
});

function follower(seq: number, batchPredecessorSeqs: readonly number[]): Readonly<{ msg: ALMessage; batchPredecessorSeqs: readonly number[]; }> {
    return { msg: message(seq), batchPredecessorSeqs };
}

function leader(seq: number): Readonly<{ msg: ALMessage; batchPredecessorSeqs: readonly number[]; }> {
    return { msg: message(seq), batchPredecessorSeqs: [] };
}

function toSeq(dispatch: Readonly<{ msg: ALMessage; }>): number | undefined {
    return dispatch.msg.ordering?.seq;
}

describe('the pending indexed predecessors of a tracked row', () => {
    const NOW_MS = 1_700_000_000_000;
    const indexed = [1, 2, 3, 4, 5, 6, 7].map((seq) => ({ seq, msgId: `event-${seq}` }));
    const stored = new Map([
        ['event-2', storedRow('event-2', { sentPositions: null })],
        ['event-3', storedRow('event-3', { sentPositions: { b: 2 } })],
        ['event-4', storedRow('event-4', { sentPositions: null, expiresAtMs: NOW_MS })],
        ['event-5', storedRow('event-5', { sentPositions: null, admittedAudience: undefined })],
        ['event-7', storedRow('event-7', { sentPositions: null })]
    ]);

    it('counts a sequence with no stored row and an unrecorded one as pending; a recorded, expired or audience-free one holds nothing', () => {
        const pending = toALOrderingPendingPredecessors({ message: trackedMessage('game-1', 6), indexed, stored, batch: new Map(), nowMs: NOW_MS });

        expect(pending).toEqual({ inBatch: [], nearestOutside: { seq: 2, msgId: 'event-2' } });
    });

    it('ignores every listed sequence at or above the row\'s own', () => {
        const pending = toALOrderingPendingPredecessors({ message: trackedMessage('game-1', 2), indexed, stored, batch: new Map(), nowMs: NOW_MS });

        expect(pending).toEqual({ inBatch: [], nearestOutside: { seq: 1, msgId: 'event-1' } });
    });

    it('lists the pending sequences the batch claimed ascending, and the highest it did not claim as the nearest outside', () => {
        const batch = toALOrderingBatchSequences([trackedMessage('game-1', 2), trackedMessage('game-1', 1)]);

        expect(toALOrderingPendingPredecessors({ message: trackedMessage('game-1', 6), indexed: indexed.toReversed(), stored, batch, nowMs: NOW_MS }))
            .toEqual({ inBatch: [1, 2], nearestOutside: undefined });
        expect(toALOrderingPendingPredecessors({ message: trackedMessage('game-1', 9), indexed, stored, batch, nowMs: NOW_MS }))
            .toEqual({ inBatch: [1, 2], nearestOutside: { seq: 7, msgId: 'event-7' } });
    });

    it('finds none for an untracked row, which claims no sequence either, as an absent message claims none', () => {
        const untracked = { ...trackedMessage('game-1', 2), ordering: undefined };

        expect(toALOrderingPendingPredecessors({ message: untracked, indexed, stored, batch: new Map(), nowMs: NOW_MS }))
            .toEqual({ inBatch: [], nearestOutside: undefined });
        expect(toALOrderingBatchSequences([untracked, undefined])).toEqual(new Map());
    });
});

/** A sent row admitted to `b` unless named otherwise, live until a minute past `1_700_000_000_000` unless named. */
function storedRow(
    msgId: string,
    options: Readonly<{ sentPositions: Readonly<Record<string, number>> | null; expiresAtMs?: number; admittedAudience?: readonly string[]; }>
): ALStoredOutboundMessage {
    const admittedAudience = 'admittedAudience' in options ? options.admittedAudience : ['b'];
    return {
        msgId,
        reference: {
            key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: msgId },
            typeId: 'AL_OUTBOUND_MESSAGE',
            scope: 'scope',
            msgId,
            senderId: 'a',
            identity: msgId,
            expiresAtMs: options.expiresAtMs ?? 1_700_000_060_000
        },
        supersedenceKey: undefined,
        unicastPeerId: null,
        orderingTrackKey: 'game-1:a:1',
        orderingSeq: Number(msgId.replace('event-', '')),
        sentPositions: options.sentPositions,
        policy: {
            persist: true,
            ackTracking: null,
            retryTracking: null,
            repairTracking: null,
            supersedenceTracking: null,
            ...(admittedAudience === undefined ? {} : { admittedAudience })
        },
        creationExpiry: 'creation-expiry'
    };
}

function trackedMessage(orderingKey: string, seq: number): ALMessage {
    const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
    const message = newALBroadcastMessage('a', newALRoute('room.round.event', room.groupId, `event-${seq}`), 'room', 'round.event.v1', {}, { groupRef: room });
    return { ...message, ordering: { orderingKey, epoch: 1, seq } };
}
