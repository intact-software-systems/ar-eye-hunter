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

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import {
    assertRoomClockCommand,
    assertRoomClockMutation,
    readRoomClock,
    type RoomClock,
    type RoomClockCommand,
    type RoomClockMutation
} from '@shared/api/group-deadlines/room-clock.ts';
import { readRoomTimeline, type RoomTimeline, type RoomTimelineAdvance } from '@shared/api/group-deadlines/room-timeline.ts';
import { parseGroupStateDeltaEnvelope } from '../../state-cache/group-state-delta-application.ts';
import { readStateGroupSnapshot } from '../../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from '../browser-rallar-rooms.ts';
import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';
import { captureRoomSession } from '../room-session-fence.ts';
import { watchRoomTime } from './watch-room-time.ts';

export interface RoomDeadlineObservation {
    readonly status: 'current' | 'stale';
    readonly deadline: RoomDeadline | null;
}
export interface RoomClockObservation {
    readonly status: 'current' | 'stale';
    readonly clock: RoomClock | RoomTimeline | null;
}

export interface RoomTimelineObservation {
    readonly status: 'current' | 'stale';
    readonly timeline: RoomTimeline | null;
}

export interface RoomTimeOperations {
    advanceTimeline(
        room: GroupRef, advance: RoomTimelineAdvance, requestId: string, options?: { readonly signal?: AbortSignal; }
    ): Promise<RoomTimeline>;
    readTimeline(room: GroupRef, name: string, options?: { readonly signal?: AbortSignal; }): Promise<RoomTimeline | null>;
    watchTimeline(
        room: GroupRef, name: string, listener: (state: RoomTimelineObservation) => void,
        options?: { readonly signal?: AbortSignal; }
    ): () => void;
    changeClock(
        room: GroupRef,
        command: RoomClockCommand,
        requestId: string,
        options?: { readonly signal?: AbortSignal; }
    ): Promise<RoomClock>;
    readClock(room: GroupRef, name: string, options?: { readonly signal?: AbortSignal; }): Promise<RoomClock | RoomTimeline | null>;
    watchClock(
        room: GroupRef,
        name: string,
        listener: (state: RoomClockObservation) => void,
        options?: { readonly signal?: AbortSignal; }
    ): () => void;
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

interface WriteRoomTime {
    readonly roomRef: GroupRef;
    readonly change: { roomDeadline: RoomDeadlineChange; } | { roomClock: RoomClockMutation; };
    readonly requestId: string;
    readonly signal?: AbortSignal;
}

export function createRoomTimeOperations(
    { requireSession, roomEvents, ws, auth }: Pick<
        CreateBrowserRallarRoomsInput,
        'requireSession' | 'roomEvents' | 'ws' | 'auth'
    >
): RoomTimeOperations {
    async function readMetadata(roomRef: GroupRef, signal?: AbortSignal) {
        const room = toExplicitRoomRef(roomRef);
        const fence = captureRoomSession(requireSession, signal);
        fence.assertCurrent();
        const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal });
        fence.assertCurrent();
        if (result.source !== 'durable') {
            throw new Error('Room time reads require a durable group snapshot.');
        }
        return result.snapshot.group.metadata;
    }
    function watch<T extends { readonly revision: number; }>(
        roomRef: GroupRef,
        name: string,
        decode: (metadata: ApiJsonObject, name: string) => T | null,
        listener: (observation: { status: 'current' | 'stale'; value: T | null; }) => void,
        regresses: (previous: T, next: T) => boolean,
        signal?: AbortSignal
    ) {
        const room = toExplicitRoomRef(roomRef);
        assertRoomDeadlineName(name);
        const fence = captureRoomSession(requireSession, signal);
        return watchRoomTime<T>({
            regresses,
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
                            changed(decode(delta.group.metadata, name)?.revision ?? 0);
                        }
                    }
                }, {
                    roomRef: room,
                    scope: room,
                    eventTypes: ['group-updated']
                }),
            read: async (readSignal) => {
                fence.assertCurrent();
                return decode(await readMetadata(room, readSignal), name);
            }
        });
    }
    async function write({ roomRef, change, requestId, signal }: WriteRoomTime) {
        const room = toExplicitRoomRef(roomRef);
        const fence = captureRoomSession(requireSession, signal);
        fence.assertCurrent();
        const snapshot = await roomGroupStateHttpApi.updateGroup({
            groupId: room.groupId,
            scope: room,
            request: {
                actorPrincipalId: fence.session.clientId,
                actorSessionId: fence.session.sessionId,
                ...change
            },
            options: { authSession: fence.session, requestId, signal }
        });
        fence.assertCurrent();
        validateAuthoritativeGroupSnapshot(snapshot, room);
        if (!isSameGroupRef(snapshot.group, room)) {
            throw new Error('Room time acknowledgement belongs to another room.');
        }
        return snapshot.group.metadata;
    }
    return {
        async advanceTimeline(room, advance, requestId, { signal } = {}) {
            const roomClock = { ...advance, operation: 'advance-phase' as const };
            assertRoomClockMutation(roomClock);
            const metadata = await write({ roomRef: room, change: { roomClock }, requestId, signal });
            const timeline = readRoomTimeline(metadata, roomClock.name);
            if (!timeline || timeline.status !== 'running' || timeline.phase !== roomClock.phase ||
                timeline.revision !== roomClock.expectedRevision + 1 || timeline.startedAtRevision !== timeline.revision) {
                throw new Error('Timeline acknowledgement does not match the requested phase.');
            }
            return timeline;
        },
        async readTimeline(room, name, { signal } = {}) {
            return readRoomTimeline(await readMetadata(room, signal), name);
        },
        watchTimeline(room, name, listener, { signal } = {}) {
            return watch(room, name, readRoomTimeline, ({ status, value }) => listener({ status, timeline: value }),
                (a, b) => b.startedAtRevision < a.startedAtRevision ||
                    (a.startedAtRevision === b.startedAtRevision && a.phase !== b.phase) ||
                    (a.revision === b.revision && JSON.stringify(a) !== JSON.stringify(b)), signal);
        },
        async readDeadline(room, name, { signal } = {}) {
            return readRoomDeadline(await readMetadata(room, signal), name);
        },
        async readClock(room, name, { signal } = {}) {
            return readRoomClock(await readMetadata(room, signal), name);
        },
        watchDeadline(room, name, listener, { signal } = {}) {
            return watch(
                room,
                name,
                readRoomDeadline,
                ({ status, value }) => listener({ status, deadline: value }),
                (a, b) =>
                    (b.startedAtRevision ?? 1) < (a.startedAtRevision ?? 1) ||
                    (a.revision === b.revision &&
                        (a.atEpochMs !== b.atEpochMs || a.startedAtRevision !== b.startedAtRevision)),
                signal
            );
        },
        watchClock(room, name, listener, { signal } = {}) {
            return watch(
                room,
                name,
                readRoomClock,
                ({ status, value }) => listener({ status, clock: value }),
                (a, b) => a.revision === b.revision && JSON.stringify(a) !== JSON.stringify(b),
                signal
            );
        },
        async changeClock(room, command, requestId, { signal } = {}) {
            const roomClock = { ...command };
            assertRoomClockCommand(roomClock);
            const metadata = await write({ roomRef: room, change: { roomClock }, requestId, signal });
            const result = readRoomClock(metadata, roomClock.name);
            if (
                result?.revision !== roomClock.expectedRevision + 1 ||
                result.status !== (roomClock.operation === 'pause' ? 'paused' : 'running')
            ) {
                throw new Error('Clock acknowledgement does not match the requested transition.');
            }
            return result;
        },
        async setDeadline(room, change, requestId, { signal } = {}) {
            const roomDeadline = { ...change };
            assertRoomDeadlineChange(roomDeadline);
            const metadata = await write({ roomRef: room, change: { roomDeadline }, requestId, signal });
            const acknowledged = readRoomDeadline(metadata, roomDeadline.name);
            if (
                acknowledged?.revision !== roomDeadline.expectedRevision + 1 ||
                acknowledged.atEpochMs !== roomDeadline.atEpochMs ||
                (roomDeadline.operation === 'start-next-occurrence' &&
                    acknowledged.startedAtRevision !== acknowledged.revision)
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
