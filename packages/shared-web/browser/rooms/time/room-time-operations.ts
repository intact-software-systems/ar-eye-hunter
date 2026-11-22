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

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import {
    assertRoomClockCommand,
    assertRoomClockMutation,
    readRoomClock,
    readRoomSchedule,
    type RoomClock,
    type RoomClockCommand,
    type RoomClockMutation
} from '@shared/api/group-deadlines/room-clock.ts';
import { sameSchedulePhases, type RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import { readRoomTimeline, type RoomTimeline, type RoomTimelineAdvance, type RoomTimelineExtension } from '@shared/api/group-deadlines/room-timeline.ts';
import type { CreateBrowserRallarRoomsInput } from '../browser-rallar-rooms.ts';
import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';
import { captureRoomSession } from '../room-session-fence.ts';
import { acknowledgedProgram, acknowledgedTimeline, acknowledgedSchedule, acknowledgedClock, acknowledgedDeadline } from './room-time-acknowledgements.ts';
import { explicitRoomRef, readObservedRoom, watchRoomRevision } from '../watch-room-revision.ts';

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
    pauseProgram(room: GroupRef, control: Omit<RoomSchedule.Control, 'operation'>, requestId: string,
        options?: { readonly signal?: AbortSignal; }): Promise<RoomSchedule>;
    resumeProgram(room: GroupRef, control: Omit<RoomSchedule.Control, 'operation'>, requestId: string,
        options?: { readonly signal?: AbortSignal; }): Promise<RoomSchedule>;
    publishSchedule(room: GroupRef, publication: RoomSchedule.Publication, requestId: string,
        options?: { readonly signal?: AbortSignal; }): Promise<RoomSchedule>;
    readSchedule(room: GroupRef, name: string, options?: { readonly signal?: AbortSignal; }): Promise<RoomSchedule | null>;
    watchSchedule(room: GroupRef, name: string, listener: (state: RoomSchedule.Observation) => void,
        options?: { readonly signal?: AbortSignal; }): () => void;
    extendTimeline(
        room: GroupRef, extension: RoomTimelineExtension, requestId: string, options?: { readonly signal?: AbortSignal; }
    ): Promise<RoomTimeline>;
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

interface WriteRoomProgram extends WriteRoomTime {
    readonly change: { readonly roomClock: RoomSchedule.Control; };
}

interface WriteRoomTimeline extends WriteRoomTime {
    readonly change: { readonly roomClock: Extract<RoomClockMutation, { operation: 'advance-phase' | 'extend-phase'; }>; };
}

export function createRoomTimeOperations(
    services: Pick<
        CreateBrowserRallarRoomsInput,
        'requireSession' | 'roomEvents' | 'ws' | 'auth'
    >
): RoomTimeOperations {
    const { requireSession } = services;
    async function readMetadata(room: GroupRef, signal?: AbortSignal) {
        return (await readObservedRoom(room, requireSession, signal)).metadata;
    }
    function watch<T extends { readonly revision: number; }>(
        roomRef: GroupRef,
        name: string,
        decode: (metadata: ApiJsonObject, name: string) => T | null,
        listener: (observation: { status: 'current' | 'stale'; value: T | null; }) => void,
        regresses: (previous: T, next: T) => boolean,
        signal?: AbortSignal
    ) {
        assertRoomDeadlineName(name);
        return watchRoomRevision<T>({ room: roomRef, services, regresses, listener, signal, eventTypes: ['group-updated'],
            project: group => decode(group.metadata, name) });
    }
    async function write({ roomRef, change, requestId, signal }: WriteRoomTime) {
        const room = explicitRoomRef(roomRef);
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
    async function writeTimeline(request: WriteRoomTimeline) {
        const { roomClock } = request.change;
        assertRoomClockMutation(roomClock);
        const metadata = await write(request);
        return acknowledgedTimeline(metadata, roomClock);
    }
    async function changeProgram(request: WriteRoomProgram) {
        const { roomClock } = request.change;
        assertRoomClockMutation(roomClock);
        const metadata = await write(request);
        return acknowledgedProgram(metadata, roomClock);
    }
    return {
        pauseProgram(room, control, requestId, { signal } = {}) {
            return changeProgram({ roomRef: room, change: { roomClock: { ...control, operation: 'pause-program' } }, requestId, signal });
        },
        resumeProgram(room, control, requestId, { signal } = {}) {
            return changeProgram({ roomRef: room, change: { roomClock: { ...control, operation: 'resume-program' } }, requestId, signal });
        },
        async publishSchedule(roomRef, publication, requestId, { signal } = {}) {
            const roomClock = { ...structuredClone(publication), operation: 'publish-schedule' as const };
            assertRoomClockMutation(roomClock);
            const metadata = await write({ roomRef, change: { roomClock }, requestId, signal });
            return acknowledgedSchedule(metadata, roomClock);
        },
        async readSchedule(room, name, { signal } = {}) {
            return readRoomSchedule(await readMetadata(room, signal), name);
        },
        watchSchedule(room, name, listener, { signal } = {}) {
            return watch(room, name, readRoomSchedule, ({ status, value }) => listener({ status, schedule: value }),
                (a, b) => b.elapsedThroughEpochMs < a.elapsedThroughEpochMs ||
                    (a.revision === b.revision && (a.status !== b.status || a.elapsedThroughEpochMs !== b.elapsedThroughEpochMs ||
                        !sameSchedulePhases(a.phases, b.phases))), signal);
        },
        advanceTimeline(room, advance, requestId, { signal } = {}) {
            const roomClock = { ...advance, operation: 'advance-phase' as const };
            return writeTimeline({ roomRef: room, change: { roomClock }, requestId, signal });
        },
        extendTimeline(room, extension, requestId, { signal } = {}) {
            const roomClock = { ...extension, operation: 'extend-phase' as const };
            return writeTimeline({ roomRef: room, change: { roomClock }, requestId, signal });
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
            return acknowledgedClock(metadata, roomClock);
        },
        async setDeadline(room, change, requestId, { signal } = {}) {
            const roomDeadline = { ...change };
            assertRoomDeadlineChange(roomDeadline);
            const metadata = await write({ roomRef: room, change: { roomDeadline }, requestId, signal });
            return acknowledgedDeadline(metadata, roomDeadline);
        }
    };
}
