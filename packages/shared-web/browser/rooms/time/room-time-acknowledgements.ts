import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { readRoomClock, readRoomSchedule, type RoomClockCommand, type RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { readRoomDeadline, type RoomDeadlineChange } from '@shared/api/group-deadlines/room-deadline.ts';
import { sameSchedulePhases, type RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';

export function acknowledgedTimeline(metadata: ApiJsonObject, roomClock: Extract<RoomClockMutation, { operation: 'advance-phase' | 'extend-phase' | 'set-successor'; }>) {
    const timeline = readRoomTimeline(metadata, roomClock.name);
    if (!timeline || timeline.revision !== roomClock.expectedRevision + 1) {
        throw new Error('Timeline acknowledgement has an unexpected revision.');
    }
    const sameOccurrence = timeline.startedAtRevision <= roomClock.expectedRevision;
    if (roomClock.operation !== 'advance-phase' && !sameOccurrence) {
        throw new Error('Timeline acknowledgement started a new phase.');
    }
    if (roomClock.operation === 'advance-phase' && (sameOccurrence || timeline.status !== 'running' || timeline.phase !== roomClock.phase)) {
        throw new Error('Timeline acknowledgement does not match the requested phase.');
    }
    if (roomClock.operation !== 'extend-phase' &&
        (roomClock.successor?.phase !== timeline.successor?.phase || roomClock.successor?.durationMs !== timeline.successor?.durationMs)) {
        throw new Error('Timeline acknowledgement does not match the requested successor.');
    }
    return timeline;
}

export function acknowledgedSchedule(metadata: ApiJsonObject, roomClock: RoomSchedule.Publication) {
    const schedule = readRoomSchedule(metadata, roomClock.name);
    if (!schedule || schedule.revision !== roomClock.expectedRevision + 1 || !sameSchedulePhases(schedule.phases, roomClock.phases)) {
        throw new Error('Room schedule acknowledgement does not match the publication.');
    }
    return schedule;
}

export function acknowledgedProgram(metadata: ApiJsonObject, command: RoomSchedule.Control) {
    const schedule = readRoomSchedule(metadata, command.name);
    const expectedStatus = command.operation === 'pause-program' ? 'program-paused' : 'scheduled';
    if (schedule?.revision !== command.expectedRevision + 1 || schedule.status !== expectedStatus) {
        throw new Error('Program acknowledgement does not match the requested transition.');
    }
    return schedule;
}

export function acknowledgedClock(metadata: ApiJsonObject, roomClock: RoomClockCommand) {
    const result = readRoomClock(metadata, roomClock.name);
    if (
        result?.revision !== roomClock.expectedRevision + 1 ||
        result.status !== (roomClock.operation === 'pause' ? 'paused' : 'running')
    ) {
        throw new Error('Clock acknowledgement does not match the requested transition.');
    }
    return result;
}

export function acknowledgedDeadline(metadata: ApiJsonObject, roomDeadline: RoomDeadlineChange) {
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
