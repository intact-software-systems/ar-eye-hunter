import { describe, expect, it } from 'vitest';

import { toMembersTopicPublicationAuthority } from '@shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.ts';
import { computeServerRoomPublicationAudience } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';

import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

describe('trusted server room publication audience', () => {
    it('freezes only live member sessions from the exact active room', () => {
        const snapshot = createGroupSnapshot(2, ['session-1']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', groupRef.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef }
        );

        const audience = computeServerRoomPublicationAudience({
            ...members(message),
            authority: toMembersTopicPublicationAuthority(snapshot),
            nowEpochMs: 100
        });

        expect(audience?.right?.sessions.map((session) => session.sessionId)).toEqual(['session-1']);
        expect(audience?.right?.targets).toEqual(message.targets);
        expect(computeServerRoomPublicationAudience({
            ...members({
                ...message,
                targets: { mode: 'broadcast', scope: 'room', groupRef: { ...groupRef, workspaceId: 'other' } }
            }),
            authority: toMembersTopicPublicationAuthority(snapshot),
            nowEpochMs: 100
        })).toBeUndefined();
    });

    it('refuses an archived room and its stale sessions', () => {
        const snapshot = createGroupSnapshot(2, ['session-1']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', groupRef.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef }
        );
        const archived = {
            ...snapshot,
            group: {
                ...snapshot.group,
                status: 'archived' as const,
                archived: snapshot.group.updated,
                deleted: null
            }
        };

        expect(computeServerRoomPublicationAudience({
            ...members(message),
            authority: toMembersTopicPublicationAuthority(archived),
            nowEpochMs: 100
        }))
            .toBeUndefined();
    });

    it('refuses a server producer the granted topic does not list as topic-not-granted', () => {
        const snapshot = createGroupSnapshot(2, ['session-1']);
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', snapshot.group.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef: snapshot.group }
        );

        const refused = computeServerRoomPublicationAudience({
            message,
            topic: { participation: 'granted', serverProducerIds: ['match-producer'] },
            producerId: undefined,
            authority: toMembersTopicPublicationAuthority(snapshot),
            nowEpochMs: 100
        });

        expect(refused?.left?.code).toBe('topic-not-granted');
    });

    it('a listed producer reaches the subscribed sessions of the granted topic, each with its live generation', () => {
        const base = createGroupSnapshot(2, ['session-1', 'session-2']);
        const snapshot = {
            ...base,
            publicationGrants: base.activeSessions.map((session) => ({
                applicationId: base.group.applicationId,
                workspaceId: base.group.workspaceId,
                groupId: base.group.groupId,
                principalId: session.principalId,
                topics: { 'room.match': { publish: false, subscribe: true } },
                updated: base.group.updated
            }))
        };
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', snapshot.group.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef: snapshot.group }
        );
        const subscribed = snapshot.activeSessions[1]!;

        const audience = computeServerRoomPublicationAudience({
            message,
            topic: { participation: 'granted', serverProducerIds: ['match-producer'] },
            producerId: 'match-producer',
            authority: {
                snapshot,
                subscriptions: [{
                    sessionId: subscribed.sessionId,
                    principalId: subscribed.principalId,
                    topicId: 'room.match',
                    connectionGenerationId: 'client-generation-2',
                    leaseExpiresAtEpochMs: 200,
                    admittedAtGroupRevision: 2
                }],
                liveSessionGenerations: { [subscribed.sessionId]: ['client-generation-2'] }
            },
            nowEpochMs: 100
        });

        expect(audience?.right?.sessions.map((session) => session.sessionId)).toEqual([subscribed.sessionId]);
        expect(audience?.right?.recipientConnectionGenerationIds).toEqual({ [subscribed.sessionId]: 'client-generation-2' });
    });
});

function members(message: ALMessage) {
    return { message, topic: { participation: 'members' } as const, producerId: undefined };
}
