import { describe, expect, it } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcRepairAuthorization } from '@shared/multicast/publication/compute-rtc-repair-authorization.ts';

import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from '../rtc-publication-proof-fixtures.ts';

const NOW_MS = Date.now();

describe('computeRtcRepairAuthorization', () => {
    it('authorizes the origin of a stored signed send while its principal still holds publish', () => {
        expect(computeRtcRepairAuthorization(toInput(createRoom({ a: PUBLISH_ONLY }))).right).toBe('authorized');
    });

    it.each<[string, GroupSnapshot | null]>([
        ['no readable snapshot', null],
        ['an expired room', toExpiredRoom(createRoom({ a: SUBSCRIBE_ONLY }))]
    ])('leaves %s to the room-authority planning: only a readable revoke is terminal', (_name, snapshot) => {
        expect(computeRtcRepairAuthorization(toInput(snapshot)).right).toBe('room-authority-decides');
    });

    it.each<[string, GroupSnapshot]>([
        ['publish revoked after the freeze, subscribe kept', createRoom({ a: SUBSCRIBE_ONLY })],
        ['no grant row any more', createRoom({ b: SUBSCRIBE_ONLY })]
    ])('refuses no-publish-grant with %s', (_name, snapshot) => {
        expect(computeRtcRepairAuthorization(toInput(snapshot)).left).toEqual({ kind: 'no-publish-grant' });
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
