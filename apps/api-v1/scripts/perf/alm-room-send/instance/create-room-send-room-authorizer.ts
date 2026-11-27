import type {
    RallarServerWsRoomAudience,
    RallarServerWsRoomAuthorizer
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';

/** The one room of a run and its sessions, as they stay for the whole run. */
export interface RoomSendRoomAudienceInput {
    readonly roomRef: GroupRef;
    /** Every session of the room, on whichever instance its socket is. */
    readonly sessionPeerIds: readonly string[];
    readonly connectedAtEpochMs: number;
    /** When the sessions' presence would lapse: past the end of the run. */
    readonly expiresAtEpochMs: number;
}

/** The version every audience is read at: the room never changes, so its snapshot never moves. */
const ROOM_SEND_ROOM_SNAPSHOT_VERSION = 1;

/**
 * The room authorizer of a run: it admits a room send of a session of the room to the room's fixed audience, and
 * refuses every other send. It stands where the API puts `createApiV1RoomWsAuthorizer`, which reads the room's
 * current snapshot from the database for each decision; here nothing is read, so those reads are no part of a run.
 * The topic of a send has no publication grant, so the presence and connection generations of the audience are
 * compared by nobody, and each session carries a placeholder for them.
 */
export function createRoomSendRoomAuthorizer(input: RoomSendRoomAudienceInput): RallarServerWsRoomAuthorizer {
    const sessions = input.sessionPeerIds.map((sessionPeerId) => toRoomPresenceSession(sessionPeerId, input));
    return ({ message, roomRef, senderId }) => {
        const { targets } = message;
        if (
            targets === undefined || roomRef === undefined || !isSameGroupRef(roomRef, input.roomRef) ||
            !input.sessionPeerIds.includes(senderId)
        ) {
            return false;
        }
        const audience: RallarServerWsRoomAudience = {
            targets,
            sessions,
            snapshotVersion: ROOM_SEND_ROOM_SNAPSHOT_VERSION,
            recipientConnectionGenerationIds: {}
        };
        return { authorized: true, audience };
    };
}

function toRoomPresenceSession(sessionPeerId: string, input: RoomSendRoomAudienceInput): GroupPresenceSession {
    return {
        applicationId: input.roomRef.applicationId,
        workspaceId: input.roomRef.workspaceId,
        groupId: input.roomRef.groupId,
        sessionId: sessionPeerId,
        principalId: sessionPeerId,
        generationId: `${sessionPeerId}-presence`,
        generationVersion: 1,
        connectionGenerationId: `${sessionPeerId}-connection`,
        publicationKey: null,
        connectedAtEpochMs: input.connectedAtEpochMs,
        lastHeartbeatAtEpochMs: input.connectedAtEpochMs,
        expiresAtEpochMs: input.expiresAtEpochMs,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}
