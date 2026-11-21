import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import {
    requireEpoch,
    requireExactOptionalKeys,
    requirePositiveInteger,
    requireRecord
} from '../exact-object-decoding.ts';

export interface RoomDeadline {
    readonly name: string;
    readonly revision: number;
    /** Set after the first occurrence ends. Stable across extensions within this occurrence. */
    readonly startedAtRevision?: number;
    readonly atEpochMs: number;
}

export interface RoomDeadlineChange {
    readonly name: string;
    readonly expectedRevision: number;
    readonly operation?: 'start-next-occurrence';
    /** Supply the captured appointment epoch to extend as the room director. */
    readonly expectedDirectorEpoch?: number;
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
    requireExactOptionalKeys({
        value: change,
        required: ['name', 'expectedRevision', 'atEpochMs'],
        optional: ['expectedDirectorEpoch', 'operation'],
        label: 'Room deadline change'
    });
    if (Object.hasOwn(change, 'operation')) {
        if (change.operation !== 'start-next-occurrence' || Object.hasOwn(change, 'expectedDirectorEpoch')) {
            throw new TypeError('Starting the next occurrence requires owner or admin authority.');
        }
        requirePositiveInteger(change.expectedRevision, 'An occurrence requires an existing deadline');
    }
    if (Object.hasOwn(change, 'expectedDirectorEpoch')) {
        requirePositiveInteger(change.expectedDirectorEpoch, 'Expected director epoch');
        requirePositiveInteger(change.expectedRevision, 'A director can only extend an existing deadline');
    }
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
        requireExactOptionalKeys({
            value: deadline, required: ['name', 'revision', 'atEpochMs'], optional: ['startedAtRevision'], label: 'Room deadline'
        });
        assertRoomDeadlineName(deadline.name);
        requireEpoch(deadline.revision, 'Room deadline revision');
        assertDeadlineInstant(deadline.atEpochMs);
        if (deadline.revision === 0 || names.has(deadline.name)) {
            throw new TypeError('Room deadlines require positive revisions and unique names');
        }
        names.add(deadline.name);
        const current = { name: deadline.name, revision: deadline.revision, atEpochMs: deadline.atEpochMs };
        if (!Object.hasOwn(deadline, 'startedAtRevision')) {
            return current;
        }
        requireEpoch(deadline.startedAtRevision, 'Occurrence start revision');
        if (deadline.startedAtRevision < 2 || deadline.startedAtRevision > deadline.revision) {
            throw new TypeError('Invalid occurrence start revision');
        }
        return { ...current, startedAtRevision: deadline.startedAtRevision };
    });
}

export function readRoomDeadline(metadata: ApiJsonObject, name: string): RoomDeadline | null {
    assertRoomDeadlineName(name);
    return readRoomDeadlines(metadata).find((deadline) => deadline.name === name) ?? null;
}
