import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertRoomDeadlineName } from './room-deadline.ts';

import { assertSchedulePhases, type RoomSchedule } from './room-schedule.ts';
import {
    assertRoomTimelineSuccessor, readTimelineOccurrence, roomClockFitsRange, type RoomTimeline,
    type RoomTimelineAdvance, type RoomTimelineExtension, type RoomTimelineSuccessorChange
} from './room-timeline.ts';

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

export type RoomClockMutation = RoomClockCommand
    | (RoomTimelineSuccessorChange & { readonly operation: 'set-successor'; })
    | RoomSchedule.Control
    | (RoomTimelineAdvance & { readonly operation: 'advance-phase'; })
    | (RoomSchedule.Publication & { readonly operation: 'publish-schedule'; })
    | (RoomTimelineExtension & { readonly operation: 'extend-phase'; });

export function assertRoomClockMutation(value: unknown): asserts value is RoomClockMutation {
    const command = requireRecord(value, 'Room clock command');
    const keys = ['name', 'expectedRevision', 'expectedDirectorEpoch', 'operation'];
    if (command.operation === 'advance-phase') {
        keys.push('phase');
        if (Object.hasOwn(command, 'participantPrincipalIds')) {
            const ids = command.participantPrincipalIds;
            if (command.name !== 'guest-play' || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) ||
                new Set(ids).size !== ids.length) {
                throw new TypeError('Invalid guest-play participant list.');
            }
            keys.push('participantPrincipalIds');
        }
        assertRoomDeadlineName(command.phase);
        if (Object.hasOwn(command, 'successor')) {
            keys.push('successor');
            assertRoomTimelineSuccessor(command.successor);
        }
    }
    if (command.operation === 'start' || command.operation === 'advance-phase' || command.operation === 'extend-phase') {
        keys.push('durationMs');
        requirePositiveInteger(command.durationMs, 'Clock duration');
    }
    else if (command.operation === 'set-successor') {
        keys.push('successor');
        if (command.successor !== null) assertRoomTimelineSuccessor(command.successor);
    }
    else if (command.operation === 'publish-schedule') {
        keys.push('phases');
        assertSchedulePhases(command.phases);
    }
    else if (command.operation !== 'pause' && command.operation !== 'resume' &&
        command.operation !== 'pause-program' && command.operation !== 'resume-program') {
        throw new TypeError('Invalid clock operation.');
    }
    requireExactKeys(command, keys, 'Room clock command');
    assertRoomDeadlineName(command.name);
    requireEpoch(command.expectedRevision, 'Expected clock revision');
    requirePositiveInteger(command.expectedDirectorEpoch, 'Expected director epoch');
}

export function assertRoomClockCommand(value: unknown): asserts value is RoomClockCommand {
    assertRoomClockMutation(value);
    if (value.operation !== 'start' && value.operation !== 'pause' && value.operation !== 'resume') {
        throw new TypeError('Use a timeline command to change a phase.');
    }
}

export function readRoomTimeRecords(metadata: ApiJsonObject): (RoomClock | RoomTimeline | RoomSchedule)[] {
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
        if (record.status === 'scheduled' || record.status === 'program-paused') {
            requireExactKeys(record, ['name', 'revision', 'status', 'elapsedThroughEpochMs', 'phases'], 'Room schedule');
            requireEpoch(record.elapsedThroughEpochMs, 'Elapsed schedule boundary');
            assertSchedulePhases(record.phases);
            return { ...identity, status: record.status, elapsedThroughEpochMs: record.elapsedThroughEpochMs, phases: record.phases };
        }
        const occurrence = Object.hasOwn(record, 'phase') ? readTimelineOccurrence(value, record.revision) : undefined;
        const keys = ['name', 'revision', 'status', ...Object.keys(occurrence ?? {})];
        const clock = occurrence ? { ...identity, ...occurrence } : identity;
        if (record.status === 'running') {
            requireExactKeys(record, [...keys, 'endsAtEpochMs'], 'Running clock');
            requireEpoch(record.endsAtEpochMs, 'Clock end');
            if (!roomClockFitsRange(record.endsAtEpochMs, record.revision, occurrence?.successor)) {
                throw new TypeError('Invalid clock end.');
            }
            return { ...clock, status: 'running', endsAtEpochMs: record.endsAtEpochMs };
        }
        requireExactKeys(record, [...keys, 'remainingMs'], 'Paused clock');
        requireEpoch(record.remainingMs, 'Clock balance');
        if (record.status !== 'paused' || !record.remainingMs ||
            !roomClockFitsRange((occurrence?.pausedAtEpochMs ?? 0) + record.remainingMs, record.revision, occurrence?.successor)) {
            throw new TypeError('Invalid paused clock.');
        }
        return { ...clock, status: 'paused', remainingMs: record.remainingMs };
    });
}

export function readRoomClocks(metadata: ApiJsonObject): (RoomClock | RoomTimeline)[] {
    return readRoomTimeRecords(metadata).filter((record): record is RoomClock | RoomTimeline => record.status === 'running' || record.status === 'paused');
}

export function readRoomSchedule(metadata: ApiJsonObject, name: string): RoomSchedule | null {
    assertRoomDeadlineName(name);
    const record = readRoomTimeRecords(metadata).find(value => value.name === name);
    return record && 'phases' in record ? record : null;
}

export function readRoomClock(metadata: ApiJsonObject, name: string): RoomClock | RoomTimeline | null {
    assertRoomDeadlineName(name);
    return readRoomClocks(metadata).find((clock) => clock.name === name) ?? null;
}
