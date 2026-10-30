import { describe, expect, it } from 'vitest';

import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';

import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

describe('the room audience a server publish reads (D58, Q7)', () => {
    it('reads the active members\' live sessions of the named room at its snapshot version', async () => {
        const snapshot = createGroupSnapshot(3, ['session-1', 'session-2']);
        const reader = createServerPublishRoomAudienceReader({
            readGroupSnapshot: async (ref) => ref.groupId === snapshot.group.groupId ? snapshot : undefined,
            readPublicationAuthority: () => Promise.reject(new Error('A members topic reads no publication authority.')),
            nowEpochMs: Date.now
        });
        const message = newALBroadcastMessage(
            'server',
            newALRoute('room.snapshot', snapshot.group.groupId, 'r1'),
            'room',
            'snapshot.v1',
            {},
            {
                groupRef: snapshot.group
            }
        );

        const audience = await reader({ message, topic: MEMBERS, producerId: undefined });

        expect(audience?.right?.sessions.map((session) => session.sessionId)).toEqual([
            'session-1',
            'session-2'
        ]);
        expect(audience?.right?.targets).toEqual(message.targets);
        expect(
            await reader({
                message: {
                    ...message,
                    targets: {
                        mode: 'broadcast',
                        scope: 'room',
                        groupRef: { ...snapshot.group, groupId: 'other' }
                    }
                },
                topic: MEMBERS,
                producerId: undefined
            })
        )
            .toBeUndefined();
    });

    it('admits a listed producer on a granted topic to the subscribed sessions and refuses an unlisted one (D496, D489)', async () => {
        const base = createGroupSnapshot(3, ['session-1', 'session-2']);
        const snapshot = {
            ...base,
            publicationGrants: [{
                applicationId: base.group.applicationId,
                workspaceId: base.group.workspaceId,
                groupId: base.group.groupId,
                principalId: 'principal-session-2',
                topics: { 'room.snapshot': { publish: false, subscribe: true } },
                updated: base.group.updated
            }]
        };
        const reader = createServerPublishRoomAudienceReader({
            readGroupSnapshot: () => Promise.reject(new Error('A granted topic reads its publication authority.')),
            readPublicationAuthority: async (_ref, topicId) => ({
                snapshot,
                subscriptions: snapshot.activeSessions.map((session) => ({
                    sessionId: session.sessionId,
                    principalId: session.principalId,
                    topicId,
                    connectionGenerationId: `client-generation-${session.sessionId}`,
                    leaseExpiresAtEpochMs: Date.now() + 120_000,
                    admittedAtGroupRevision: 3
                })),
                liveSessionGenerations: Object.fromEntries(
                    snapshot.activeSessions.map((session) => [session.sessionId, [`client-generation-${session.sessionId}`]])
                )
            }),
            nowEpochMs: Date.now
        });
        const message = newALBroadcastMessage(
            'server',
            newALRoute('room.snapshot', snapshot.group.groupId, 'r1'),
            'room',
            'snapshot.v1',
            {},
            { groupRef: snapshot.group }
        );
        const topic = { participation: 'granted', serverProducerIds: ['snapshot-producer'] } as const;

        const listed = await reader({ message, topic, producerId: 'snapshot-producer' });
        const unlisted = await reader({ message, topic, producerId: 'other-producer' });

        // session-1 subscribed but holds no grant; session-2 holds subscribe and a live subscription.
        expect(listed?.right?.sessions.map((session) => session.sessionId)).toEqual(['session-2']);
        expect(listed?.right?.recipientConnectionGenerationIds).toEqual({ 'session-2': 'client-generation-session-2' });
        expect(unlisted?.left?.code).toBe('topic-not-granted');
    });
});

const MEMBERS = { participation: 'members' } as const;
