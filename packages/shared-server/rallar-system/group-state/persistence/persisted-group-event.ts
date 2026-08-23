import type { GroupEvent, GroupEventType, GroupRef } from '@shared/api/group-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

const GROUP_EVENT_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'eventId',
    'eventType',
    'snapshotVersion',
    'causalRevision',
    'occurredAtEpochMs',
    'actor',
    'reason',
    'traceId',
    'requestId',
    'payload'
] as const;

const GROUP_EVENT_TYPES: Readonly<Record<GroupEventType, true>> = {
    'group-created': true,
    'group-updated': true,
    'group-archived': true,
    'group-deleted': true,
    'member-invited': true,
    'member-admission-requested': true,
    'member-joined': true,
    'member-left': true,
    'member-removed': true,
    'member-banned': true,
    'member-unbanned': true,
    'member-role-changed': true,
    'ownership-transferred': true,
    'session-connected': true,
    'session-heartbeat': true,
    'session-disconnected': true
};

export function decodePersistedGroupEvent(value: unknown, expected: GroupRef): GroupEvent {
    validatePersistedGroupEvent(value, expected);
    return structuredClone(value);
}

export function validatePersistedGroupEvent(
    value: unknown,
    expected: GroupRef
): asserts value is GroupEvent {
    validateGroupEvent(value, expected, 'Stored group event');
}

export function validateGroupEvent(
    value: unknown,
    expected: GroupRef,
    label: string
): asserts value is GroupEvent {
    const event = requireRecord(value, label);
    requireExactKeys(event, GROUP_EVENT_KEYS, label);
    requireNonEmptyString(event.applicationId, `${label} applicationId`);
    requireNonEmptyString(event.workspaceId, `${label} workspaceId`);
    requireNonEmptyString(event.groupId, `${label} groupId`);
    if (
        event.applicationId !== expected.applicationId ||
        event.workspaceId !== expected.workspaceId ||
        event.groupId !== expected.groupId
    ) {
        throw new TypeError(`${label} scope differs from mutation group`);
    }
    requireNonEmptyString(event.eventId, `${label} eventId`);
    if (!isGroupEventType(event.eventType)) {
        throw new TypeError(`${label} eventType is invalid`);
    }
    requireNonNegativeInteger(event.snapshotVersion, `${label} snapshotVersion`);
    validateCausalRevision(event.causalRevision, `${label} causalRevision`);
    requireNonNegativeInteger(event.occurredAtEpochMs, `${label} occurredAtEpochMs`);
    validateActor(event.actor, `${label} actor`);
    requireNullableNonEmptyString(event.reason, `${label} reason`);
    requireNullableNonEmptyString(event.traceId, `${label} traceId`);
    requireNullableNonEmptyString(event.requestId, `${label} requestId`);
    requireRecord(event.payload, `${label} payload`);
}

function validateActor(value: unknown, label: string): asserts value is MutationActor {
    const actor = requireRecord(value, label);
    if (actor.kind === 'principal') {
        requireExactKeys(actor, ['kind', 'principalId'], label);
        requireNonEmptyString(actor.principalId, `${label} principalId`);
        return;
    }
    if (actor.kind === 'session') {
        requireExactKeys(actor, ['kind', 'sessionId', 'principalId'], label);
        requireNonEmptyString(actor.sessionId, `${label} sessionId`);
        requireNonEmptyString(actor.principalId, `${label} principalId`);
        return;
    }
    if (actor.kind === 'service') {
        requireExactKeys(actor, ['kind', 'serviceId'], label);
        requireNonEmptyString(actor.serviceId, `${label} serviceId`);
        return;
    }
    throw new TypeError(`${label} kind is invalid`);
}

function validateCausalRevision(value: unknown, label: string): void {
    const revision = requireRecord(value, label);
    requireExactKeys(revision, ['groupRevision', 'presenceRevision'], label);
    requireNonNegativeInteger(revision.groupRevision, `${label} groupRevision`);
    requireNonNegativeInteger(revision.presenceRevision, `${label} presenceRevision`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
    label: string
): void {
    const expectedKeys = new Set(expected);
    const unexpected = Object.keys(value).find((key) => !expectedKeys.has(key));
    if (unexpected) {
        throw new TypeError(`${label} has unexpected key: ${unexpected}`);
    }
    const missing = expected.find((key) => !Object.hasOwn(value, key));
    if (missing) {
        throw new TypeError(`${label} is missing key: ${missing}`);
    }
}

function requireNonEmptyString(value: unknown, label: string): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function requireNullableNonEmptyString(value: unknown, label: string): void {
    if (value !== null) {
        requireNonEmptyString(value, label);
    }
}

function requireNonNegativeInteger(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function isGroupEventType(value: unknown): value is GroupEventType {
    return typeof value === 'string' && Object.hasOwn(GROUP_EVENT_TYPES, value);
}
