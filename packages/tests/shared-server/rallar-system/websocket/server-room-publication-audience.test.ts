import { describe, expect, it } from 'vitest';

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

        const audience = computeServerRoomPublicationAudience({ ...members(message), snapshot, nowEpochMs: 100 });

        expect(audience?.right?.sessions.map((session) => session.sessionId)).toEqual(['session-1']);
        expect(audience?.right?.targets).toEqual(message.targets);
        expect(computeServerRoomPublicationAudience({
            ...members({
                ...message,
                targets: { mode: 'broadcast', scope: 'room', groupRef: { ...groupRef, workspaceId: 'other' } }
            }),
            snapshot,
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

        expect(computeServerRoomPublicationAudience({ ...members(message), snapshot: archived, nowEpochMs: 100 }))
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
            snapshot,
            nowEpochMs: 100
        });

        expect(refused?.left?.code).toBe('topic-not-granted');
    });
});

function members(message: ALMessage) {
    return { message, topic: { participation: 'members' } as const, producerId: undefined };
}
