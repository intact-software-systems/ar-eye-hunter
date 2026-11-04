import { describe, expect, it } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcRepairRefusal } from '@shared/multicast/publication/compute-rtc-repair-refusal.ts';

import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from '../rtc-publication-proof-fixtures.ts';

const NOW_MS = Date.now();

describe('computeRtcRepairRefusal', () => {
    // M1: a pass carries no value; only the refusal is read.
    it.each<[string, GroupSnapshot | null]>([
        ['its principal still holds publish', createRoom({ a: PUBLISH_ONLY })],
        ['no snapshot is readable, which the room-authority planning decides', null],
        ['its room expired, which the room-authority planning decides', toExpiredRoom(createRoom({ a: SUBSCRIBE_ONLY }))]
    ])('lets the origin re-send a stored signed send when %s', (_name, snapshot) => {
        expect(computeRtcRepairRefusal(toInput(snapshot))).toBeUndefined();
    });

    it.each<[string, GroupSnapshot]>([
        ['publish revoked after the freeze, subscribe kept', createRoom({ a: SUBSCRIBE_ONLY })],
        ['no grant row any more', createRoom({ b: SUBSCRIBE_ONLY })]
    ])('refuses no-publish-grant with %s', (_name, snapshot) => {
        expect(computeRtcRepairRefusal(toInput(snapshot))).toEqual({ kind: 'no-publish-grant' });
    });
});

function createRoom(grants: Parameters<typeof createPublicationRoomSnapshot>[0]['grants']): GroupSnapshot {
    return createPublicationRoomSnapshot({ sessionIds: ['a', 'b'], snapshotVersion: 4, keys: {}, grants });
}

function toInput(snapshot: GroupSnapshot | null) {
    return { snapshot, selfPrincipalId: 'a', topicId: PUBLICATION_TOPIC_ID, nowEpochMs: NOW_MS };
}

function toExpiredRoom(snapshot: GroupSnapshot): GroupSnapshot {
    return { ...snapshot, group: { ...snapshot.group, expiresAtEpochMs: NOW_MS } };
}
