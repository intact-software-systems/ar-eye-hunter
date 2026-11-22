import type { RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { sameSchedulePhases, type RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import type { ClockRefusal } from './compute-group-clock-change.ts';

export function computeGroupProgramChange(
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
