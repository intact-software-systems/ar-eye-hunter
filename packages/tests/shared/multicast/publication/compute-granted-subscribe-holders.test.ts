import { describe, expect, it } from 'vitest';

import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { computeGrantedSubscribeHolders } from '@shared/multicast/publication/compute-granted-subscribe-holders.ts';

import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from '../rtc-publication-proof-fixtures.ts';

const NOW_MS = Date.now();

describe('computeGrantedSubscribeHolders', () => {
    it('names the live sessions whose principal holds subscribe on the topic, a spectator\'s included', () => {
        const snapshot = toSpectating(
            createPublicationRoomSnapshot({
                sessionIds: ['a', 'b', 'c', 'd'],
                snapshotVersion: 3,
                keys: {},
                grants: { a: PUBLISH_ONLY, b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY }
            }),
            'c'
        );

        expect([...computeGrantedSubscribeHolders(snapshot, PUBLICATION_TOPIC_ID, NOW_MS)]).toEqual(['b', 'c']);
    });

    it('leaves out a holder whose member row is not active and a holder whose session lease lapsed', () => {
        const room = createPublicationRoomSnapshot({
            sessionIds: ['a', 'b', 'c', 'd'],
            snapshotVersion: 3,
            keys: {},
            grants: { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY, d: SUBSCRIBE_ONLY }
        });
        const snapshot: GroupSnapshot = {
            ...room,
            members: room.members.map((member) => member.principalId === 'b' ? toLeftMember(member) : member),
            activeSessions: room.activeSessions.map((session) => session.sessionId === 'c' ? { ...session, expiresAtEpochMs: NOW_MS } : session)
        };

        expect([...computeGrantedSubscribeHolders(snapshot, PUBLICATION_TOPIC_ID, NOW_MS)]).toEqual(['d']);
    });

    it('names no session for a topic no grant row lets anyone subscribe to', () => {
        const snapshot = createPublicationRoomSnapshot({
            sessionIds: ['a', 'b'],
            snapshotVersion: 3,
            keys: {},
            grants: { b: SUBSCRIBE_ONLY }
        });

        expect(computeGrantedSubscribeHolders(snapshot, 'room.other-feed', NOW_MS).size).toBe(0);
    });
});

function toLeftMember(member: GroupMember): GroupMember {
    return { ...member, status: 'left', joined: member.joined, left: member.updated, removed: null, banned: null };
}

function toSpectating(snapshot: GroupSnapshot, principalId: string): GroupSnapshot {
    return {
        ...snapshot,
        members: snapshot.members.map((member) => member.principalId === principalId ? { ...member, role: 'spectator' } : member)
    };
}
