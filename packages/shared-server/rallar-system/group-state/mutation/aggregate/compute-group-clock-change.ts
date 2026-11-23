import {
    MAX_ROOM_CLOCKS,
    readRoomTimeRecords,
    ROOM_CLOCKS_METADATA_KEY,
    type RoomClock,
    type RoomClockMutation
} from '@shared/api/group-deadlines/room-clock.ts';
import type { RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import {
    roomClockFitsRange,
    settleRoomTimeline,
    type RoomTimeline,
    type RoomTimelineOccurrence
} from '@shared/api/group-deadlines/room-timeline.ts';
import type { Group } from '@shared/api/group-types.ts';

import { computeGroupPhaseRevision } from './compute-group-phase-revision.ts';
import { computeGroupProgramChange } from './compute-group-program-change.ts';

export interface ClockRefusal {
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
    if (
        command.operation === 'publish-schedule' || command.operation === 'pause-program' ||
        command.operation === 'resume-program'
    ) {
        if (previous && !('phases' in previous)) {
            return { rejectionCode: 'group-mutation-rejected', message: 'A manual clock already owns this name.' };
        }
        return computeGroupProgramChange(previous, command, now);
    }
    if (previous && 'phases' in previous) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Use a program command to change this name.' };
    }
    const timeline = previous && 'phase' in previous ? previous : null;
    if (timeline && settleRoomTimeline(timeline, now)) {
        return { rejectionCode: 'room-clock-revision-conflict', message: 'The scheduled successor has started.' };
    }
    let occurrence: RoomTimelineOccurrence | undefined;
    if (timeline) {
        occurrence = {
            phase: timeline.phase,
            startedAtRevision: timeline.startedAtRevision,
            ...(timeline.startedBy && { startedBy: timeline.startedBy, startedAtEpochMs: timeline.startedAtEpochMs }),
            ...(timeline.successor !== undefined && { successor: timeline.successor })
        };
    }
    let durationMs: number;
    switch (command.operation) {
        case 'start':
            if (occurrence) {
                return {
                    rejectionCode: 'group-mutation-rejected',
                    message: 'Advance the timeline to start its next phase.'
                };
            }
            if (previous && (previous.status === 'paused' || previous.endsAtEpochMs > now)) {
                return { rejectionCode: 'group-mutation-rejected', message: 'This clock is already in use.' };
            }
            durationMs = command.durationMs;
            break;
        case 'advance-phase':
            occurrence = {
                phase: command.phase,
                startedAtRevision: identity.revision,
                startedAtEpochMs: now,
                startedBy: 'director',
                successor: command.successor ?? null
            };
            durationMs = command.durationMs;
            break;
        case 'set-successor':
        case 'extend-phase':
            return computeGroupPhaseRevision(timeline, command, now);
        case 'pause':
            if (previous?.status !== 'running' || previous.endsAtEpochMs <= now) {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a live clock can pause.' };
            }
            if (!roomClockFitsRange(previous.endsAtEpochMs, identity.revision, occurrence?.successor)) {
                return { rejectionCode: 'group-mutation-rejected', message: 'The successor exceeds the clock range.' };
            }
            return {
                ...identity,
                ...occurrence,
                ...(occurrence && { pausedAtEpochMs: now }),
                status: 'paused',
                remainingMs: previous.endsAtEpochMs - now
            };
        case 'resume':
            if (previous?.status !== 'paused') {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a paused clock can resume.' };
            }
            durationMs = previous.remainingMs;
            break;
    }
    const endsAtEpochMs = now + durationMs;
    if (!roomClockFitsRange(endsAtEpochMs, identity.revision, occurrence?.successor)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clock end exceeds the supported UTC range.' };
    }
    return { ...identity, ...occurrence, status: 'running', endsAtEpochMs };
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
    return withGroupTimeRecord(group, clock, clocks);
}

export function withGroupTimeRecord(
    group: Group,
    clock: RoomClock | RoomTimeline | RoomSchedule,
    clocks = readRoomTimeRecords(group.metadata)
): Group {
    const records = [...clocks.filter((previous) => previous.name !== clock.name), clock];
    return {
        ...group,
        metadata: {
            ...group.metadata,
            [ROOM_CLOCKS_METADATA_KEY]: records.map((record) =>
                'phases' in record
                    ? {
                        ...record,
                        phases: record.phases.map(({ phase, startsAtEpochMs }) => ({ phase, startsAtEpochMs }))
                    }
                    : record
            )
        }
    };
}
