import { describe, expect, it } from 'vitest';

import {
    computeRoomPublicationAdmission,
    computeRoomPublicationAudience,
    type RoomPublicationAdmission
} from '@shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.ts';
import { toAuthorizedRoomAudience } from '@shared-server/rallar-system/websocket/room-publication/to-authorized-room-audience.ts';
import type { ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { GroupPublicationTopicGrants } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
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
    it('a members topic ignores subscriptions and returns exactly toAuthorizedRoomAudience\'s audience', () => {
        const snapshot = createGrantedSnapshot();
        const message = { targets: roomBroadcast(snapshot) };

        const admission = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot, ['sub-1']),
            topic: MEMBERS,
            publisher: session(snapshot, 'none-1'),
            message,
            nowEpochMs: NOW
        });

        expect(admission.right).toEqual(toAuthorizedRoomAudience(snapshot, message, NOW));
        expect(admission.right?.sessions).toHaveLength(snapshot.activeSessions.length);
        expect(admission.right?.recipientConnectionGenerationIds).toEqual({});
    });

    it.each([
        ['no row', 'none-1'],
        ['a subscribe-only row', 'sub-1'],
        ['a spectator with a publish row', 'spec-1']
    ])('a session without effective publish is no-publish-grant (%s)', (_label, sessionId) => {
        const snapshot = createGrantedSnapshot();

        const admission = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot),
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
            ...subscribedAuthority(snapshot),
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
                ...subscribedAuthority(snapshot),
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
            ...subscribedAuthority(snapshot),
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
            ...subscribedAuthority(snapshot),
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: {
                targets: { mode: 'broadcast', scope: 'principal', groupRef, principalRef: { ...groupRef, principalId: 'principal-none-1' } }
            },
            nowEpochMs: NOW
        });
        const toSubscriber = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot),
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

        const publisher = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot),
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message,
            nowEpochMs: NOW
        });
        const producer = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot),
            topic: GRANTED,
            publisher: { kind: 'server-producer', producerId: 'feed-producer' },
            message,
            nowEpochMs: NOW
        });
        const members = computeRoomPublicationAudience({ ...subscribedAuthority(snapshot), topic: MEMBERS, message, nowEpochMs: NOW });

        expect(publisher.left?.code).toBe('no-publish-grant');
        expect(producer.right?.sessions).toEqual([]);
        expect(computeRoomPublicationAudience({ ...subscribedAuthority(snapshot), topic: GRANTED, message, nowEpochMs: NOW }).sessions).toEqual([]);
        expect(members).toEqual(toAuthorizedRoomAudience(snapshot, message, NOW));
    });

    it('the publisher\'s sibling session stays in the audience', () => {
        const snapshot = createGrantedSnapshot();

        const audience = computeRoomPublicationAudience({
            ...subscribedAuthority(snapshot),
            topic: GRANTED,
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });

        // pub-1 holds publish and subscribe: both its sessions are subscribers; the router drops only the origin session.
        expect(toSessionIds(audience.sessions)).toContain('pub-1-sibling');
        expect(toSessionIds(audience.sessions)).not.toContain('pub-2');
    });
});

describe('computeRoomPublicationAudience: the granted intersection', () => {
    it('a granted audience holds only sessions with a live subscription asserted by their live generation', () => {
        const snapshot = createGrantedSnapshot();

        const audience = grantedAudience(snapshot, subscribedAuthority(snapshot, ['pub-1', 'spec-1']));

        expect(toSessionIds(audience.sessions)).toEqual(['pub-1', 'spec-1']);
    });

    it('a subscription row of an older generation is excluded', () => {
        const snapshot = createGrantedSnapshot();
        const authority = subscribedAuthority(snapshot, ['pub-1', 'sub-1']);

        const audience = grantedAudience(snapshot, {
            ...authority,
            liveSessionGenerations: { ...authority.liveSessionGenerations, 'sub-1': ['live-generation-sub-1-reopened'] }
        });

        expect(toSessionIds(audience.sessions)).toEqual(['pub-1']);
    });

    it('a session with no active client row is excluded', () => {
        const snapshot = createGrantedSnapshot();
        const authority = subscribedAuthority(snapshot, ['pub-1', 'sub-1']);
        const { 'sub-1': _disconnected, ...liveSessionGenerations } = authority.liveSessionGenerations;

        const audience = grantedAudience(snapshot, { ...authority, liveSessionGenerations });

        expect(toSessionIds(audience.sessions)).toEqual(['pub-1']);
    });

    it('a subscription row is live when any active client row of its session carries its generation (C8)', () => {
        const snapshot = createGrantedSnapshot();
        const authority = subscribedAuthority(snapshot, ['sub-1']);

        const audience = grantedAudience(snapshot, {
            ...authority,
            liveSessionGenerations: { 'sub-1': ['live-generation-sub-1-other-instance', 'live-generation-sub-1'] }
        });

        expect(toSessionIds(audience.sessions)).toEqual(['sub-1']);
        expect(audience.recipientConnectionGenerationIds).toEqual({ 'sub-1': 'live-generation-sub-1' });
    });

    it('a lapsed lease is excluded', () => {
        const snapshot = createGrantedSnapshot();
        const authority = subscribedAuthority(snapshot, ['pub-1', 'sub-1']);

        const audience = grantedAudience(snapshot, {
            ...authority,
            subscriptions: authority.subscriptions.map((row) => row.sessionId === 'sub-1' ? { ...row, leaseExpiresAtEpochMs: NOW } : row)
        });

        expect(toSessionIds(audience.sessions)).toEqual(['pub-1']);
    });

    it('a subscription row for another topic is excluded', () => {
        const snapshot = createGrantedSnapshot();
        const authority = subscribedAuthority(snapshot, ['pub-1', 'sub-1']);

        const audience = grantedAudience(snapshot, {
            ...authority,
            subscriptions: authority.subscriptions.map((row) => row.sessionId === 'sub-1' ? { ...row, topicId: 'room.other' } : row)
        });

        expect(toSessionIds(audience.sessions)).toEqual(['pub-1']);
    });

    it('a session with a row but no effective subscribe is excluded', () => {
        // pub-2 publishes only; a revoke of none-1's grant whose row delete this read has not yet seen leaves the same orphan.
        const snapshot = createGrantedSnapshot();

        const audience = grantedAudience(snapshot, subscribedAuthority(snapshot, ['pub-2', 'none-1', 'sub-1']));

        expect(toSessionIds(audience.sessions)).toEqual(['sub-1']);
    });

    it('an orphan row whose principal holds no subscribe grant is never in the audience (C10)', () => {
        const active = createGrantedSnapshot();
        const snapshot = { ...active, publicationGrants: active.publicationGrants.filter((grant) => grant.principalId !== 'principal-sub-1') };

        const audience = grantedAudience(snapshot, subscribedAuthority(snapshot, ['sub-1', 'pub-1']));

        expect(toSessionIds(audience.sessions)).toEqual(['pub-1']);
    });

    it('the sibling session of the publisher\'s principal receives when subscribed', () => {
        const snapshot = createGrantedSnapshot();

        const subscribed = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot, ['pub-1', 'pub-1-sibling']),
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });
        const unsubscribed = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot, ['pub-1']),
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });

        expect(toSessionIds(subscribed.right?.sessions)).toEqual(['pub-1', 'pub-1-sibling']);
        expect(toSessionIds(unsubscribed.right?.sessions)).toEqual(['pub-1']);
    });

    it('recipientConnectionGenerationIds names each audience session\'s live generation', () => {
        const snapshot = createGrantedSnapshot();

        const audience = grantedAudience(snapshot, subscribedAuthority(snapshot, ['pub-1', 'sub-1', 'pub-2']));

        expect(audience.recipientConnectionGenerationIds).toEqual({
            'pub-1': 'live-generation-pub-1',
            'sub-1': 'live-generation-sub-1'
        });
    });

    it('an empty intersection is an admitted audience with no session', () => {
        const snapshot = createGrantedSnapshot();

        const admission = computeRoomPublicationAdmission({
            ...subscribedAuthority(snapshot, []),
            topic: GRANTED,
            publisher: session(snapshot, 'pub-1'),
            message: { targets: roomBroadcast(snapshot) },
            nowEpochMs: NOW
        });

        expect(admission.right).toEqual({
            targets: roomBroadcast(snapshot),
            sessions: [],
            snapshotVersion: snapshot.group.snapshotVersion,
            recipientConnectionGenerationIds: {}
        });
    });
});

function grantedAudience(
    snapshot: GroupSnapshot,
    authority: SubscriptionAuthority
) {
    return computeRoomPublicationAudience({
        ...authority,
        snapshot,
        topic: GRANTED,
        message: { targets: roomBroadcast(snapshot) },
        nowEpochMs: NOW
    });
}

type SubscriptionAuthority = Pick<RoomPublicationAdmission.Input, 'snapshot' | 'subscriptions' | 'liveSessionGenerations'>;

/** A live subscription row on the topic, asserted by the session's one active client generation, for each named session. */
function subscribedAuthority(
    snapshot: GroupSnapshot,
    sessionIds: readonly string[] = snapshot.activeSessions.map((candidate) => candidate.sessionId)
): SubscriptionAuthority {
    const sessions = snapshot.activeSessions.filter((candidate) => sessionIds.includes(candidate.sessionId));
    return {
        snapshot,
        subscriptions: sessions.map((candidate): GroupTopicSubscription => ({
            sessionId: candidate.sessionId,
            principalId: candidate.principalId,
            topicId: TOPIC_ID,
            connectionGenerationId: `live-generation-${candidate.sessionId}`,
            leaseExpiresAtEpochMs: NOW + 120_000,
            admittedAtGroupRevision: snapshot.group.snapshotVersion
        })),
        liveSessionGenerations: Object.fromEntries(
            sessions.map((candidate) => [candidate.sessionId, [`live-generation-${candidate.sessionId}`]])
        )
    };
}

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
