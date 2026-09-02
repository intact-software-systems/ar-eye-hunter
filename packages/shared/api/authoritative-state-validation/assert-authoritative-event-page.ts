import {
    authoritativeStateAssertion,
    type AuthoritativeStateRecord
} from './validation-issues.ts';

export function assertAuthoritativeEventPage(
    value: unknown,
    validateEvent: (event: unknown) => void,
    label: string
): void {
    const page = decodeRecord(value, label);
    authoritativeStateAssertion.exactKeys(
        page,
        Object.hasOwn(page, 'nextCursor') ? ['events', 'nextCursor', 'hasMore'] : ['events', 'hasMore'],
        label
    );
    const events = decodeArray(page.events, `${label}.events`);
    for (const event of events) {
        validateEvent(event);
    }
    if (typeof page.hasMore !== 'boolean') {
        fail(`${label}.hasMore is invalid`);
    }
    if (Object.hasOwn(page, 'nextCursor')) {
        assertEventCursor(page.nextCursor, label);
    }
}

function assertEventCursor<Value>(value: Value, label: string): void {
    const cursorLabel = `${label}.nextCursor`;
    const cursor = decodeRecord(value, cursorLabel);
    authoritativeStateAssertion.exactKeys(
        cursor,
        ['snapshotVersion', 'occurredAtEpochMs', 'eventId'],
        cursorLabel
    );
    authoritativeStateAssertion.integer(cursor.snapshotVersion, 0, `${cursorLabel}.snapshotVersion`);
    authoritativeStateAssertion.integer(cursor.occurredAtEpochMs, 0, `${cursorLabel}.occurredAtEpochMs`);
    authoritativeStateAssertion.string(cursor.eventId, `${cursorLabel}.eventId`);
}

function decodeRecord<Value>(value: Value, label: string): AuthoritativeStateRecord {
    if (!authoritativeStateAssertion.isRecord(value)) {
        authoritativeStateAssertion.record(value, label);
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function decodeArray<Value>(value: Value, label: string): unknown[] {
    if (!Array.isArray(value)) {
        authoritativeStateAssertion.array(value, label);
        throw new TypeError(`${label} must be an array`);
    }
    return value;
}

function fail(message: string): never {
    throw new TypeError(message);
}
