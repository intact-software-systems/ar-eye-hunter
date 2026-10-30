import { describe, expect, it } from 'vitest';

import {
    computeRoomPublicationAdmission,
    computeRoomPublicationAudience,
    type RoomPublicationAdmission
} from '@shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.ts';
import { toAuthorizedRoomAudience } from '@shared-server/rallar-system/websocket/room-publication/to-authorized-room-audience.ts';
import type { ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { GroupPublicationTopicGrants } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

const TOPIC_ID = 'room.feed';
const GRANTED: RoomPublicationAdmission.Input['topic'] = {
    topicId: TOPIC_ID,
    participation: 'granted',
    serverProducerIds: ['feed-producer']
};
const MEMBERS: RoomPublicationAdmission.Input['topic'] = { topicId: TOPIC_ID, participation: 'members' };
const NOW = 100;

describe('computeRoomPublicationAdmission', () => {
    it('a members topic returns exactly toAuthorizedRoomAudience\'s audience', () => {
        const snapshot = createGrantedSnapshot();
        const message = { targets: roomBroadcast(snapshot) };

        const admission = computeRoomPublicationAdmission({
            snapshot,
            topic: MEMBERS,
            publisher: session(snapshot, 'none-1'),
            message,
            nowEpochMs: NOW
        });

        expect(admission.right).toEqual(toAuthorizedRoomAudience(snapshot, message, NOW));
        expect(admission.right?.sessions).toHaveLength(snapshot.activeSessions.length);
    });

    it.each([
        ['no row', 'none-1'],
        ['a subscribe-only row', 'sub-1'],
        ['a spectator with a publish row', 'spec-1']
    ])('a session without effective publish is no-publish-grant (%s)', (_label, sessionId) => {
        const snapshot = createGrantedSnapshot();

        const admission = computeRoomPublicationAdmission({
            snapshot,
            topic: GRANTED,
            publisher: session(snapshot, sessionId),
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });

        expect(admission.left?.code).toBe('no-publish-grant');
    });

    it('the audience holds only subscribe-granted principals\' live sessions, a spectator with subscribe among them', () => {
        const snapshot = createGrantedSnapshot();

        const admission = computeRoomPublicationAdmission({
            snapshot,
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });

        expect(toSessionIds(admission.right?.sessions)).toEqual(['pub-1', 'pub-1-sibling', 'sub-1', 'spec-1']);
        expect(admission.right?.snapshotVersion).toBe(snapshot.group.snapshotVersion);
    });

    it('a listed producer is admitted; an unlisted or absent producerId is topic-not-granted', () => {
        const snapshot = createGrantedSnapshot();
        const admit = (producerId: string | undefined) =>
            computeRoomPublicationAdmission({
                snapshot,
                topic: GRANTED,
                publisher: { kind: 'server-producer', producerId },
                message: { targets: roomBroadcast(snapshot) },
                nowEpochMs: NOW
            });

        expect(toSessionIds(admit('feed-producer').right?.sessions)).toEqual(['pub-1', 'pub-1-sibling', 'sub-1', 'spec-1']);
        expect(admit('other-producer').left?.code).toBe('topic-not-granted');
        expect(admit(undefined).left?.code).toBe('topic-not-granted');
    });

    it('a granted-topic message without a GroupRef is unsupported', () => {
        const snapshot = createGrantedSnapshot();

        const admission = computeRoomPublicationAdmission({
            snapshot,
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: { targets: { mode: 'broadcast', scope: 'world' } },
            nowEpochMs: NOW
        });

        expect(admission.left?.code).toBe('unsupported');
    });

    it('targeting only narrows', () => {
        const snapshot = createGrantedSnapshot();
        const groupRef = toGroupRef(snapshot);

        const toNonSubscriber = computeRoomPublicationAdmission({
            snapshot,
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: {
                targets: { mode: 'broadcast', scope: 'principal', groupRef, principalRef: { ...groupRef, principalId: 'principal-none-1' } }
            },
            nowEpochMs: NOW
        });
        const toSubscriber = computeRoomPublicationAdmission({
            snapshot,
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: {
                targets: { mode: 'broadcast', scope: 'principal', groupRef, principalRef: { ...groupRef, principalId: 'principal-sub-1' } }
            },
            nowEpochMs: NOW
        });

        expect(toNonSubscriber.right?.sessions).toEqual([]);
        expect(toSessionIds(toSubscriber.right?.sessions)).toEqual(['sub-1']);
    });

    it.each([
        ['archived', { status: 'archived' as const }],
        ['deleted', { status: 'deleted' as const }],
        ['expired', { expiresAtEpochMs: NOW - 1 }]
    ])('a granted topic of a group that is %s admits no session publisher and reaches nobody; a members topic is unchanged', (_label, change) => {
        const active = createGrantedSnapshot();
        const snapshot = { ...active, group: { ...active.group, ...change } } as GroupSnapshot;
        const message = { targets: roomBroadcast(snapshot) };

        const publisher = computeRoomPublicationAdmission({ snapshot, topic: GRANTED, publisher: session(snapshot, 'pub-1'), message, nowEpochMs: NOW });
        const producer = computeRoomPublicationAdmission({
            snapshot,
            topic: GRANTED,
            publisher: { kind: 'server-producer', producerId: 'feed-producer' },
            message,
            nowEpochMs: NOW
        });
        const members = computeRoomPublicationAudience({ snapshot, topic: MEMBERS, message, nowEpochMs: NOW });

        expect(publisher.left?.code).toBe('no-publish-grant');
        expect(producer.right?.sessions).toEqual([]);
        expect(computeRoomPublicationAudience({ snapshot, topic: GRANTED, message, nowEpochMs: NOW }).sessions).toEqual([]);
        expect(members).toEqual(toAuthorizedRoomAudience(snapshot, message, NOW));
    });

    it('the publisher\'s sibling session stays in the audience', () => {
        const snapshot = createGrantedSnapshot();

        const audience = computeRoomPublicationAudience({
            snapshot,
            topic: GRANTED,
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });

        // pub-1 holds publish and subscribe: both its sessions are subscribers; the router drops only the origin session.
        expect(toSessionIds(audience.sessions)).toContain('pub-1-sibling');
        expect(toSessionIds(audience.sessions)).not.toContain('pub-2');
    });
});

/**
 * pub-1 (and its sibling session) publish and subscribe; pub-2 publishes only; sub-1 subscribes; spec-1 is a spectator
 * whose row holds both; none-1 holds no row.
 */
function createGrantedSnapshot(): GroupSnapshot {
    const base = createGroupSnapshot(5, ['pub-1', 'pub-2', 'sub-1', 'spec-1', 'none-1']);
    const sibling: GroupPresenceSession = {
        ...base.activeSessions[0]!,
        sessionId: 'pub-1-sibling',
        generationId: 'generation-pub-1-sibling',
        connectionGenerationId: 'ws-generation-pub-1-sibling'
    };
    const members = base.members.map((member): GroupMember => member.principalId === 'principal-spec-1' ? { ...member, role: 'spectator' } : member);
    const grants: Readonly<Record<string, GroupPublicationTopicGrants>> = {
        'principal-pub-1': { [TOPIC_ID]: { publish: true, subscribe: true } },
        'principal-pub-2': { [TOPIC_ID]: { publish: true, subscribe: false } },
        'principal-spec-1': { [TOPIC_ID]: { publish: true, subscribe: true } },
        'principal-sub-1': { [TOPIC_ID]: { publish: false, subscribe: true }, 'room.other': { publish: true, subscribe: true } }
    };
    return {
        ...base,
        members,
        activeSessions: [...base.activeSessions.slice(0, 1), sibling, ...base.activeSessions.slice(1)],
        publicationGrants: Object.entries(grants).map(([principalId, topics]) => ({
            ...toGroupRef(base),
            principalId,
            topics,
            updated: base.group.updated
        }))
    };
}

function session(snapshot: GroupSnapshot, sessionId: string): RoomPublicationAdmission.Publisher {
    const found = snapshot.activeSessions.find((candidate) => candidate.sessionId === sessionId)!;
    return { kind: 'session', sessionId, principalId: found.principalId };
}

function roomBroadcast(snapshot: GroupSnapshot): ALTargets {
    return { mode: 'broadcast', scope: 'room', groupRef: toGroupRef(snapshot) };
}

function toGroupRef(snapshot: GroupSnapshot) {
    return {
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId
    };
}

function toSessionIds(sessions: readonly GroupPresenceSession[] | undefined): readonly string[] | undefined {
    return sessions?.map((candidate) => candidate.sessionId);
}
