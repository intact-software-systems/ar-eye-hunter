import { describe, expect, it } from 'vitest';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';

describe('createGroupRoomWsAuthorizer', () => {
    it('authorizes room messages with a scoped group snapshot resolver when same group id exists in multiple workspaces', async () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            ['session-a'],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotById: () => workspaceA,
            resolveGroupRef: (input) => ({
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: input.roomId,
            }),
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'workspace-b' },
        );

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }));

        expect(decision).toBe(true);
    });

    it('authorizes multicast messages using target groupRef without an external resolver', async () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            ['session-a'],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-1'),
                workspaceB.group,
                'chat.message.v1',
                { text: 'workspace-b' },
            ),
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }));

        expect(decision).toBe(true);
    });
});

function createGroupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    sessionIds: readonly string[],
    snapshotVersion: number,
): GroupSnapshot {
    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
