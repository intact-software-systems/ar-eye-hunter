import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertRoomDeadlineName } from './room-deadline.ts';

import type { RoomTimeline, RoomTimelineAdvance } from './room-timeline.ts';

export const ROOM_CLOCKS_METADATA_KEY = 'rallarRoomClocks';
export const MAX_ROOM_CLOCKS = 32;

export type RoomClock =
    & { readonly name: string; readonly revision: number; }
    & (
        | { readonly status: 'running'; readonly endsAtEpochMs: number; }
        | { readonly status: 'paused'; readonly remainingMs: number; }
    );

export type RoomClockCommand =
    & {
        readonly name: string;
        readonly expectedRevision: number;
        readonly expectedDirectorEpoch: number;
    }
    & (
        | { readonly operation: 'start'; readonly durationMs: number; }
        | { readonly operation: 'pause' | 'resume'; }
    );

export type RoomClockMutation = RoomClockCommand | (RoomTimelineAdvance & { readonly operation: 'advance-phase'; });

export function assertRoomClockMutation(value: unknown): asserts value is RoomClockMutation {
    const command = requireRecord(value, 'Room clock command');
    const keys = ['name', 'expectedRevision', 'expectedDirectorEpoch', 'operation'];
    if (command.operation === 'advance-phase') {
        keys.push('phase');
        assertRoomDeadlineName(command.phase);
    }
    if (command.operation === 'start' || command.operation === 'advance-phase') {
        keys.push('durationMs');
        requirePositiveInteger(command.durationMs, 'Clock duration');
    }
    else if (command.operation !== 'pause' && command.operation !== 'resume') {
        throw new TypeError('Invalid clock operation.');
    }
    requireExactKeys(command, keys, 'Room clock command');
    assertRoomDeadlineName(command.name);
    requireEpoch(command.expectedRevision, 'Expected clock revision');
    requirePositiveInteger(command.expectedDirectorEpoch, 'Expected director epoch');
}

export function assertRoomClockCommand(value: unknown): asserts value is RoomClockCommand {
    assertRoomClockMutation(value);
    if (value.operation === 'advance-phase') {
        throw new TypeError('Use advanceTimeline to start a new timeline phase.');
    }
}

export function readRoomClocks(metadata: ApiJsonObject): (RoomClock | RoomTimeline)[] {
    if (!Object.hasOwn(metadata, ROOM_CLOCKS_METADATA_KEY)) {
        return [];
    }
    const records = metadata[ROOM_CLOCKS_METADATA_KEY];
    if (!Array.isArray(records) || records.length > MAX_ROOM_CLOCKS) {
        throw new TypeError('Invalid room clocks.');
    }
    const names = new Set<string>();
    return records.map((value) => {
        const record = requireRecord(value, 'Room clock');
        assertRoomDeadlineName(record.name);
        requireEpoch(record.revision, 'Clock revision');
        if (!record.revision || names.has(record.name)) {
            throw new TypeError('Invalid room clock identity.');
        }
        names.add(record.name);
        const identity = { name: record.name, revision: record.revision };
        let occurrence: { phase: string; startedAtRevision: number; } | undefined;
        const keys = ['name', 'revision', 'status'];
        if (Object.hasOwn(record, 'phase')) {
            assertRoomDeadlineName(record.phase);
            requireEpoch(record.startedAtRevision, 'Phase starting revision');
            if (!record.startedAtRevision || record.startedAtRevision > record.revision) {
                throw new TypeError('Invalid phase starting revision.');
            }
            keys.push('phase', 'startedAtRevision');
            occurrence = { phase: record.phase, startedAtRevision: record.startedAtRevision };
        }
        const clock = occurrence ? { ...identity, ...occurrence } : identity;
        if (record.status === 'running') {
            requireExactKeys(record, [...keys, 'endsAtEpochMs'], 'Running clock');
            requireEpoch(record.endsAtEpochMs, 'Clock end');
            if (record.endsAtEpochMs > 8_640_000_000_000_000) {
                throw new TypeError('Invalid clock end.');
            }
            return { ...clock, status: 'running', endsAtEpochMs: record.endsAtEpochMs };
        }
        requireExactKeys(record, [...keys, 'remainingMs'], 'Paused clock');
        requireEpoch(record.remainingMs, 'Clock balance');
        if (record.status !== 'paused' || !record.remainingMs) {
            throw new TypeError('Invalid paused clock.');
        }
        return { ...clock, status: 'paused', remainingMs: record.remainingMs };
    });
}

export function readRoomClock(metadata: ApiJsonObject, name: string): RoomClock | RoomTimeline | null {
    assertRoomDeadlineName(name);
    return readRoomClocks(metadata).find((clock) => clock.name === name) ?? null;
}
