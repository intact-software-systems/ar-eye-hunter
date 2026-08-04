import type {
  AuditStamp,
  ClientEvent,
  ClientInstance,
  ClientInstanceRef,
  ClientPrincipal,
  ClientPrincipalRef,
  ClientSession,
  ClientSessionRef,
} from '@shared/api/client-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

import {
  validateClientAudit as validateAudit,
  validateClientEvent,
  validateClientInstance as validateInstance,
  validateClientMutationActor as validateMutationActor,
  validateClientPrincipal as validatePrincipal,
  validateClientSession as validateSession,
} from '../client-state/client-state-contract-validation.ts';
import {
  // The retained persistence wrapper delegates to the canonical receipt validator.
  validateClientMutationIdempotencyRecordValue,
} from '../client-state/client-mutation-receipt-validation.ts';
import {
  rejectClientMutation as reject,
  requireAllowedKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from '../client-state/client-state-validation-primitives.ts';
import {
    sameClientPrincipalRef as samePrincipalRef,
} from '../client-state/client-state-semantic-equality.ts';
import type {
  // The retained persistence wrapper uses the canonical record contract.
  ClientMutationIdempotencyRecord,
} from '../client-state/mutation/client-mutation-contracts.ts';

export type {
  ClientMutationAuthority,
  ClientMutationCommand,
  ClientMutationCommandInput,
  ClientMutationComputed,
  ClientMutationComputedAppliedWrite,
  ClientMutationComputedNonPersistedNoOp,
  ClientMutationComputedPersistedNoOp,
  ClientMutationComputedWrite,
  ClientMutationFacts,
  ClientMutationIdempotencyRecord,
  ClientMutationIssuedSessionAuthority,
  ClientMutationOperation,
  ClientMutationRead,
  ClientMutationReceipt,
  ClientMutationSystemAuthority,
} from '../client-state/mutation/client-mutation-contracts.ts';
export { ClientMutationRejectedError } from '../client-state/client-state-validation-primitives.ts';
export {
  // Compatibility remains a direct named export from the canonical owner.
  validateClientMutationCommand,
} from '../client-state/mutation/command-validation/validate-client-mutation-command.ts';
export {
  // Compatibility remains a direct named export from the canonical owner.
  validateClientMutationRequest,
} from '../client-state/mutation/command-validation/validate-client-mutation-request.ts';
export {
  // Compatibility remains a direct named export from the canonical owner.
  computeClientMutation,
} from '../client-state/mutation/compute/compute-client-mutation.ts';
export {
  // Compatibility remains a direct named export from the canonical owner.
  assertNeverClientMutationComputed,
} from '../client-state/mutation/compute/compute-client-mutation-result.ts';
export {
  // Compatibility remains a direct named export from the canonical owner.
  validateClientMutationAuthorityPolicy,
} from '../client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts';
export {
  ClientMutationIdempotencyConflictError,
  validateClientMutation,
} from '../client-state/mutation/result-validation/validate-client-mutation.ts';

export function normalizePersistedClientPrincipal(
    value: unknown,
    expected: ClientPrincipalRef,
): ClientPrincipal {
    const legacy = requirePlainRecord(value, 'Stored client principal');
    requireAllowedKeys(
        legacy,
        [],
        CLIENT_PRINCIPAL_PERSISTED_KEYS,
        'Stored client principal',
    );
    const canonical = {
        applicationId: legacy.applicationId,
        workspaceId: persistedClientOrDefault(
            legacy,
            'workspaceId',
            expected.workspaceId,
        ),
        principalId: legacy.principalId,
        username: legacy.username,
        displayName: legacy.displayName ?? null,
        avatarUrl: legacy.avatarUrl ?? null,
        status: legacy.status,
        authProvider: legacy.authProvider ?? null,
        externalSubjectId: legacy.externalSubjectId ?? null,
        roles: legacy.roles,
        metadata: legacy.metadata,
        snapshotVersion: legacy.snapshotVersion,
        profileVersion: legacy.profileVersion,
        presenceVersion: legacy.presenceVersion,
        created: normalizePersistedClientAudit(legacy.created, 'Stored client principal.created'),
        updated: normalizePersistedClientAudit(legacy.updated, 'Stored client principal.updated'),
        disabled: legacy.disabled === undefined || legacy.disabled === null
            ? null
            : normalizePersistedClientAudit(
                legacy.disabled,
                'Stored client principal.disabled',
            ),
        deleted: legacy.deleted === undefined || legacy.deleted === null
            ? null
            : normalizePersistedClientAudit(
                legacy.deleted,
                'Stored client principal.deleted',
            ),
        lastSeenAtEpochMs: legacy.lastSeenAtEpochMs ?? null,
    };
    validatePersistedClientPrincipal(canonical, expected);
    return canonical;
}

export function normalizePersistedClientInstance(
    value: unknown,
    expected: ClientInstanceRef,
): ClientInstance {
    const legacy = requirePlainRecord(value, 'Stored client instance');
    requireAllowedKeys(
        legacy,
        [],
        CLIENT_INSTANCE_PERSISTED_KEYS,
        'Stored client instance',
    );
    const canonical = {
        applicationId: legacy.applicationId,
        workspaceId: persistedClientOrDefault(
            legacy,
            'workspaceId',
            expected.workspaceId,
        ),
        principalId: legacy.principalId,
        clientInstanceId: legacy.clientInstanceId,
        status: legacy.status,
        platform: legacy.platform,
        deviceLabel: legacy.deviceLabel ?? null,
        appVersion: legacy.appVersion ?? null,
        userAgent: legacy.userAgent ?? null,
        capabilities: legacy.capabilities,
        registered: normalizePersistedClientAudit(
            legacy.registered,
            'Stored client instance.registered',
        ),
        updated: normalizePersistedClientAudit(
            legacy.updated,
            'Stored client instance.updated',
        ),
        revoked: legacy.revoked === undefined || legacy.revoked === null
            ? null
            : normalizePersistedClientAudit(
                legacy.revoked,
                'Stored client instance.revoked',
            ),
    };
    validatePersistedClientInstance(canonical, expected);
    return canonical;
}

export function normalizePersistedClientSession(
    value: unknown,
    expected: ClientSessionRef,
): ClientSession {
    const legacy = requirePlainRecord(value, 'Stored client session');
    requireAllowedKeys(
        legacy,
        [],
        CLIENT_SESSION_PERSISTED_KEYS,
        'Stored client session',
    );
    const canonical = {
        applicationId: legacy.applicationId,
        workspaceId: persistedClientOrDefault(
            legacy,
            'workspaceId',
            expected.workspaceId,
        ),
        principalId: legacy.principalId,
        clientInstanceId: legacy.clientInstanceId,
        sessionId: legacy.sessionId,
        generationId: legacy.generationId,
        generationVersion: legacy.generationVersion,
        status: legacy.status,
        presenceState: legacy.presenceState,
        transport: legacy.transport,
        connectionId: legacy.connectionId ?? null,
        authenticatedAtEpochMs: legacy.authenticatedAtEpochMs,
        connectedAtEpochMs: legacy.connectedAtEpochMs,
        lastHeartbeatAtEpochMs: legacy.lastHeartbeatAtEpochMs,
        expiresAtEpochMs: legacy.expiresAtEpochMs,
        disconnectedAtEpochMs: legacy.disconnectedAtEpochMs ?? null,
        disconnectReason: legacy.disconnectReason ?? null,
    };
    validatePersistedClientSession(canonical, expected);
    return canonical;
}

export function normalizePersistedClientEvent(
    value: unknown,
    expected: ClientPrincipalRef,
): ClientEvent {
    const legacy = requirePlainRecord(value, 'Stored client event');
    requireAllowedKeys(
        legacy,
        [],
        CLIENT_EVENT_PERSISTED_KEYS,
        'Stored client event',
    );
    const canonical = {
        applicationId: legacy.applicationId,
        workspaceId: persistedClientOrDefault(
            legacy,
            'workspaceId',
            expected.workspaceId,
        ),
        principalId: legacy.principalId,
        eventId: legacy.eventId,
        eventType: legacy.eventType,
        snapshotVersion: legacy.snapshotVersion,
        clientInstanceId: legacy.clientInstanceId ?? null,
        sessionId: legacy.sessionId ?? null,
        occurredAtEpochMs: legacy.occurredAtEpochMs,
        actor: normalizePersistedMutationActor(legacy.actor, 'Stored client event.actor'),
        reason: legacy.reason ?? null,
        traceId: legacy.traceId ?? null,
        requestId: legacy.requestId ?? null,
        payload: persistedClientOrDefault(legacy, 'payload', {}),
    };
    validatePersistedClientEvent(canonical, expected);
    return canonical;
}

export function validatePersistedClientPrincipal(
    value: unknown,
    expected?: ClientPrincipalRef,
): asserts value is ClientPrincipal {
    validatePrincipal(value, 'Stored client principal');
    if (expected && !samePrincipalRef(value, expected)) {
        reject('Stored client principal identity differs from its canonical slot');
    }
}

export function validatePersistedClientInstance(
    value: unknown,
    expected?: ClientInstanceRef,
): asserts value is ClientInstance {
    validateInstance(value, 'Stored client instance');
    if (
        expected &&
        (!samePrincipalRef(value, expected) ||
            value.clientInstanceId !== expected.clientInstanceId)
    ) {
        reject('Stored client instance identity differs from its canonical slot');
    }
}

export function validatePersistedClientSession(
    value: unknown,
    expected?: ClientSessionRef,
): asserts value is ClientSession {
    validateSession(value, 'Stored client session');
    if (
        expected &&
        (!samePrincipalRef(value, expected) ||
            value.clientInstanceId !== expected.clientInstanceId ||
            value.sessionId !== expected.sessionId)
    ) {
        reject('Stored client session identity differs from its canonical slot');
    }
}

export function validatePersistedClientEvent(
    value: unknown,
    expected?: ClientPrincipalRef,
): asserts value is ClientEvent {
    validateClientEvent(value, 'Stored client event');
    if (expected && !samePrincipalRef(value, expected)) {
        reject('Stored client event identity differs from its requested aggregate');
    }
}

export function validateClientMutationIdempotencyRecord(
    value: unknown,
): asserts value is ClientMutationIdempotencyRecord {
    validateClientMutationIdempotencyRecordValue(value, 'Stored client idempotency value');
}

const CLIENT_AUDIT_PERSISTED_KEYS = [
    'atEpochMs', 'actor', 'reason', 'traceId', 'requestId',
    'byPrincipalId', 'bySessionId', 'byServiceId',
] as const;
const CLIENT_PRINCIPAL_PERSISTED_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'username', 'displayName',
    'avatarUrl', 'status', 'authProvider', 'externalSubjectId', 'roles',
    'metadata', 'snapshotVersion', 'profileVersion', 'presenceVersion',
    'created', 'updated', 'disabled', 'deleted', 'lastSeenAtEpochMs',
] as const;
const CLIENT_INSTANCE_PERSISTED_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'clientInstanceId', 'status',
    'platform', 'deviceLabel', 'appVersion', 'userAgent', 'capabilities',
    'registered', 'updated', 'revoked',
] as const;
const CLIENT_SESSION_PERSISTED_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'clientInstanceId',
    'sessionId', 'generationId', 'generationVersion', 'status', 'presenceState',
    'transport', 'connectionId', 'authenticatedAtEpochMs', 'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs', 'expiresAtEpochMs', 'disconnectedAtEpochMs',
    'disconnectReason',
] as const;
const CLIENT_EVENT_PERSISTED_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'eventId', 'eventType',
    'snapshotVersion', 'clientInstanceId', 'sessionId', 'occurredAtEpochMs',
    'actor', 'reason', 'traceId', 'requestId', 'payload',
] as const;

type PersistedClientBoundaryValue = unknown;

function normalizePersistedClientAudit(
    value: PersistedClientBoundaryValue,
    label: string,
): AuditStamp {
    const audit = requirePlainRecord(value, label);
    requireAllowedKeys(audit, [], CLIENT_AUDIT_PERSISTED_KEYS, label);
    const canonical = {
        atEpochMs: audit.atEpochMs,
        actor: audit.actor === undefined
            ? normalizePersistedMutationActor({
                principalId: audit.byPrincipalId,
                sessionId: audit.bySessionId,
                serviceId: audit.byServiceId,
            }, `${label}.actor`)
            : normalizePersistedMutationActor(audit.actor, `${label}.actor`),
        reason: audit.reason ?? null,
        traceId: audit.traceId ?? null,
        requestId: audit.requestId ?? null,
    };
    validateAudit(canonical, label);
    return canonical;
}

function persistedClientOrDefault(
    value: Readonly<Record<string, PersistedClientBoundaryValue>>,
    key: string,
    fallback: PersistedClientBoundaryValue,
): PersistedClientBoundaryValue {
    return Object.hasOwn(value, key) ? value[key] : fallback;
}

function normalizePersistedMutationActor(
    value: PersistedClientBoundaryValue,
    label: string,
): MutationActor {
    const actor = requirePlainRecord(value, label);
    if (actor.kind !== undefined) {
        validateMutationActor(actor, label);
        return actor;
    }
    requireAllowedKeys(
        actor,
        [],
        ['principalId', 'sessionId', 'serviceId'],
        label,
    );
    let canonical: MutationActor;
    if (actor.sessionId !== undefined) {
        requireNonEmptyString(actor.sessionId, `${label}.sessionId`);
        requireNonEmptyString(actor.principalId, `${label}.principalId`);
        canonical = {
            kind: 'session',
            sessionId: actor.sessionId,
            principalId: actor.principalId,
        };
    } else if (actor.principalId !== undefined) {
        requireNonEmptyString(actor.principalId, `${label}.principalId`);
        canonical = { kind: 'principal', principalId: actor.principalId };
    } else {
        requireNonEmptyString(actor.serviceId, `${label}.serviceId`);
        canonical = { kind: 'service', serviceId: actor.serviceId };
    }
    validateMutationActor(canonical, label);
    return canonical;
}
