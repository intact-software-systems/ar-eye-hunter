import { isApiJsonObject } from '@shared/api/api-json-value.ts';
import { MAX_ROOM_CLOCKS, readRoomClocks, ROOM_CLOCKS_METADATA_KEY, type RoomClock, type RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';

import { ROOM_TIMELINES_METADATA_KEY } from '@shared/api/group-deadlines/room-timeline.ts';
import type { Group } from '@shared/api/group-types.ts';

interface ClockRefusal {
    readonly rejectionCode: 'room-clock-revision-conflict' | 'group-mutation-rejected';
    readonly message: string;
}

/** Evaluated against the same group revision and server time as director authorization. */
export function computeGroupClockChange(
    clocks: readonly RoomClock[],
    command: RoomClockMutation,
    now: number
): RoomClock | ClockRefusal {
    const previous = clocks.find((clock) => clock.name === command.name);
    if ((previous?.revision ?? 0) !== command.expectedRevision) {
        return { rejectionCode: 'room-clock-revision-conflict', message: 'Clock revision has changed.' };
    }
    const identity = { name: command.name, revision: command.expectedRevision + 1 };
    if (!Number.isSafeInteger(identity.revision) || (!previous && clocks.length >= MAX_ROOM_CLOCKS)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clock capacity exhausted.' };
    }
    let durationMs: number;
    switch (command.operation) {
        case 'start':
            if (previous && (previous.status === 'paused' || previous.endsAtEpochMs > now)) {
                return { rejectionCode: 'group-mutation-rejected', message: 'This clock is already in use.' };
            }
            durationMs = command.durationMs;
            break;
        case 'advance-phase':
            durationMs = command.durationMs;
            break;
        case 'pause':
            if (previous?.status !== 'running' || previous.endsAtEpochMs <= now) {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a live clock can pause.' };
            }
            return { ...identity, status: 'paused', remainingMs: previous.endsAtEpochMs - now };
        case 'resume':
            if (previous?.status !== 'paused') {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a paused clock can resume.' };
            }
            durationMs = previous.remainingMs;
            break;
    }
    const endsAtEpochMs = now + durationMs;
    if (endsAtEpochMs > 8_640_000_000_000_000) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clock end exceeds the supported UTC range.' };
    }
    return { ...identity, status: 'running', endsAtEpochMs };
}

/** Publish phase identity and time together in the one authoritative group write. */
export function computeGroupClockUpdate(group: Group, command: RoomClockMutation, now: number): Group | ClockRefusal {
    if (group.kind !== 'room' || group.status !== 'active') {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clocks require an active room.' };
    }
    const clocks = readRoomClocks(group.metadata);
    const clock = computeGroupClockChange(clocks, command, now);
    if ('rejectionCode' in clock) {
        return clock;
    }
    const phases = group.metadata[ROOM_TIMELINES_METADATA_KEY];
    if (phases !== undefined && !isApiJsonObject(phases)) {
        throw new TypeError('Invalid stored room timelines.');
    }
    if (command.operation === 'start' && phases && Object.hasOwn(phases, command.name)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Advance the timeline to start its next phase.' };
    }
    const metadata = {
        ...group.metadata,
        [ROOM_CLOCKS_METADATA_KEY]: [...clocks.filter(previous => previous.name !== clock.name), clock]
    };
    if (command.operation !== 'advance-phase') {
        return { ...group, metadata };
    }
    const occurrence = { phase: command.phase, startedAtRevision: clock.revision };
    return { ...group, metadata: { ...metadata, [ROOM_TIMELINES_METADATA_KEY]: { ...phases, [clock.name]: occurrence } } };
}
