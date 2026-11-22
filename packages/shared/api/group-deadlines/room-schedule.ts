import { requireEpoch, requireExactKeys, requireRecord } from '../exact-object-decoding.ts';
import { assertRoomDeadlineName } from './room-deadline.ts';

export namespace RoomSchedule {
    export interface Phase {
        readonly phase: string;
        readonly startsAtEpochMs: number;
    }
    export interface Publication {
        readonly name: string;
        readonly expectedRevision: number;
        readonly expectedDirectorEpoch: number;
        readonly phases: readonly Phase[];
    }
    export interface Control extends Pick<Publication, 'name' | 'expectedRevision' | 'expectedDirectorEpoch'> {
        readonly operation: 'pause-program' | 'resume-program';
    }
    export interface Observation {
        readonly status: 'current' | 'stale';
        readonly schedule: RoomSchedule | null;
    }
    export type Position = { readonly status: 'unavailable' | 'uncertain'; }
        | { readonly status: 'paused'; readonly current: Phase | null; readonly next: Phase | null; readonly remainingMs: number | null; }
        | { readonly status: 'current'; readonly current: Phase | null; readonly next: Phase | null; };
}

export interface RoomSchedule {
    readonly name: string;
    readonly revision: number;
    readonly status: 'scheduled' | 'program-paused';
    /** Running writes preserve this elapsed prefix. While paused it is the frozen schedule cursor. */
    readonly elapsedThroughEpochMs: number;
    readonly phases: readonly RoomSchedule.Phase[];
}

export function assertSchedulePhases(value: unknown): asserts value is readonly RoomSchedule.Phase[] {
    if (!Array.isArray(value) || !value.length || value.length > 32) {
        throw new TypeError('A room schedule requires 1–32 phases.');
    }
    let previous = -1;
    for (const entry of value) {
        const phase = requireRecord(entry, 'Scheduled phase');
        requireExactKeys(phase, ['phase', 'startsAtEpochMs'], 'Scheduled phase');
        assertRoomDeadlineName(phase.phase);
        requireEpoch(phase.startsAtEpochMs, 'Phase start');
        if (phase.startsAtEpochMs <= previous || phase.startsAtEpochMs > 8_640_000_000_000_000) {
            throw new TypeError('Phase starts must be strictly increasing UTC instants.');
        }
        previous = phase.startsAtEpochMs;
    }
}

export function sameSchedulePhases(left: readonly RoomSchedule.Phase[], right: readonly RoomSchedule.Phase[]): boolean {
    return left.length === right.length && left.every((phase, i) =>
        phase.phase === right[i].phase && phase.startsAtEpochMs === right[i].startsAtEpochMs);
}


export function pausedRoomSchedulePosition(schedule: RoomSchedule): Extract<RoomSchedule.Position, { status: 'paused' }> | undefined {
    if (schedule.status !== 'program-paused') return undefined;
    let current: RoomSchedule.Phase | null = null;
    for (const phase of schedule.phases) {
        if (phase.startsAtEpochMs > schedule.elapsedThroughEpochMs) {
            return { status: 'paused', current, next: phase, remainingMs: phase.startsAtEpochMs - schedule.elapsedThroughEpochMs };
        }
        current = phase;
    }
    return { status: 'paused', current, next: null, remainingMs: null };
}
