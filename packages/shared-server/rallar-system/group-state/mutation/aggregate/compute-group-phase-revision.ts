import type { RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { roomClockFitsRange, type RoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import type { ClockRefusal } from './compute-group-clock-change.ts';

/** An edit to a live or paused occurrence keeps its original start and appointment-independent schedule. */
export function computeGroupPhaseRevision(
    timeline: RoomTimeline | null,
    command: Extract<RoomClockMutation, { operation: 'set-successor' | 'extend-phase'; }>,
    now: number
): RoomTimeline | ClockRefusal {
    if (!timeline || (timeline.status === 'running' && timeline.endsAtEpochMs <= now)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Only a live or paused phase can be revised.' };
    }
    const revision = command.expectedRevision + 1;
    const boundary = timeline.status === 'paused' ? now + timeline.remainingMs : timeline.endsAtEpochMs;
    const extensionMs = command.operation === 'extend-phase' ? command.durationMs : 0;
    const successor = command.operation === 'set-successor' ? command.successor : timeline.successor;
    if (!roomClockFitsRange(boundary + extensionMs, revision, successor)) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: 'Revised timeline exceeds the supported UTC range.'
        };
    }
    if (command.operation === 'set-successor') {
        return { ...timeline, revision, successor };
    }
    return timeline.status === 'paused'
        ? { ...timeline, revision, remainingMs: timeline.remainingMs + extensionMs }
        : { ...timeline, revision, endsAtEpochMs: boundary + extensionMs };
}
