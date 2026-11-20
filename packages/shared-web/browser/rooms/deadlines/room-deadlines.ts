import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import {
    assertRoomDeadlineChange,
    assertRoomDeadlineName,
    readRoomDeadline,
    type RoomDeadline,
    type RoomDeadlineChange
} from '@shared/api/group-deadlines/room-deadline.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';

import { parseGroupStateDeltaEnvelope } from '../../state-cache/group-state-delta-application.ts';
import { readStateGroupSnapshot } from '../../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from '../browser-rallar-rooms.ts';
import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';
import { captureRoomSession } from '../room-session-fence.ts';
import { watchRoomDeadline, type RoomDeadlineObservation } from './watch-room-deadline.ts';

export interface RoomDeadlineOperations {
    watchDeadline(
        roomRef: GroupRef,
        name: string,
        listener: (observation: RoomDeadlineObservation) => void,
        options?: { readonly signal?: AbortSignal; }
    ): () => void;
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

export function createRoomDeadlineOperations(
    { requireSession, roomEvents, ws, auth }: Pick<
        CreateBrowserRallarRoomsInput,
        'requireSession' | 'roomEvents' | 'ws' | 'auth'
    >
): RoomDeadlineOperations {
    const readDeadline: RoomDeadlineOperations['readDeadline'] = async (roomRef, name, { signal } = {}) => {
        const room = toExplicitRoomRef(roomRef);
        const fence = captureRoomSession(requireSession, signal);
        fence.assertCurrent();
        const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal });
        fence.assertCurrent();
        if (result.source !== 'durable') {
            throw new Error('Room deadline reads require a durable group snapshot.');
        }
        return readRoomDeadline(result.snapshot.group.metadata, name);
    };
    return {
        readDeadline,
        watchDeadline(roomRef, name, listener, { signal } = {}) {
            const room = toExplicitRoomRef(roomRef);
            assertRoomDeadlineName(name);
            const fence = captureRoomSession(requireSession, signal);
            return watchRoomDeadline({
                signal,
                listener,
                ws,
                onSessionEnd: (stop) =>
                    auth.onChange(({ session }) => {
                        if (
                            session?.sessionId !== fence.session.sessionId ||
                            session?.clientId !== fence.session.clientId
                        ) {
                            stop();
                        }
                    }, { emitCurrent: false }),
                subscribe: (changed) =>
                    roomEvents.onEvent((_event, message) => {
                        if (message.transport === 'ws') {
                            const delta = parseGroupStateDeltaEnvelope(message.raw.payload.resource, room);
                            if (delta) {
                                changed(readRoomDeadline(delta.group.metadata, name)?.revision ?? 0);
                            }
                        }
                    }, {
                        roomRef: room,
                        scope: room,
                        eventTypes: ['group-updated']
                    }),
                read: async (readSignal) => {
                    fence.assertCurrent();
                    return await readDeadline(room, name, { signal: readSignal });
                }
            });
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
