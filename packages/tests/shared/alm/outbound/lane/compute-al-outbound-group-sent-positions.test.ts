import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundAdmissionMutation } from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import type { ALOutboundCommitBundle, ALOutboundSentPositions } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    computeALOutboundGroupChainedReads,
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
    return { kind: 'set-sent-position', trackKey: TRACK_KEY, recipientPeerId, seq, expireAtTimestamp: 1 };
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

describe('the rows of a dequeued batch that follow their predecessor on the track (T3-R5)', () => {
    it('leaves a follower whose predecessor the batch did not admit, and its own follower with it', () => {
        const dispatches = [follower(4), follower(3), { msg: message(1) }, follower(5)];

        expect([...toALOutboundLeftBehindPredecessors(dispatches)].map(toSeq)).toEqual([3, 4, 5]);
    });

    it('keeps a follower whose predecessor the batch admits ahead of it, whatever order they were claimed in', () => {
        const dispatches = [follower(3), follower(2), { msg: message(1) }];

        expect(toALOutboundLeftBehindPredecessors(dispatches)).toEqual(new Set());
    });

    it('never leaves a row that does not follow its predecessor, admitted or not', () => {
        expect(toALOutboundLeftBehindPredecessors([{ msg: message(7) }, { msg: message(9), followsBatchPredecessor: false }])).toEqual(new Set());
    });

    it('orders a track that holds a follower by ascending sequence in the places it holds, leaving other rows where they are', () => {
        const untracked = { msg: { ...message(0), ordering: undefined } };
        const otherTrack = { msg: { ...message(5), ordering: { orderingKey: 'game-2', epoch: 1, seq: 5 } } };
        const rows = [follower(3), untracked, otherTrack, { msg: message(1) }, follower(2)];

        expect(toALOutboundFollowerOrder(rows, (row) => row)).toEqual([rows[3], untracked, otherTrack, rows[4], rows[0]]);
    });

    it('keeps the order of a track no row of which follows its predecessor', () => {
        const rows = [{ msg: message(2) }, { msg: message(1) }];

        expect(toALOutboundFollowerOrder(rows, (row) => row)).toEqual(rows);
    });
});

function follower(seq: number): Readonly<{ msg: ALMessage; followsBatchPredecessor: boolean; }> {
    return { msg: message(seq), followsBatchPredecessor: true };
}

function toSeq(dispatch: Readonly<{ msg: ALMessage; }>): number | undefined {
    return dispatch.msg.ordering?.seq;
}
