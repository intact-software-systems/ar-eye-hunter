import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import {
    assertRoomDeadlineChange,
    readRoomDeadline,
    type RoomDeadline,
    type RoomDeadlineChange
} from '@shared/api/room-deadline.ts';

import { readStateGroupSnapshot } from '../state-read/point-read.ts';
import { roomGroupStateHttpApi } from './room-group-state-http-api.ts';
import { captureRoomSession } from './room-session-fence.ts';

export interface RoomDeadlineOperations {
    /** Reads durable room authority. A missing name returns null. */
    readDeadline(
        roomRef: GroupRef,
        name: string,
        options?: { readonly signal?: AbortSignal; }
    ): Promise<RoomDeadline | null>;
    /** Reuse the same request ID to retry one change after a lost acknowledgement. */
    setDeadline(
        roomRef: GroupRef,
        change: RoomDeadlineChange,
        requestId: string,
        options?: { readonly signal?: AbortSignal; }
    ): Promise<RoomDeadline>;
}

export function createRoomDeadlineOperations(requireSession: () => AuthSession): RoomDeadlineOperations {
    return {
        async readDeadline(roomRef, name, { signal } = {}) {
            const room = toExplicitRoomRef(roomRef);
            const fence = captureRoomSession(requireSession, signal);
            fence.assertCurrent();
            const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal });
            fence.assertCurrent();
            if (result.source !== 'durable') {
                throw new Error('Room deadline reads require a durable group snapshot.');
            }
            return readRoomDeadline(result.snapshot.group.metadata, name);
        },
        async setDeadline(roomRef, change, requestId, { signal } = {}) {
            const room = toExplicitRoomRef(roomRef);
            const roomDeadline = { ...change };
            assertRoomDeadlineChange(roomDeadline);
            const fence = captureRoomSession(requireSession, signal);
            fence.assertCurrent();
            const snapshot = await roomGroupStateHttpApi.updateGroup({
                groupId: room.groupId,
                scope: room,
                request: {
                    actorPrincipalId: fence.session.clientId,
                    actorSessionId: fence.session.sessionId,
                    roomDeadline
                },
                options: { authSession: fence.session, requestId, signal }
            });
            fence.assertCurrent();
            validateAuthoritativeGroupSnapshot(snapshot, room);
            if (!isSameGroupRef(snapshot.group, room)) {
                throw new Error('Room deadline acknowledgement belongs to another room.');
            }
            const acknowledged = readRoomDeadline(snapshot.group.metadata, roomDeadline.name);
            if (
                acknowledged?.revision !== roomDeadline.expectedRevision + 1 ||
                acknowledged.atEpochMs !== roomDeadline.atEpochMs
            ) {
                throw new Error('Room deadline acknowledgement does not match the requested change.');
            }
            return acknowledged;
        }
    };
}

function toExplicitRoomRef(roomRef: GroupRef): GroupRef {
    assertValidRallarGroupRef(roomRef, '$.roomRef');
    assertValidRallarRouteId(roomRef.workspaceId, '$.roomRef.workspaceId', 'Workspace ID');
    return { ...roomRef };
}
