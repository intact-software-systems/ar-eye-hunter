import { MAX_ROOM_CLOCKS, readRoomTimeRecords, ROOM_CLOCKS_METADATA_KEY, type RoomClock, type RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { sameSchedulePhases, type RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import type { RoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import type { Group } from '@shared/api/group-types.ts';

interface ClockRefusal {
    readonly rejectionCode: 'room-clock-revision-conflict' | 'group-mutation-rejected';
    readonly message: string;
}

/** Evaluated against the same group revision and server time as director authorization. */
export function computeGroupClockChange(
    clocks: readonly (RoomClock | RoomTimeline | RoomSchedule)[],
    command: RoomClockMutation,
    now: number
): RoomClock | RoomTimeline | RoomSchedule | ClockRefusal {
    const previous = clocks.find((clock) => clock.name === command.name);
    if ((previous?.revision ?? 0) !== command.expectedRevision) {
        return { rejectionCode: 'room-clock-revision-conflict', message: 'Clock revision has changed.' };
    }
    const identity = { name: command.name, revision: command.expectedRevision + 1 };
    if (!Number.isSafeInteger(identity.revision) || (!previous && clocks.length >= MAX_ROOM_CLOCKS)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clock capacity exhausted.' };
    }
    if (command.operation === 'publish-schedule' || command.operation === 'pause-program' || command.operation === 'resume-program') {
        if (previous && !('phases' in previous)) {
            return { rejectionCode: 'group-mutation-rejected', message: 'A manual clock already owns this name.' };
        }
        return changeProgram(previous, command, now);
    }
    if (previous && 'phases' in previous) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Use a program command to change this name.' };
    }
    let occurrence: Pick<RoomTimeline, 'phase' | 'startedAtRevision'> | undefined;
    if (previous && 'phase' in previous) {
        occurrence = { phase: previous.phase, startedAtRevision: previous.startedAtRevision };
    }
    let durationMs: number;
    switch (command.operation) {
        case 'start':
            if (occurrence) {
                return { rejectionCode: 'group-mutation-rejected', message: 'Advance the timeline to start its next phase.' };
            }
            if (previous && (previous.status === 'paused' || previous.endsAtEpochMs > now)) {
                return { rejectionCode: 'group-mutation-rejected', message: 'This clock is already in use.' };
            }
            durationMs = command.durationMs;
            break;
        case 'advance-phase':
            occurrence = { phase: command.phase, startedAtRevision: identity.revision };
            durationMs = command.durationMs;
            break;
        case 'extend-phase': {
            if (!previous || !('phase' in previous) || (previous.status === 'running' && previous.endsAtEpochMs <= now)) {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a live or paused phase can be extended.' };
            }
            if (previous.status === 'paused') {
                const remainingMs = previous.remainingMs + command.durationMs;
                if (now + remainingMs > 8_640_000_000_000_000) {
                    return { rejectionCode: 'group-mutation-rejected', message: 'Extended balance exceeds the supported UTC range.' };
                }
                return { ...previous, revision: identity.revision, remainingMs };
            }
            durationMs = previous.endsAtEpochMs - now + command.durationMs;
            break;
        }
        case 'pause':
            if (previous?.status !== 'running' || previous.endsAtEpochMs <= now) {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a live clock can pause.' };
            }
            return { ...identity, ...occurrence, status: 'paused', remainingMs: previous.endsAtEpochMs - now };
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
    return { ...identity, ...occurrence, status: 'running', endsAtEpochMs };
}

function changeProgram(
    previous: RoomSchedule | undefined,
    command: RoomSchedule.Control | Extract<RoomClockMutation, { operation: 'publish-schedule' }>,
    now: number
): RoomSchedule | ClockRefusal {
    const revision = command.expectedRevision + 1;
    const effectiveNow = Math.max(now, previous?.elapsedThroughEpochMs ?? now);
    if (!Number.isSafeInteger(effectiveNow) || effectiveNow > 8_640_000_000_000_000) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Program time exceeds the supported UTC range.' };
    }
    if (command.operation === 'publish-schedule') {
        const elapsedThroughEpochMs = previous?.status === 'program-paused' ? previous.elapsedThroughEpochMs : effectiveNow;
        const elapsed = (phase: RoomSchedule.Phase) => phase.startsAtEpochMs <= elapsedThroughEpochMs;
        if (previous && !sameSchedulePhases(previous.phases.filter(elapsed), command.phases.filter(elapsed))) {
            return { rejectionCode: 'group-mutation-rejected', message: 'Elapsed boundaries must be preserved.' };
        }
        return { name: command.name, revision, status: previous?.status ?? 'scheduled', elapsedThroughEpochMs, phases: command.phases };
    }
    if (command.operation === 'pause-program') {
        if (previous?.status !== 'scheduled') {
            return { rejectionCode: 'group-mutation-rejected', message: 'Only a scheduled program can pause.' };
        }
        return { ...previous, revision, status: 'program-paused', elapsedThroughEpochMs: effectiveNow };
    }
    if (previous?.status !== 'program-paused') {
        return { rejectionCode: 'group-mutation-rejected', message: 'Only a paused program can resume.' };
    }
    const pausedDurationMs = effectiveNow - previous.elapsedThroughEpochMs;
    const shifted: RoomSchedule.Phase[] = [];
    for (const phase of previous.phases) {
        if (phase.startsAtEpochMs <= previous.elapsedThroughEpochMs) {
            shifted.push(phase);
            continue;
        }
        const startsAtEpochMs = phase.startsAtEpochMs + pausedDurationMs;
        if (startsAtEpochMs > 8_640_000_000_000_000) {
            return { rejectionCode: 'group-mutation-rejected', message: 'Resumed phase exceeds the supported UTC range.' };
        }
        shifted.push({ ...phase, startsAtEpochMs });
    }
    return { ...previous, revision, status: 'scheduled', elapsedThroughEpochMs: effectiveNow, phases: shifted };
}

/** Publish phase identity and time together in the one authoritative group write. */
export function computeGroupClockUpdate(group: Group, command: RoomClockMutation, now: number): Group | ClockRefusal {
    if (group.kind !== 'room' || group.status !== 'active') {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clocks require an active room.' };
    }
    const clocks = readRoomTimeRecords(group.metadata);
    const clock = computeGroupClockChange(clocks, command, now);
    if (!('status' in clock)) {
        return clock;
    }
    const records = [...clocks.filter(previous => previous.name !== clock.name), clock];
    return { ...group, metadata: {
        ...group.metadata,
        [ROOM_CLOCKS_METADATA_KEY]: records.map(record => 'phases' in record
            ? { ...record, phases: record.phases.map(({ phase, startsAtEpochMs }) => ({ phase, startsAtEpochMs })) }
            : record)
    } };
}
