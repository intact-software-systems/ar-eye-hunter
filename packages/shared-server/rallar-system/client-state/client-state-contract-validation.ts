import type {
    AuditStamp,
    ClientEvent,
    ClientInstance,
    ClientPrincipal,
    ClientSession
} from '@shared/api/client-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

import {
    rejectClientMutation as reject,
    requireAllowedKeys,
    requireEnum,
    requireExactKeys,
    requireJsonRecord,
    requireNonEmptyString,
    requireNullableNonEmptyString,
    requireNullableString,
    requireNullableTimestamp,
    requirePlainRecord,
    requirePositiveSafeInteger,
    requireString,
    requireStringArray,
    requireTimestamp,
    validateClientPrincipalRef
} from './client-state-validation-primitives.ts';
import {
    CLIENT_EVENT_TYPES,
    CLIENT_INSTANCE_STATUSES,
    CLIENT_PLATFORMS,
    CLIENT_PRESENCE_STATES,
    CLIENT_PRINCIPAL_STATUSES,
    CLIENT_SESSION_STATUSES,
    CLIENT_TRANSPORTS
} from './mutation/client-mutation-contracts.ts';

export function validateClientAudit(value: unknown, label: string): asserts value is AuditStamp {
    const audit = requirePlainRecord(value, label);
    requireExactKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label);
    requireTimestamp(audit.atEpochMs, `${label}.atEpochMs`);
    validateClientMutationActor(audit.actor, `${label}.actor`);
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        requireNullableString(audit[field], `${label}.${field}`);
    }
}

export function validateClientPrincipal(
    value: unknown,
    label: string
): asserts value is ClientPrincipal {
    const principal = requirePlainRecord(value, label);
    const keys = [
        'applicationId',
        'workspaceId',
        'principalId',
        'username',
        'displayName',
        'avatarUrl',
        'status',
        'authProvider',
        'externalSubjectId',
        'roles',
        'metadata',
        'snapshotVersion',
        'profileVersion',
        'presenceVersion',
        'created',
        'updated',
        'disabled',
        'deleted',
        'lastSeenAtEpochMs'
    ] as const;
    requireAllowedKeys({ value: principal, required: keys, allowed: keys, label });
    validateClientPrincipalRef(principal, label, false);
    requireNonEmptyString(principal.username, `${label}.username`);
    for (const field of ['displayName', 'avatarUrl', 'authProvider', 'externalSubjectId'] as const) {
        requireNullableString(principal[field], `${label}.${field}`);
    }
    requireEnum(principal.status, CLIENT_PRINCIPAL_STATUSES, `${label}.status`);
    requireStringArray(principal.roles, `${label}.roles`);
    requireJsonRecord(principal.metadata, `${label}.metadata`);
    for (const field of ['snapshotVersion', 'profileVersion', 'presenceVersion'] as const) {
        requirePositiveSafeInteger(principal[field], `${label}.${field}`);
    }
    validateClientAudit(principal.created, `${label}.created`);
    validateClientAudit(principal.updated, `${label}.updated`);
    if (principal.disabled !== null) {
        validateClientAudit(principal.disabled, `${label}.disabled`);
    }
    if (principal.deleted !== null) {
        validateClientAudit(principal.deleted, `${label}.deleted`);
    }
    requireNullableTimestamp(principal.lastSeenAtEpochMs, `${label}.lastSeenAtEpochMs`);
    validateClientPrincipalLifecycle(principal, label);
}

function validateClientPrincipalLifecycle(
    principal: Readonly<Record<string, unknown>>,
    label: string
): void {
    if (
        principal.status === 'active' &&
        (principal.disabled !== null || principal.deleted !== null)
    ) {
        reject(`${label} active lifecycle fields must be null`);
    }
    if (
        principal.status === 'disabled' &&
        (principal.disabled === null || principal.deleted !== null)
    ) {
        reject(`${label} disabled lifecycle fields are invalid`);
    }
    if (principal.status === 'deleted' && principal.deleted === null) {
        reject(`${label} deleted lifecycle audit is required`);
    }
}

export function validateClientInstance(
    value: unknown,
    label: string
): asserts value is ClientInstance {
    const instance = requirePlainRecord(value, label);
    const keys = [
        'applicationId',
        'workspaceId',
        'principalId',
        'clientInstanceId',
        'status',
        'platform',
        'deviceLabel',
        'appVersion',
        'userAgent',
        'capabilities',
        'registered',
        'updated',
        'revoked'
    ] as const;
    requireAllowedKeys({ value: instance, required: keys, allowed: keys, label });
    validateClientPrincipalRef(instance, label, false);
    requireNonEmptyString(instance.clientInstanceId, `${label}.clientInstanceId`);
    requireEnum(instance.status, CLIENT_INSTANCE_STATUSES, `${label}.status`);
    requireEnum(instance.platform, CLIENT_PLATFORMS, `${label}.platform`);
    for (const field of ['deviceLabel', 'appVersion', 'userAgent'] as const) {
        requireNullableString(instance[field], `${label}.${field}`);
    }
    requireStringArray(instance.capabilities, `${label}.capabilities`);
    validateClientAudit(instance.registered, `${label}.registered`);
    validateClientAudit(instance.updated, `${label}.updated`);
    if (instance.revoked !== null) {
        validateClientAudit(instance.revoked, `${label}.revoked`);
    }
    if ((instance.status === 'active') !== (instance.revoked === null)) {
        reject(`${label} revoked lifecycle field differs from status`);
    }
}

export function validateClientSession(
    value: unknown,
    label: string
): asserts value is ClientSession {
    const session = requirePlainRecord(value, label);
    const keys = [
        'applicationId',
        'workspaceId',
        'principalId',
        'clientInstanceId',
        'sessionId',
        'generationId',
        'generationVersion',
        'status',
        'presenceState',
        'transport',
        'connectionId',
        'authenticatedAtEpochMs',
        'connectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs',
        'disconnectedAtEpochMs',
        'disconnectReason'
    ] as const;
    requireAllowedKeys({ value: session, required: keys, allowed: keys, label });
    validateClientPrincipalRef(session, label, false);
    requireNonEmptyString(session.clientInstanceId, `${label}.clientInstanceId`);
    requireNonEmptyString(session.sessionId, `${label}.sessionId`);
    requireNonEmptyString(session.generationId, 'Client session generationId');
    requirePositiveSafeInteger(session.generationVersion, `${label}.generationVersion`);
    requireEnum(session.status, CLIENT_SESSION_STATUSES, `${label}.status`);
    requireEnum(session.presenceState, CLIENT_PRESENCE_STATES, `${label}.presenceState`);
    requireEnum(session.transport, CLIENT_TRANSPORTS, `${label}.transport`);
    requireNullableNonEmptyString(session.connectionId, `${label}.connectionId`);
    validateClientSessionTimestamps(session, label);
    validateClientSessionLifecycle(session, label);
}

function validateClientSessionTimestamps(
    session: Readonly<Record<string, unknown>>,
    label: string
): void {
    for (
        const field of [
            'authenticatedAtEpochMs',
            'connectedAtEpochMs',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ] as const
    ) {
        requireTimestamp(session[field], `${label}.${field}`);
    }
    requireNullableTimestamp(session.disconnectedAtEpochMs, `${label}.disconnectedAtEpochMs`);
    requireNullableNonEmptyString(session.disconnectReason, `${label}.disconnectReason`);
}

function validateClientSessionLifecycle(
    session: Readonly<Record<string, unknown>>,
    label: string
): void {
    if (
        session.status === 'active' &&
        (session.disconnectedAtEpochMs !== null || session.disconnectReason !== null)
    ) {
        reject(`${label} active disconnect fields must be null`);
    }
    if (
        session.status !== 'active' &&
        (session.disconnectedAtEpochMs === null || session.disconnectReason === null)
    ) {
        reject(`${label} terminal status requires disconnect fields`);
    }
    const authenticatedAt = session.authenticatedAtEpochMs as number;
    const connectedAt = session.connectedAtEpochMs as number;
    const heartbeatAt = session.lastHeartbeatAtEpochMs as number;
    const expiresAt = session.expiresAtEpochMs as number;
    const disconnectedAt = session.disconnectedAtEpochMs;
    if (authenticatedAt > connectedAt) {
        reject(`${label}.authenticatedAtEpochMs must not follow connectedAtEpochMs`);
    }
    if (connectedAt > heartbeatAt) {
        reject(`${label}.lastHeartbeatAtEpochMs must not predate connectedAtEpochMs`);
    }
    if (heartbeatAt > expiresAt) {
        reject(`${label}.expiresAtEpochMs must not predate lastHeartbeatAtEpochMs`);
    }
    if (disconnectedAt !== null && (disconnectedAt as number) < heartbeatAt) {
        reject(`${label}.disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs`);
    }
}

export function validateClientRuntimeStateEntry(value: unknown, label: string): void {
    const entry = requirePlainRecord(value, label);
    requireExactKeys(
        entry,
        ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
        label
    );
    requireNonEmptyString(entry.key, `${label}.key`);
    requireString(entry.value, `${label}.value`);
    requireTimestamp(entry.expireAtTimestamp, `${label}.expireAtTimestamp`);
    requireNonEmptyString(entry.updatedTimestamp, `${label}.updatedTimestamp`);
    requireTimestamp(entry.revision, `${label}.revision`);
}

export function validateClientEvent(value: unknown, label: string): asserts value is ClientEvent {
    const event = requirePlainRecord(value, label);
    requireExactKeys(
        event,
        [
            'applicationId',
            'workspaceId',
            'principalId',
            'eventId',
            'eventType',
            'snapshotVersion',
            'clientInstanceId',
            'sessionId',
            'occurredAtEpochMs',
            'actor',
            'reason',
            'traceId',
            'requestId',
            'payload'
        ],
        label
    );
    validateClientPrincipalRef(event, label, false);
    requireNonEmptyString(event.eventId, `${label}.eventId`);
    requireEnum(event.eventType, CLIENT_EVENT_TYPES, `${label}.eventType`);
    requirePositiveSafeInteger(event.snapshotVersion, `${label}.snapshotVersion`);
    requireNullableNonEmptyString(event.clientInstanceId, `${label}.clientInstanceId`);
    requireNullableNonEmptyString(event.sessionId, `${label}.sessionId`);
    requireTimestamp(event.occurredAtEpochMs, `${label}.occurredAtEpochMs`);
    validateClientMutationActor(event.actor, `${label}.actor`);
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        requireNullableString(event[field], `${label}.${field}`);
    }
    requireJsonRecord(event.payload, `${label}.payload`);
}

export function validateClientMutationActor(
    value: unknown,
    label: string
): asserts value is MutationActor {
    const actor = requirePlainRecord(value, label);
    if (actor.kind === 'principal') {
        requireExactKeys(actor, ['kind', 'principalId'], label);
        requireNonEmptyString(actor.principalId, `${label}.principalId`);
        return;
    }
    if (actor.kind === 'session') {
        requireExactKeys(actor, ['kind', 'sessionId', 'principalId'], label);
        requireNonEmptyString(actor.sessionId, `${label}.sessionId`);
        requireNonEmptyString(actor.principalId, `${label}.principalId`);
        return;
    }
    if (actor.kind === 'service') {
        requireExactKeys(actor, ['kind', 'serviceId'], label);
        requireNonEmptyString(actor.serviceId, `${label}.serviceId`);
        return;
    }
    reject(`${label}.kind is invalid`);
}
