import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import type { GroupPolicyReasonCode } from '../group-policy-types.ts';
import type { GroupRef } from '../group-types.ts';
import type { MutationActorInput } from '../state-types.ts';

/** Public room timing; account reservations belong to private server state. */
export interface GroupSessionSchedule {
    readonly revision: number;
    readonly startsAtEpochMs: number;
    readonly cancelledAtEpochMs: number | null;
}

export interface GroupSessionTiming {
    readonly phase: 'upcoming' | 'lobby' | 'start-ready' | 'reservations-expired' | 'cancelled';
    readonly lobbyOpensAtEpochMs: number;
    readonly startsAtEpochMs: number;
    readonly reservationsExpireAtEpochMs: number;
}

export const GROUP_SESSION_SCHEDULE_METADATA_KEY = 'rallarSessionSchedule';

/** Absence means unscheduled; a present incomplete or malformed schedule is corruption. */
export function readGroupSessionSchedule(metadata: ApiJsonObject): GroupSessionSchedule | null {
    if (!Object.hasOwn(metadata, GROUP_SESSION_SCHEDULE_METADATA_KEY)) {
        return null;
    }
    const schedule = metadata[GROUP_SESSION_SCHEDULE_METADATA_KEY];
    assertGroupSessionSchedule(schedule);
    return {
        revision: schedule.revision,
        startsAtEpochMs: schedule.startsAtEpochMs,
        cancelledAtEpochMs: schedule.cancelledAtEpochMs
    };
}

export function assertGroupSessionSchedule(value: unknown): asserts value is GroupSessionSchedule {
    const schedule = requireRecord(value, 'Scheduled session');
    requireExactKeys(schedule, ['revision', 'startsAtEpochMs', 'cancelledAtEpochMs'], 'Scheduled session');
    requirePositiveInteger(schedule.revision, 'Scheduled session revision');
    assertScheduleTimestamp(schedule.startsAtEpochMs);
    if (schedule.cancelledAtEpochMs !== null) {
        assertScheduleTimestamp(schedule.cancelledAtEpochMs);
    }
}

/** Uses the current attempt clock; reaching the start instant never starts gameplay automatically. */
export function toGroupSessionTiming(schedule: GroupSessionSchedule, nowEpochMs: number): GroupSessionTiming {
    assertGroupSessionSchedule(schedule);
    assertScheduleTimestamp(nowEpochMs);
    const lobbyOpensAtEpochMs = schedule.startsAtEpochMs - 600_000;
    const reservationsExpireAtEpochMs = schedule.startsAtEpochMs + 600_000;
    const phase = schedule.cancelledAtEpochMs !== null
        ? 'cancelled'
        : nowEpochMs < lobbyOpensAtEpochMs
        ? 'upcoming'
        : nowEpochMs < schedule.startsAtEpochMs
        ? 'lobby'
        : nowEpochMs < reservationsExpireAtEpochMs
        ? 'start-ready'
        : 'reservations-expired';
    return { phase, lobbyOpensAtEpochMs, startsAtEpochMs: schedule.startsAtEpochMs, reservationsExpireAtEpochMs };
}

function assertScheduleTimestamp(value: unknown): asserts value is number {
    // Keep both the instant and the reservation deadline representable as JavaScript dates.
    requireEpoch(value, 'Scheduled session timestamp');
    if (value > 8_640_000_000_000_000 - 600_000) {
        throw new TypeError('Scheduled session timestamps must be non-negative, representable integer milliseconds');
    }
}

/** One authenticated account's intent, fenced against the schedule it reviewed. */
export interface GroupSessionChange {
    readonly action: 'reserve' | 'withdraw' | 'reschedule' | 'cancel';
    readonly expectedScheduleRevision: number;
    readonly startsAtEpochMs: number | null;
}

export interface ChangeGroupSessionRequest extends MutationActorInput, GroupSessionChange {}

/** Callers own their enclosing request keys; every session intent field is mandatory. */
export function assertGroupSessionChange(value: unknown): asserts value is GroupSessionChange {
    const change = requireRecord(value, 'Session change');
    if (typeof change.action !== 'string' || !['reserve', 'withdraw', 'reschedule', 'cancel'].includes(change.action)) {
        throw new TypeError('Session change action is invalid');
    }
    requirePositiveInteger(change.expectedScheduleRevision, 'Expected schedule revision');
    if (change.action === 'reschedule') {
        assertScheduleTimestamp(change.startsAtEpochMs);
    }
    else if (change.startsAtEpochMs !== null) {
        throw new TypeError('Only rescheduling may specify a start time');
    }
}

export interface GroupSessionPreview {
    readonly roomRef: GroupRef;
    readonly displayName: string;
    readonly schedule: GroupSessionSchedule;
    readonly timing: GroupSessionTiming;
    readonly serverNowEpochMs: number;
    readonly maxPlayers: number;
    readonly availableSeats: number;
    readonly participation: 'none' | 'reserved' | 'admitted' | 'needs-confirmation';
    readonly isOrganizer: boolean;
    readonly canReserve: boolean;
    readonly canEnter: boolean;
    readonly admissionDenial: GroupPolicyReasonCode | null;
}

export interface GroupSessionPage {
    readonly sessions: readonly GroupSessionPreview[];
    readonly nextKey: string | null;
}

export interface GroupSessionStartRefusal {
    readonly code: 'session-not-started' | 'session-cancelled';
    readonly message: string;
}

/** The game leader still starts explicitly; this gate never grants leader authority. */
export function groupSessionStartRefusal(metadata: ApiJsonObject, nowEpochMs: number): GroupSessionStartRefusal | null {
    const schedule = readGroupSessionSchedule(metadata);
    if (schedule === null) {
        return null;
    }
    const timing = toGroupSessionTiming(schedule, nowEpochMs);
    if (timing.phase === 'cancelled') {
        return { code: 'session-cancelled', message: 'This scheduled session was cancelled.' };
    }
    if (timing.phase === 'upcoming' || timing.phase === 'lobby') {
        return {
            code: 'session-not-started',
            message: 'Wait until the scheduled start time before starting gameplay.'
        };
    }
    return null;
}
