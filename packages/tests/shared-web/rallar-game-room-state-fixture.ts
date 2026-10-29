import type { RallarRoomMember, RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createActiveGroupMemberFixture, createActiveGroupPresenceSessionFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

/** Supplies the canonical snapshot and its room projection together for game authorization tests. */
export function createGameRoomStateFixture(roomRef: GroupRef, members: readonly RallarRoomMember[]): RallarRoomState {
    const active = members.filter((member) => member.status === 'active');
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: active.map((member) => member.principalId) });
    return {
        rooms: [],
        currentRoomId: roomRef.groupId,
        currentRoomRef: roomRef,
        members,
        currentRoom: {
            ...snapshot,
            group: { ...snapshot.group, activeMemberCount: active.length },
            members: active.map((member) =>
                createActiveGroupMemberFixture({
                    ...roomRef,
                    principalId: member.principalId,
                    role: member.role,
                    actorPrincipalId: member.principalId
                })
            ),
            activeSessions: active.flatMap((member) =>
                member.sessionIds.map((sessionId) => ({
                    ...createActiveGroupPresenceSessionFixture({ ...roomRef, principalId: member.principalId, sessionId }),
                    expiresAtEpochMs: Date.now() + 60_000
                }))
            ),
            memberCount: active.length,
            onlineMemberCount: active.filter((member) => member.sessionIds.length > 0).length
        }
    };
}
