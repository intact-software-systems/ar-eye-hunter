import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertRoomDeadlineName } from './room-deadline.ts';

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

export function assertRoomClockCommand(value: unknown): asserts value is RoomClockCommand {
    const command = requireRecord(value, 'Room clock command');
    const keys = ['name', 'expectedRevision', 'expectedDirectorEpoch', 'operation'];
    if (command.operation === 'start') {
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

export function readRoomClocks(metadata: ApiJsonObject): RoomClock[] {
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
        if (record.status === 'running') {
            requireExactKeys(record, ['name', 'revision', 'status', 'endsAtEpochMs'], 'Running clock');
            requireEpoch(record.endsAtEpochMs, 'Clock end');
            if (record.endsAtEpochMs > 8_640_000_000_000_000) {
                throw new TypeError('Invalid clock end.');
            }
            return { ...identity, status: 'running', endsAtEpochMs: record.endsAtEpochMs };
        }
        requireExactKeys(record, ['name', 'revision', 'status', 'remainingMs'], 'Paused clock');
        requireEpoch(record.remainingMs, 'Clock balance');
        if (record.status !== 'paused' || !record.remainingMs) {
            throw new TypeError('Invalid paused clock.');
        }
        return { ...identity, status: 'paused', remainingMs: record.remainingMs };
    });
}

export function readRoomClock(metadata: ApiJsonObject, name: string): RoomClock | null {
    assertRoomDeadlineName(name);
    return readRoomClocks(metadata).find((clock) => clock.name === name) ?? null;
}
