import { describe, expect, it } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    computeRtcRepairTargetAdmission,
    type RtcRepairTargetAdmissionInput
} from '@shared/multicast/publication/compute-rtc-repair-target-admission.ts';

import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from '../rtc-publication-proof-fixtures.ts';

const NOW_MS = Date.now();

/** `a` froze its send to `b` and `c`; `d` joined after the freeze. */
const FROZEN_RECIPIENT_PEER_IDS = ['b', 'c'];

describe('computeRtcRepairTargetAdmission', () => {
    it('admits a frozen recipient whose principal still holds subscribe', () => {
        expect(computeRtcRepairTargetAdmission(toInput(createRoom({ c: SUBSCRIBE_ONLY }), 'c')).right).toBe('admitted');
    });

    it('refuses a target outside the frozen audience of a receiver receipt, a subscriber included: a repair never widens it', () => {
        expect(computeRtcRepairTargetAdmission(toInput(createRoom({ d: PUBLISH_AND_SUBSCRIBE }), 'd')).left)
            .toEqual({ kind: 'outside-frozen-audience' });
    });

    it.each(['subtree', 'hop'] as const)(
        'admits a pure relay outside the frozen audience under a %s receipt: it asks a copy for its subtree, never for itself',
        (receiptMode) => {
            expect(computeRtcRepairTargetAdmission({ ...toInput(createRoom({ c: SUBSCRIBE_ONLY }), 'd'), receiptMode }).right)
                .toBe('admitted');
        }
    );

    it.each<[string, GroupSnapshot]>([
        ['subscribe revoked after the freeze', createRoom({ c: PUBLISH_ONLY })],
        ['no grant row any more', createRoom({ b: SUBSCRIBE_ONLY })],
        ['a lapsed session lease', toLapsedSession(createRoom({ c: SUBSCRIBE_ONLY }), 'c')]
    ])('refuses no-subscribe-grant a frozen recipient with %s', (_name, snapshot) => {
        expect(computeRtcRepairTargetAdmission(toInput(snapshot, 'c')).left).toEqual({ kind: 'no-subscribe-grant' });
    });

    it.each<[string, GroupSnapshot | null]>([
        ['no readable snapshot', null],
        ['an expired room', toExpiredRoom(createRoom({ c: SUBSCRIBE_ONLY }))]
    ])('refuses no-authority with %s', (_name, snapshot) => {
        expect(computeRtcRepairTargetAdmission(toInput(snapshot, 'c')).left).toEqual({ kind: 'no-authority' });
    });
});

function createRoom(grants: Parameters<typeof createPublicationRoomSnapshot>[0]['grants']): GroupSnapshot {
    return createPublicationRoomSnapshot({ sessionIds: ['a', 'b', 'c', 'd'], snapshotVersion: 4, keys: {}, grants });
}

function toInput(snapshot: GroupSnapshot | null, targetPeerId: string): RtcRepairTargetAdmissionInput {
    return {
        snapshot,
        frozenRecipientPeerIds: FROZEN_RECIPIENT_PEER_IDS,
        targetPeerId,
        topicId: PUBLICATION_TOPIC_ID,
        receiptMode: 'receiver',
        nowEpochMs: NOW_MS
    };
}

function toLapsedSession(snapshot: GroupSnapshot, sessionId: string): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => session.sessionId === sessionId ? { ...session, expiresAtEpochMs: NOW_MS } : session)
    };
}

function toExpiredRoom(snapshot: GroupSnapshot): GroupSnapshot {
    return { ...snapshot, group: { ...snapshot.group, expiresAtEpochMs: NOW_MS } };
}
