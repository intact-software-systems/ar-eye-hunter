import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '../exact-object-decoding.ts';

export interface RoomDeadline {
    readonly name: string;
    readonly revision: number;
    readonly atEpochMs: number;
}

export interface RoomDeadlineChange {
    readonly name: string;
    readonly expectedRevision: number;
    readonly atEpochMs: number;
}

export const ROOM_DEADLINES_METADATA_KEY = 'rallarRoomDeadlines';
export const MAX_ROOM_DEADLINES = 32;

export function assertRoomDeadlineName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.length < 1 || name.length > 64 || /[^A-Za-z0-9._-]/.test(name)) {
        throw new TypeError('Room deadline name must contain 1–64 ASCII letters, digits, dots, underscores or hyphens');
    }
}

export function assertRoomDeadlineChange(value: unknown): asserts value is RoomDeadlineChange {
    const change = requireRecord(value, 'Room deadline change');
    requireExactKeys(change, ['name', 'expectedRevision', 'atEpochMs'], 'Room deadline change');
    assertRoomDeadlineName(change.name);
    requireEpoch(change.expectedRevision, 'Room deadline expected revision');
    assertDeadlineInstant(change.atEpochMs);
}

function assertDeadlineInstant(value: unknown): asserts value is number {
    requireEpoch(value, 'Room deadline instant');
    if (value > 8_640_000_000_000_000) {
        throw new TypeError('Room deadline instant must be representable as a UTC date');
    }
}

/** An absent collection belongs to a room with no named deadlines. A malformed one fails the read. */
export function readRoomDeadlines(metadata: ApiJsonObject): readonly RoomDeadline[] {
    if (!Object.hasOwn(metadata, ROOM_DEADLINES_METADATA_KEY)) {
        return [];
    }
    const values = metadata[ROOM_DEADLINES_METADATA_KEY];
    if (!Array.isArray(values) || values.length > MAX_ROOM_DEADLINES) {
        throw new TypeError('Invalid room deadline collection');
    }
    const names = new Set<string>();
    return Array.from(values, (value: ApiJsonValue) => {
        const deadline = requireRecord(value, 'Room deadline');
        requireExactKeys(deadline, ['name', 'revision', 'atEpochMs'], 'Room deadline');
        assertRoomDeadlineName(deadline.name);
        requireEpoch(deadline.revision, 'Room deadline revision');
        assertDeadlineInstant(deadline.atEpochMs);
        if (deadline.revision === 0 || names.has(deadline.name)) {
            throw new TypeError('Room deadlines require positive revisions and unique names');
        }
        names.add(deadline.name);
        return { name: deadline.name, revision: deadline.revision, atEpochMs: deadline.atEpochMs };
    });
}

export function readRoomDeadline(metadata: ApiJsonObject, name: string): RoomDeadline | null {
    assertRoomDeadlineName(name);
    return readRoomDeadlines(metadata).find((deadline) => deadline.name === name) ?? null;
}
