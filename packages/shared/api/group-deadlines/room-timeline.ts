import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord, requireString } from '../exact-object-decoding.ts';
import { readRoomClock, type RoomClock } from './room-clock.ts';
import { assertRoomDeadlineName } from './room-deadline.ts';

export interface RoomTimelineSuccessor extends ApiJsonObject {
    readonly phase: string;
    readonly durationMs: number;
}

export interface RoomTimelineSuccessorChange {
    readonly name: string;
    readonly expectedRevision: number;
    readonly expectedDirectorEpoch: number;
    readonly successor: RoomTimelineSuccessor | null;
}

export interface RoomTimelineAdvance {
    /** Selected by the appointed director at round start and validated against the current room roster. */
    readonly participantPrincipalIds?: readonly string[];
    readonly successor?: RoomTimelineSuccessor;
    readonly name: string;
    readonly phase: string;
    readonly durationMs: number;
    readonly expectedRevision: number;
    readonly expectedDirectorEpoch: number;
}

export interface RoomTimelineExtension {
    readonly name: string;
    readonly durationMs: number;
    readonly expectedRevision: number;
    readonly expectedDirectorEpoch: number;
}

/** The clock and phase come from the same durable group revision. */
export type RoomTimeline = RoomClock & RoomTimelineOccurrence;

export interface RoomTimelineGuestParticipant extends ApiJsonObject {
    readonly principalId: string;
    readonly leaseExpiresAtEpochMs: number;
    readonly endsAtEpochMs: number;
}

export interface RoomTimelineOccurrence {
    readonly guestParticipants?: readonly RoomTimelineGuestParticipant[];
    readonly phase: string;
    readonly startedAtRevision: number;
    readonly startedAtEpochMs?: number;
    readonly startedBy?: 'director' | 'automatic';
    readonly pausedAtEpochMs?: number;
    readonly successor?: RoomTimelineSuccessor | null;
}

export function assertRoomTimelineSuccessor(value: unknown): asserts value is RoomTimelineSuccessor {
    const successor = requireRecord(value, 'Timeline successor');
    requireExactKeys(successor, ['phase', 'durationMs'], 'Timeline successor');
    assertRoomDeadlineName(successor.phase);
    requirePositiveInteger(successor.durationMs, 'Successor duration');
}

export function readTimelineOccurrence(record: ApiJsonObject, revision: number): RoomTimelineOccurrence {
    assertRoomDeadlineName(record.phase);
    requireEpoch(record.startedAtRevision, 'Phase starting revision');
    if (!record.startedAtRevision || record.startedAtRevision > revision) {
        throw new TypeError('Invalid phase starting revision.');
    }
    let occurrence: RoomTimelineOccurrence = { phase: record.phase, startedAtRevision: record.startedAtRevision };
    if (Object.hasOwn(record, 'guestParticipants')) {
        if (!Array.isArray(record.guestParticipants)) throw new TypeError('Invalid round guest participants.');
        const guestParticipants = record.guestParticipants.map(value => {
            const row = requireRecord(value, 'Round guest');
            requireExactKeys(row, ['principalId', 'leaseExpiresAtEpochMs', 'endsAtEpochMs'], 'Round guest');
            requireString(row.principalId, 'Guest principal');
            requireEpoch(row.leaseExpiresAtEpochMs, 'Guest expiry');
            requireEpoch(row.endsAtEpochMs, 'Round cutoff');
            return { principalId: row.principalId, leaseExpiresAtEpochMs: row.leaseExpiresAtEpochMs, endsAtEpochMs: row.endsAtEpochMs };
        });
        if (new Set(guestParticipants.map(entry => entry.principalId)).size !== guestParticipants.length) {
            throw new TypeError('Duplicate round guest.');
        }
        occurrence = { ...occurrence, guestParticipants };
    }
    if (Object.hasOwn(record, 'startedBy') || Object.hasOwn(record, 'startedAtEpochMs')) {
        if (record.startedBy !== 'director' && record.startedBy !== 'automatic') {
            throw new TypeError('Invalid phase origin.');
        }
        requireEpoch(record.startedAtEpochMs, 'Phase start');
        occurrence = { ...occurrence, startedBy: record.startedBy, startedAtEpochMs: record.startedAtEpochMs };
    }
    if (Object.hasOwn(record, 'successor')) {
        if (record.successor !== null) {
            assertRoomTimelineSuccessor(record.successor);
        }
        occurrence = { ...occurrence, successor: record.successor };
    }
    if (record.status === 'paused' && Object.hasOwn(record, 'pausedAtEpochMs')) {
        requireEpoch(record.pausedAtEpochMs, 'Pause time');
        occurrence = { ...occurrence, pausedAtEpochMs: record.pausedAtEpochMs };
    }
    return occurrence;
}

/** Reserve room for both the end instant and the revision that starts the successor. */
export function roomClockFitsRange(
    boundaryEpochMs: number,
    revision: number,
    successor: RoomTimelineSuccessor | null | undefined
): boolean {
    return boundaryEpochMs + (successor?.durationMs ?? 0) <= 8_640_000_000_000_000 &&
        (!successor || revision < Number.MAX_SAFE_INTEGER);
}

export function settleRoomTimeline(previous: RoomTimeline, nowEpochMs: number): RoomTimeline | null {
    if (previous.status !== 'running' || !previous.successor || previous.endsAtEpochMs > nowEpochMs) {
        return null;
    }
    const revision = previous.revision + 1;
    return {
        name: previous.name,
        status: 'running',
        phase: previous.successor.phase,
        revision,
        startedAtRevision: revision,
        startedBy: 'automatic',
        startedAtEpochMs: previous.endsAtEpochMs,
        endsAtEpochMs: previous.endsAtEpochMs + previous.successor.durationMs,
        successor: null
    };
}

export function readRoomTimeline(metadata: ApiJsonObject, name: string): RoomTimeline | null {
    const clock = readRoomClock(metadata, name);
    return clock && 'phase' in clock ? clock : null;
}
