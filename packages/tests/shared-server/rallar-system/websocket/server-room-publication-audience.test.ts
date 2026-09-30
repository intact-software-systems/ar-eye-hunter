import { describe, expect, it } from 'vitest';

import { computeServerRoomPublicationAudience } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';

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

        const audience = computeServerRoomPublicationAudience(snapshot, message, 100);

        expect(audience?.sessions.map((session) => session.sessionId)).toEqual(['session-1']);
        expect(audience?.targets).toEqual(message.targets);
        expect(computeServerRoomPublicationAudience(snapshot, {
            ...message,
            targets: { mode: 'broadcast', scope: 'room', groupRef: { ...groupRef, workspaceId: 'other' } }
        }, 100)).toBeUndefined();
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

        expect(computeServerRoomPublicationAudience(archived, message, 100)).toBeUndefined();
    });
});
