import type {
    AuditStamp,
    ClientEvent,
    ClientInstance,
    ClientInstanceRef,
    ClientPlatform,
    ClientPresenceState,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientPrincipalStatus,
    ClientSession,
    ClientSessionRef,
    ClientSnapshot,
    ClientTransport,
} from '@shared/api/client-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import { validateAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import {
    computeClientStateSyncEntries,
    type ComputedClientStateSync,
} from '../state-sync-publisher.ts';
import type { PersistedAuthSession } from '../repositories/AuthSessionRepository.ts';

type NullableActorInput = Readonly<{
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    reason: string | null;
    traceId: string | null;
}>;

export type ClientMutationOperation =
    | 'upsertPrincipal'
    | 'upsertInstance'
    | 'connectSession'
    | 'connectAuthorisedWsSession'
    | 'heartbeatSession'
    | 'disconnectSession'
    | 'disconnectAuthorisedWsSession'
    | 'expireSession';

export type ClientMutationIssuedSessionAuthority = Readonly<{
    kind: 'issued-session';
    version: 1;
    principalId: string;
    sessionId: string;
    sessionIssuedAtEpochMs: number;
    sessionExpiresAtEpochMs: number;
    applicationId: string;
    workspaceId: string;
    operation: Exclude<ClientMutationOperation, 'expireSession'>;
}>;

export type ClientMutationSystemAuthority = Readonly<{
    kind: 'system';
    version: 1;
    serviceId: string;
    operation: 'expireSession';
}>;

export type ClientMutationAuthority =
    | ClientMutationIssuedSessionAuthority
    | ClientMutationSystemAuthority;

type ClientMutationCommandBase = Readonly<{
    aggregateRef: ClientPrincipalRef;
    commandId: string;
    requestId: string | null;
    facts: ClientMutationFacts;
    authority: ClientMutationAuthority;
}>;

export type ClientMutationCommand =
    | (ClientMutationCommandBase & Readonly<{
        operation: 'upsertPrincipal';
        input: NullableActorInput & Readonly<{
            username: string;
            displayName: string | null;
            avatarUrl: string | null;
            status: ClientPrincipalStatus | null;
            authProvider: string | null;
            externalSubjectId: string | null;
            roles: readonly string[] | null;
            metadata: Readonly<Record<string, unknown>> | null;
            lastSeenAtEpochMs: number | null;
        }>;
    }>)
    | (ClientMutationCommandBase & Readonly<{
        operation: 'upsertInstance';
        clientInstanceId: string;
        input: NullableActorInput & Readonly<{
            status: ClientInstance['status'] | null;
            platform: ClientPlatform | null;
            deviceLabel: string | null;
            appVersion: string | null;
            userAgent: string | null;
            capabilities: readonly string[] | null;
        }>;
    }>)
    | (ClientMutationCommandBase & Readonly<{
        operation: 'connectSession' | 'connectAuthorisedWsSession';
        clientInstanceId: string;
        sessionId: string;
        input: NullableActorInput & Readonly<{
            generationId: string;
            presenceState: ClientPresenceState | null;
            transport: ClientTransport | null;
            connectionId: string | null;
            authenticatedAtEpochMs: number | null;
            connectedAtEpochMs: number | null;
            lastHeartbeatAtEpochMs: number | null;
            expiresAtEpochMs: number | null;
            instancePlatform: ClientPlatform | null;
            instanceUserAgent: string | null;
            instanceCapabilities: readonly string[] | null;
            principalUsername: string | null;
            principalDisplayName: string | null;
            principalRoles: readonly string[] | null;
        }>;
    }>)
    | (ClientMutationCommandBase & Readonly<{
        operation: 'heartbeatSession';
        clientInstanceId: string;
        sessionId: string;
        input: NullableActorInput & Readonly<{
            generationId: string;
            presenceState: ClientPresenceState | null;
            lastHeartbeatAtEpochMs: number | null;
            expiresAtEpochMs: number | null;
        }>;
    }>)
    | (ClientMutationCommandBase & Readonly<{
        operation: 'disconnectSession' | 'disconnectAuthorisedWsSession';
        clientInstanceId: string;
        sessionId: string;
        input: NullableActorInput & Readonly<{
            generationId: string;
            disconnectedAtEpochMs: number | null;
            lastHeartbeatAtEpochMs: number | null;
            expiresAtEpochMs: number | null;
        }>;
    }>)
    | (ClientMutationCommandBase & Readonly<{
        operation: 'expireSession';
        clientInstanceId: string;
        sessionId: string;
        input: NullableActorInput & Readonly<{
            generationId: string;
            generationVersion: number;
            observedExpiresAtEpochMs: number;
            expiresAtEpochMs: number;
        }>;
    }>);

export type ClientMutationReceipt = Readonly<{
    commandId: string;
    requestId: string | null;
    commandHash: string;
    aggregateRef: ClientPrincipalRef;
    outcome: 'applied' | 'no-op';
    attemptCount: number;
    acceptedStorageRevision: number | null;
    stateRevision: number;
    snapshotVersion: number;
    presenceVersion: number;
    eventId: string | null;
    outboxIds: readonly string[];
}>;

export type ClientMutationIdempotencyRecord = Readonly<{
    requestId: string;
    commandHash: string;
    receipt: ClientMutationReceipt;
}>;

export type ClientMutationRead = Readonly<{
    authoritySession: PersistedAuthSession | null;
    idempotency: RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | null;
    principal: RuntimeStateEntryValue<ClientPrincipal> | null;
    instance: RuntimeStateEntryValue<ClientInstance> | null;
    session: RuntimeStateEntryValue<ClientSession> | null;
    snapshot: ClientSnapshot | null;
    receiptEvent: ClientEvent | null;
}>;

export type ClientMutationFacts = Readonly<{
    nowEpochMs: number;
    serviceId: string;
    eventId: string;
    commandHash: string;
    attemptCount: number;
    expireAtEpochMs: number;
}>;

export type ClientMutationCommandInput = ClientMutationCommand extends infer Command
    ? Command extends ClientMutationCommand
        ? Omit<Command, 'facts' | 'authority'>
        : never
    : never;

type ConditionalCandidate<T> =
    | Readonly<{ operation: 'none' }>
    | Readonly<{ operation: 'insert'; value: T }>
    | Readonly<{ operation: 'update'; value: T; expectedRevision: number }>;

export type ClientMutationComputedPersistedNoOp = Readonly<{
    outcome: 'no-op';
    persistIdempotency: true;
    aggregateRef: ClientPrincipalRef;
    idempotency: ClientMutationIdempotencyRecord;
    receipt: ClientMutationReceipt;
    snapshot: ClientSnapshot;
    event: null;
}>;

export type ClientMutationComputedNonPersistedNoOp = Readonly<{
    outcome: 'no-op';
    persistIdempotency: false;
    receipt: ClientMutationReceipt;
    snapshot: ClientSnapshot;
    event: null;
}>;

export type ClientMutationComputedAppliedWrite = Readonly<{
    outcome: 'write';
    principal: Exclude<ConditionalCandidate<ClientPrincipal>, { operation: 'none' }>;
    instance: ConditionalCandidate<ClientInstance>;
    session: ConditionalCandidate<ClientSession>;
    event: ClientEvent;
    snapshot: ClientSnapshot;
    receipt: ClientMutationReceipt;
    idempotency: ClientMutationIdempotencyRecord | null;
    stateSync: readonly ComputedClientStateSync[];
    outboxEntries: readonly ResourceEntry[];
}>;

export type ClientMutationComputedWrite =
    ClientMutationComputedAppliedWrite | ClientMutationComputedPersistedNoOp;

export type ClientMutationComputed =
    | Readonly<{
        outcome: 'replay';
        receipt: ClientMutationReceipt;
        snapshot: ClientSnapshot;
        event: ClientEvent | null;
    }>
    | ClientMutationComputedPersistedNoOp
    | ClientMutationComputedNonPersistedNoOp
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>
    | ClientMutationComputedAppliedWrite;

export class ClientMutationIdempotencyConflictError extends Error {
    readonly code = 'client-mutation-idempotency-conflict';
    readonly status = 409;

    constructor(
        readonly commandId: string,
        readonly existingCommandHash: string,
        readonly receivedCommandHash: string,
    ) {
        super(`Client mutation command differs for request ${commandId}`);
        this.name = 'ClientMutationIdempotencyConflictError';
    }
}

export class ClientMutationRejectedError extends Error {
    readonly code = 'client-mutation-rejected';
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'ClientMutationRejectedError';
    }
}

export function validateClientMutationCommand(
    command: unknown,
): asserts command is ClientMutationCommand {
    const value = requirePlainRecord(command, 'Client mutation command');
    const operation = value.operation;
    if (!CLIENT_MUTATION_OPERATIONS.has(operation as string)) {
        reject('Client mutation command operation is invalid');
    }
    requireNonEmptyString(value.commandId, 'Client mutation commandId');
    requireNullableNonEmptyString(value.requestId, 'Client mutation requestId');
    validatePrincipalRef(value.aggregateRef, 'Client mutation aggregateRef');
    validateClientMutationFacts(value.facts);
    validateClientMutationAuthority(value.authority);
    const input = requirePlainRecord(value.input, 'Client mutation input');
    validateActorInput(input);

    switch (operation) {
        case 'upsertPrincipal':
            requireExactKeys(value, COMMAND_BASE_KEYS, 'Client principal command');
            requireExactKeys(input, PRINCIPAL_INPUT_KEYS, 'Client principal input');
            requireNonEmptyString(input.username, 'Client principal username');
            requireNullableString(input.displayName, 'Client principal displayName');
            requireNullableString(input.avatarUrl, 'Client principal avatarUrl');
            requireNullableEnum(
                input.status,
                CLIENT_PRINCIPAL_STATUSES,
                'Client principal status',
            );
            requireNullableString(input.authProvider, 'Client principal authProvider');
            requireNullableString(
                input.externalSubjectId,
                'Client principal externalSubjectId',
            );
            requireNullableStringArray(input.roles, 'Client principal roles');
            requireNullableJsonRecord(input.metadata, 'Client principal metadata');
            requireNullableTimestamp(
                input.lastSeenAtEpochMs,
                'Client principal lastSeenAtEpochMs',
            );
            return;
        case 'upsertInstance':
            requireExactKeys(value, INSTANCE_COMMAND_KEYS, 'Client instance command');
            requireNonEmptyString(value.clientInstanceId, 'Client instance id');
            requireExactKeys(input, INSTANCE_INPUT_KEYS, 'Client instance input');
            requireNullableEnum(
                input.status,
                CLIENT_INSTANCE_STATUSES,
                'Client instance status',
            );
            requireNullableEnum(
                input.platform,
                CLIENT_PLATFORMS,
                'Client instance platform',
            );
            requireNullableString(input.deviceLabel, 'Client instance deviceLabel');
            requireNullableString(input.appVersion, 'Client instance appVersion');
            requireNullableString(input.userAgent, 'Client instance userAgent');
            requireNullableStringArray(
                input.capabilities,
                'Client instance capabilities',
            );
            return;
        case 'connectSession':
        case 'connectAuthorisedWsSession':
            validateSessionCommandRoot(value);
            requireExactKeys(input, CONNECT_INPUT_KEYS, 'Client connect input');
            validateGenerationId(input.generationId);
            requireNullableEnum(
                input.presenceState,
                CLIENT_PRESENCE_STATES,
                'Client connect presenceState',
            );
            requireNullableEnum(
                input.transport,
                CLIENT_TRANSPORTS,
                'Client connect transport',
            );
            requireNullableNonEmptyString(
                input.connectionId,
                'Client connect connectionId',
            );
            for (const field of CONNECT_TIMESTAMP_FIELDS) {
                requireNullableTimestamp(input[field], `Client connect ${field}`);
            }
            requireNullableEnum(
                input.instancePlatform,
                CLIENT_PLATFORMS,
                'Client connect instancePlatform',
            );
            requireNullableString(
                input.instanceUserAgent,
                'Client connect instanceUserAgent',
            );
            requireNullableStringArray(
                input.instanceCapabilities,
                'Client connect instanceCapabilities',
            );
            requireNullableNonEmptyString(
                input.principalUsername,
                'Client connect principalUsername',
            );
            requireNullableNonEmptyString(
                input.principalDisplayName,
                'Client connect principalDisplayName',
            );
            requireNullableStringArray(
                input.principalRoles,
                'Client connect principalRoles',
            );
            validateConnectTimestampOrder(input);
            return;
        case 'heartbeatSession': {
            validateSessionCommandRoot(value);
            requireExactKeys(input, HEARTBEAT_INPUT_KEYS, 'Client heartbeat input');
            validateGenerationId(input.generationId);
            requireNullableEnum(
                input.presenceState,
                CLIENT_PRESENCE_STATES,
                'Client heartbeat presenceState',
            );
            requireNullableTimestamp(
                input.lastHeartbeatAtEpochMs,
                'Client heartbeat lastHeartbeatAtEpochMs',
            );
            requireNullableTimestamp(
                input.expiresAtEpochMs,
                'Client heartbeat expiresAtEpochMs',
            );
            validateHeartbeatTimestampOrder(input);
            return;
        }
        case 'disconnectSession':
        case 'disconnectAuthorisedWsSession': {
            validateSessionCommandRoot(value);
            requireExactKeys(input, DISCONNECT_INPUT_KEYS, 'Client disconnect input');
            validateGenerationId(input.generationId);
            for (const field of DISCONNECT_TIMESTAMP_FIELDS) {
                requireNullableTimestamp(input[field], `Client disconnect ${field}`);
            }
            validateDisconnectTimestampOrder(input);
            return;
        }
        case 'expireSession':
            validateSessionCommandRoot(value);
            requireExactKeys(input, EXPIRY_INPUT_KEYS, 'Client expiry input');
            validateGenerationId(input.generationId);
            requirePositiveSafeInteger(
                input.generationVersion,
                'Client expiry generationVersion',
            );
            requireTimestamp(
                input.observedExpiresAtEpochMs,
                'Client expiry observedExpiresAtEpochMs',
            );
            requireTimestamp(input.expiresAtEpochMs, 'Client expiry expiresAtEpochMs');
            if (input.expiresAtEpochMs < input.observedExpiresAtEpochMs) {
                reject('Client expiry expiresAtEpochMs must not predate observedExpiresAtEpochMs');
            }
            return;
    }
}

export function validateClientMutationRequest(
    operation: 'upsertPrincipal',
    request: unknown,
): asserts request is UpsertClientPrincipalRequest;
export function validateClientMutationRequest(
    operation: 'upsertInstance',
    request: unknown,
): asserts request is UpsertClientInstanceRequest;
export function validateClientMutationRequest(
    operation: 'connectSession',
    request: unknown,
): asserts request is ConnectClientSessionRequest;
export function validateClientMutationRequest(
    operation: 'heartbeatSession',
    request: unknown,
): asserts request is HeartbeatClientSessionRequest;
export function validateClientMutationRequest(
    operation: 'disconnectSession',
    request: unknown,
): asserts request is DisconnectClientSessionRequest;
export function validateClientMutationRequest(
    operation:
        | 'upsertPrincipal'
        | 'upsertInstance'
        | 'connectSession'
        | 'heartbeatSession'
        | 'disconnectSession',
    request: unknown,
): void {
    const value = requirePlainRecord(request, `Client ${operation} request`);
    validateOptionalActorInput(value);
    switch (operation) {
        case 'upsertPrincipal':
            requireAllowedKeys(
                value,
                ['username'],
                RAW_PRINCIPAL_REQUEST_KEYS,
                'Client upsertPrincipal request',
            );
            requireNonEmptyString(value.username, 'Client principal username');
            requireOptionalString(value.displayName, 'Client principal displayName');
            requireOptionalString(value.avatarUrl, 'Client principal avatarUrl');
            requireOptionalEnum(
                value.status,
                CLIENT_PRINCIPAL_STATUSES,
                'Client principal status',
            );
            requireOptionalString(value.authProvider, 'Client principal authProvider');
            requireOptionalString(
                value.externalSubjectId,
                'Client principal externalSubjectId',
            );
            if (value.roles !== undefined) requireStringArray(value.roles, 'Client principal roles');
            if (value.metadata !== undefined) {
                requireJsonRecord(value.metadata, 'Client principal metadata');
            }
            requireOptionalTimestamp(
                value.lastSeenAtEpochMs,
                'Client principal lastSeenAtEpochMs',
            );
            return;
        case 'upsertInstance':
            requireAllowedKeys(
                value,
                [],
                RAW_INSTANCE_REQUEST_KEYS,
                'Client upsertInstance request',
            );
            requireOptionalEnum(
                value.status,
                CLIENT_INSTANCE_STATUSES,
                'Client instance status',
            );
            requireOptionalEnum(
                value.platform,
                CLIENT_PLATFORMS,
                'Client instance platform',
            );
            for (const field of ['deviceLabel', 'appVersion', 'userAgent'] as const) {
                requireOptionalString(value[field], `Client instance ${field}`);
            }
            if (value.capabilities !== undefined) {
                requireStringArray(value.capabilities, 'Client instance capabilities');
            }
            return;
        case 'connectSession':
            requireAllowedKeys(
                value,
                ['generationId'],
                RAW_CONNECT_REQUEST_KEYS,
                'Client connectSession request',
            );
            validateGenerationId(value.generationId);
            requireOptionalEnum(
                value.presenceState,
                CLIENT_PRESENCE_STATES,
                'Client connect presenceState',
            );
            requireOptionalEnum(
                value.transport,
                CLIENT_TRANSPORTS,
                'Client connect transport',
            );
            requireOptionalNonEmptyString(value.connectionId, 'Client connect connectionId');
            for (const field of CONNECT_TIMESTAMP_FIELDS) {
                requireOptionalTimestamp(value[field], `Client connect ${field}`);
            }
            validateConnectTimestampOrder(value);
            return;
        case 'heartbeatSession':
            requireAllowedKeys(
                value,
                ['generationId'],
                RAW_HEARTBEAT_REQUEST_KEYS,
                'Client heartbeatSession request',
            );
            validateGenerationId(value.generationId);
            requireOptionalEnum(
                value.presenceState,
                CLIENT_PRESENCE_STATES,
                'Client heartbeat presenceState',
            );
            requireOptionalTimestamp(
                value.lastHeartbeatAtEpochMs,
                'Client heartbeat lastHeartbeatAtEpochMs',
            );
            requireOptionalTimestamp(
                value.expiresAtEpochMs,
                'Client heartbeat expiresAtEpochMs',
            );
            validateHeartbeatTimestampOrder(value);
            return;
        case 'disconnectSession':
            requireAllowedKeys(
                value,
                ['generationId'],
                RAW_DISCONNECT_REQUEST_KEYS,
                'Client disconnectSession request',
            );
            validateGenerationId(value.generationId);
            for (const field of DISCONNECT_TIMESTAMP_FIELDS) {
                requireOptionalTimestamp(value[field], `Client disconnect ${field}`);
            }
            validateDisconnectTimestampOrder(value);
            return;
    }
}

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

export function computeClientMutation(input: Readonly<{
    command: ClientMutationCommand;
    read: ClientMutationRead;
}>): ClientMutationComputed {
    const { command, read } = input;
    const { facts } = command;
    validateClientMutationCommand(command);
    validateClientMutationFacts(facts);
    validateClientMutationRead(command, read);
    if (read.idempotency) {
        return read.idempotency.value.commandHash === facts.commandHash
            ? {
                outcome: 'replay',
                receipt: read.idempotency.value.receipt,
                snapshot: requireReadSnapshot(read, command),
                event: read.receiptEvent,
            }
            : {
                outcome: 'idempotency-conflict',
                existingCommandHash: read.idempotency.value.commandHash,
                receivedCommandHash: facts.commandHash,
            };
    }

    switch (command.operation) {
        case 'upsertPrincipal':
            return computePrincipal(command, read, facts);
        case 'upsertInstance':
            return computeInstance(command, read, facts);
        case 'connectSession':
        case 'connectAuthorisedWsSession':
            return computeConnect(command, read, facts);
        case 'heartbeatSession':
            return computeHeartbeat(command, read, facts);
        case 'disconnectSession':
        case 'disconnectAuthorisedWsSession':
            return computeDisconnect(command, read, facts);
        case 'expireSession':
            return computeExpiry(command, read, facts);
    }
}

export function validateClientMutation(input: Readonly<{
    command: ClientMutationCommand;
    read: ClientMutationRead;
    computed: ClientMutationComputed;
}>): void {
    const { command, read, computed } = input;
    const { facts } = command;
    validateClientMutationCommand(command);
    validateClientMutationFacts(facts);
    validateClientMutationComputed(computed);
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new ClientMutationRejectedError('Invalid canonical client command hash');
    }
    if (!command.commandId || !command.aggregateRef.applicationId ||
        !command.aggregateRef.principalId) {
        throw new ClientMutationRejectedError('Invalid client mutation identity');
    }
    if (command.requestId !== null && command.requestId !== command.commandId) {
        throw new ClientMutationRejectedError('Request id must own the command identity');
    }
    validateClientMutationRead(command, read);
    validateClientMutationAuthorityPolicy(command, read);
    if ('sessionId' in command) {
        if (!command.sessionId || !command.clientInstanceId ||
            !command.input.generationId) {
            throw new ClientMutationRejectedError('Invalid client session identity');
        }
        if (command.input.actorPrincipalId !== null &&
            command.input.actorPrincipalId !== command.aggregateRef.principalId) {
            throw new ClientMutationRejectedError('Client session actor is not authorized');
        }
        if (command.input.actorSessionId !== null &&
            command.input.actorSessionId !== command.sessionId) {
            throw new ClientMutationRejectedError('Client connection identity differs');
        }
    }
    if (computed.outcome === 'idempotency-conflict') {
        throw new ClientMutationIdempotencyConflictError(
            command.commandId,
            computed.existingCommandHash,
            computed.receivedCommandHash,
        );
    }
    if (computed.receipt.commandHash !== facts.commandHash ||
        computed.receipt.commandId !== command.commandId ||
        !Number.isSafeInteger(computed.receipt.stateRevision) ||
        computed.receipt.stateRevision < 1) {
        throw new ClientMutationRejectedError('Client mutation receipt identity differs');
    }
    if (computed.outcome !== 'write') return;
    if (computed.receipt.outcome !== 'applied' ||
        computed.event.snapshotVersion !== computed.principal.value.snapshotVersion ||
        computed.snapshot.stateRevision !== computed.receipt.stateRevision ||
        computed.snapshot.principal.snapshotVersion !== computed.receipt.snapshotVersion) {
        throw new ClientMutationRejectedError('Invalid effectful client mutation');
    }
    const expectedOutboxEntries = computed.stateSync.flatMap((stateSync) =>
        computeClientStateSyncEntries(stateSync, facts.serviceId)
    );
    if (
        JSON.stringify(expectedOutboxEntries) !== JSON.stringify(computed.outboxEntries) ||
        JSON.stringify(computed.receipt.outboxIds) !==
            JSON.stringify(expectedOutboxEntries.map((entry) => entry.key.resourceId))
    ) {
        throw new ClientMutationRejectedError('Client mutation WS outbox differs');
    }
    if (read.principal && computed.principal.operation !== 'update') {
        throw new ClientMutationRejectedError('Existing principal requires compare-and-set');
    }
    if (!read.principal && computed.principal.operation !== 'insert') {
        throw new ClientMutationRejectedError('New principal requires conditional insert');
    }
    if (computed.principal.operation === 'update' &&
        computed.principal.expectedRevision !== read.principal?.entry.revision) {
        throw new ClientMutationRejectedError('Principal compare-and-set revision differs');
    }
    if (computed.session.operation !== 'none') {
        const session = computed.session.value;
        if (!session.generationId || !Number.isSafeInteger(session.generationVersion) ||
            session.generationVersion < 1) {
            throw new ClientMutationRejectedError('Invalid client session generation');
        }
        if (computed.session.operation === 'insert' && read.session ||
            computed.session.operation === 'update' &&
                (!read.session || computed.session.expectedRevision !==
                    read.session.entry.revision)) {
            throw new ClientMutationRejectedError('Client session guard differs');
        }
        const expectedGenerationVersion = read.session
            ? read.session.value.generationId === session.generationId
                ? read.session.value.generationVersion
                : read.session.value.generationVersion + 1
            : 1;
        if (session.generationVersion !== expectedGenerationVersion) {
            throw new ClientMutationRejectedError('Client session generation is not causal');
        }
    }
    if (computed.instance.operation === 'insert' && read.instance ||
        computed.instance.operation === 'update' &&
            (!read.instance || computed.instance.expectedRevision !==
                read.instance.entry.revision)) {
        throw new ClientMutationRejectedError('Client instance guard differs');
    }
}

function validateClientMutationRead(
    command: ClientMutationCommand,
    read: ClientMutationRead,
): void {
    const root = requirePlainRecord(read, 'Client mutation read');
    requireExactKeys(
        root,
        [
            'authoritySession', 'idempotency', 'principal', 'instance', 'session',
            'snapshot', 'receiptEvent',
        ],
        'Client mutation read',
    );
    validateNullableEntryValue(read.principal, 'Client principal read', validatePrincipal);
    validateNullableEntryValue(read.instance, 'Client instance read', validateInstance);
    validateNullableEntryValue(read.session, 'Client session read', validateSession);
    validateNullableEntryValue(
        read.idempotency,
        'Client idempotency read',
        validateIdempotencyRecord,
    );
    if (read.snapshot !== null) {
        try {
            validateAuthoritativeClientSnapshot(read.snapshot, command.aggregateRef);
        } catch (error) {
            throw new ClientMutationRejectedError(
                error instanceof Error ? error.message : 'Client snapshot read is invalid',
            );
        }
    }
    if (read.receiptEvent !== null) {
        validatePersistedClientEvent(read.receiptEvent, command.aggregateRef);
    }
    if (read.principal && !samePrincipalRef(read.principal.value, command.aggregateRef)) {
        throw new ClientMutationRejectedError('Client principal read is wrongly scoped');
    }
    if (read.instance) {
        if (!('clientInstanceId' in command) ||
            !samePrincipalRef(read.instance.value, command.aggregateRef) ||
            read.instance.value.clientInstanceId !== command.clientInstanceId) {
            throw new ClientMutationRejectedError('Client instance read is wrongly scoped');
        }
    }
    if (read.session) {
        if (!('sessionId' in command) ||
            !samePrincipalRef(read.session.value, command.aggregateRef) ||
            read.session.value.clientInstanceId !== command.clientInstanceId ||
            read.session.value.sessionId !== command.sessionId ||
            !read.session.value.generationId ||
            !Number.isSafeInteger(read.session.value.generationVersion) ||
            read.session.value.generationVersion < 1) {
            throw new ClientMutationRejectedError('Client session read is invalid');
        }
    }
    if (read.idempotency) {
        if (command.requestId === null ||
            read.idempotency.value.requestId !== command.requestId ||
            !/^sha256:[0-9a-f]{64}$/.test(read.idempotency.value.commandHash) ||
            read.idempotency.value.receipt.commandHash !==
                read.idempotency.value.commandHash) {
            throw new ClientMutationRejectedError('Client idempotency read is invalid');
        }
    }
}

export function validateClientMutationAuthorityPolicy(
    command: ClientMutationCommand,
    read: ClientMutationRead,
): void {
    const authority = command.authority;
    if (authority.kind === 'system') {
        if (
            command.operation !== 'expireSession' ||
            authority.operation !== command.operation ||
            authority.serviceId !== command.facts.serviceId ||
            read.authoritySession !== null ||
            command.input.actorPrincipalId !== command.aggregateRef.principalId ||
            command.input.actorSessionId !== command.sessionId ||
            command.input.reason !== 'expired'
        ) {
            throw new ClientMutationRejectedError(
                'System authority is not permitted for this client command.',
            );
        }
        return;
    }
    const session = read.authoritySession;
    if (
        command.operation === 'expireSession' ||
        authority.operation !== command.operation ||
        authority.applicationId !== command.aggregateRef.applicationId ||
        authority.workspaceId !== command.aggregateRef.workspaceId ||
        authority.principalId !== command.aggregateRef.principalId ||
        !session ||
        session.clientId !== authority.principalId ||
        session.sessionId !== authority.sessionId ||
        session.issuedAtEpochMs !== authority.sessionIssuedAtEpochMs ||
        session.expiresAtEpochMs !== authority.sessionExpiresAtEpochMs ||
        session.expiresAtEpochMs <= command.facts.nowEpochMs
    ) {
        throw new ClientMutationRejectedError(
            'Authenticated client authority is missing, expired, revoked, or mismatched.',
        );
    }
    if (
        command.input.actorPrincipalId !== null &&
        command.input.actorPrincipalId !== session.clientId
    ) {
        throw new ClientMutationRejectedError(
            'Client mutation actor principal differs from durable authority.',
        );
    }
    if (
        command.input.actorSessionId !== null &&
        command.input.actorSessionId !== session.sessionId
    ) {
        throw new ClientMutationRejectedError(
            'Client mutation actor session differs from durable authority.',
        );
    }
    if ('sessionId' in command && command.sessionId !== session.sessionId) {
        throw new ClientMutationRejectedError(
            'Client mutation session differs from durable authority.',
        );
    }
}

function computePrincipal(
    command: Extract<ClientMutationCommand, { operation: 'upsertPrincipal' }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const existing = read.principal?.value;
    const principal = toPrincipal(command, existing, facts);
    if (existing && samePrincipalState(existing, principal)) {
        return noOpReceipt(command, read, facts);
    }
    return effectful(command, read, facts, principal, { operation: 'none' },
        { operation: 'none' }, existing ? 'principal-updated' : 'principal-created');
}

function computeInstance(
    command: Extract<ClientMutationCommand, { operation: 'upsertInstance' }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const principal = read.principal?.value ?? defaultPrincipal(command, facts);
    const existing = read.instance?.value;
    const instance = toInstance(command, existing, facts);
    if (existing && sameInstanceState(existing, instance)) {
        return noOpReceipt(command, read, facts);
    }
    const nextPrincipal = read.principal
        ? bumpPrincipal(
            principal,
            command.input,
            facts,
            command.requestId,
            'profile',
        )
        : principal;
    return effectful(
        command,
        read,
        facts,
        nextPrincipal,
        toChildCandidate(read.instance, instance),
        { operation: 'none' },
        instance.status === 'revoked'
            ? 'instance-revoked'
            : existing ? 'instance-updated' : 'instance-registered',
        command.clientInstanceId,
    );
}

function computeConnect(
    command: Extract<ClientMutationCommand, {
        operation: 'connectSession' | 'connectAuthorisedWsSession';
    }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const existing = read.session?.value;
    if (existing?.generationId === command.input.generationId) {
        return noOpReceipt(command, read, facts);
    }
    if (existing) {
        // A REST compatibility connect without an ordered generation-start fact may
        // create an absent session, but it cannot replace a distinct generation.
        if (command.input.connectedAtEpochMs === null) {
            return noOpReceipt(command, read, facts, false);
        }
        if (compareGenerationTuple(
            command.input.connectedAtEpochMs,
            command.input.generationId,
            existing.connectedAtEpochMs,
            existing.generationId,
        ) <= 0) {
            return noOpReceipt(command, read, facts, false);
        }
    }
    const principal = read.principal?.value ?? defaultPrincipal(command, facts);
    const instance = read.instance?.value ?? defaultInstance(command, principal, facts);
    const session = activeSession(command, principal, existing, facts);
    const nextPrincipal = read.principal
        ? bumpPrincipal(
            principal,
            command.input,
            facts,
            command.requestId,
            'presence',
            session.lastHeartbeatAtEpochMs,
        )
        : principal;
    return effectful(
        command,
        read,
        facts,
        nextPrincipal,
        read.instance ? { operation: 'none' } : { operation: 'insert', value: instance },
        toChildCandidate(read.session, session),
        'session-connected',
        command.clientInstanceId,
        command.sessionId,
    );
}

function compareGenerationTuple(
    leftStartedAtEpochMs: number,
    leftGenerationId: string,
    rightStartedAtEpochMs: number,
    rightGenerationId: string,
): number {
    // Starts are process-monotonic. Across servers, wall-clock time is the
    // primary order and the opaque generation id deterministically breaks ties.
    if (leftStartedAtEpochMs !== rightStartedAtEpochMs) {
        return leftStartedAtEpochMs < rightStartedAtEpochMs ? -1 : 1;
    }
    if (leftGenerationId === rightGenerationId) return 0;
    return leftGenerationId < rightGenerationId ? -1 : 1;
}

function computeHeartbeat(
    command: Extract<ClientMutationCommand, { operation: 'heartbeatSession' }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const principal = requirePrincipal(read, command);
    const existing = requireSession(read, command);
    if (existing.generationId !== command.input.generationId ||
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== null) {
        return noOpReceipt(command, read, facts, false);
    }
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (heartbeatAt < existing.lastHeartbeatAtEpochMs) {
        return noOpReceipt(command, read, facts, false);
    }
    const session: ClientSession = {
        ...existing,
        presenceState: command.input.presenceState ?? existing.presenceState,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: Math.max(
            existing.expiresAtEpochMs,
            command.input.expiresAtEpochMs ?? heartbeatAt + 24 * 60 * 60 * 1000,
        ),
    };
    if (sameSessionState(existing, session)) return noOpReceipt(command, read, facts);
    const nextPrincipal = bumpPrincipal(
        principal,
        command.input,
        facts,
        command.requestId,
        'presence',
        heartbeatAt,
    );
    return effectful(command, read, facts, nextPrincipal, { operation: 'none' },
        toChildCandidate(read.session, session), 'session-heartbeat',
        command.clientInstanceId, command.sessionId);
}

function computeDisconnect(
    command: Extract<ClientMutationCommand, {
        operation: 'disconnectSession' | 'disconnectAuthorisedWsSession';
    }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const principal = requirePrincipal(read, command);
    const existing = requireSession(read, command);
    if (existing.generationId !== command.input.generationId ||
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== null) {
        return noOpReceipt(command, read, facts, false);
    }
    const heartbeatAt = Math.max(
        existing.lastHeartbeatAtEpochMs,
        command.input.lastHeartbeatAtEpochMs ?? existing.lastHeartbeatAtEpochMs,
    );
    const disconnectedAt = Math.max(
        command.input.disconnectedAtEpochMs ?? facts.nowEpochMs,
        heartbeatAt,
    );
    const session: ClientSession = {
        ...existing,
        status: 'disconnected',
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: Math.max(
            existing.expiresAtEpochMs,
            command.input.expiresAtEpochMs ?? existing.expiresAtEpochMs,
            heartbeatAt,
        ),
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed',
    };
    const nextPrincipal = bumpPrincipal(
        principal,
        command.input,
        facts,
        command.requestId,
        'presence',
        disconnectedAt,
    );
    return effectful(command, read, facts, nextPrincipal, { operation: 'none' },
        toChildCandidate(read.session, session), 'session-disconnected',
        command.clientInstanceId, command.sessionId);
}

function computeExpiry(
    command: Extract<ClientMutationCommand, { operation: 'expireSession' }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const principal = read.principal?.value;
    const existing = read.session?.value;
    if (!principal || !existing ||
        existing.generationId !== command.input.generationId ||
        existing.generationVersion !== command.input.generationVersion ||
        existing.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs ||
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== null ||
        existing.expiresAtEpochMs > command.input.expiresAtEpochMs) {
        return noOpReceipt(command, read, facts, false);
    }
    const session: ClientSession = {
        ...existing,
        status: 'expired',
        disconnectedAtEpochMs: command.input.expiresAtEpochMs,
        disconnectReason: 'expired',
    };
    const nextPrincipal = bumpPrincipal(
        principal,
        command.input,
        facts,
        command.requestId,
        'presence',
        command.input.expiresAtEpochMs,
    );
    return effectful(command, read, facts, nextPrincipal, { operation: 'none' },
        toChildCandidate(read.session, session), 'session-expired',
        command.clientInstanceId, command.sessionId);
}

function effectful(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
    principal: ClientPrincipal,
    instance: ConditionalCandidate<ClientInstance>,
    session: ConditionalCandidate<ClientSession>,
    eventType: ClientEvent['eventType'],
    clientInstanceId?: string,
    sessionId?: string,
): ClientMutationComputed {
    const stateRevision = read.principal ? read.principal.entry.revision + 2 : 1;
    const event = toEvent(command, principal, facts, eventType, clientInstanceId, sessionId);
    const snapshot = toComputedSnapshot(read, principal, instance, session, stateRevision);
    const commonStateSync = {
        commandId: command.commandId,
        aggregateRef: command.aggregateRef,
        audience: {
            kind: 'principal' as const,
            applicationId: command.aggregateRef.applicationId,
            workspaceId: command.aggregateRef.workspaceId,
            resourceId: command.aggregateRef.principalId,
        },
        createdAtEpochMs: facts.nowEpochMs,
        expireAtEpochMs: facts.expireAtEpochMs,
    };
    const stateSync: readonly ComputedClientStateSync[] = [
        {
            ...commonStateSync,
            acceptedCausalRevision: snapshot.stateRevision,
            effects: [{
                effectKind: 'principal-state',
                payloadKind: 'snapshot',
                payload: snapshot,
            }],
        },
        {
            ...commonStateSync,
            acceptedCausalRevision: event.snapshotVersion,
            effects: [{
                effectKind: 'principal-state',
                payloadKind: 'event',
                payload: event,
            }],
        },
    ];
    const outboxEntries = stateSync.flatMap((computed) =>
        computeClientStateSyncEntries(computed, facts.serviceId)
    );
    const receipt: ClientMutationReceipt = {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: 'applied',
        attemptCount: facts.attemptCount,
        acceptedStorageRevision: read.principal
            ? read.principal.entry.revision + 1
            : 0,
        stateRevision,
        snapshotVersion: principal.snapshotVersion,
        presenceVersion: principal.presenceVersion,
        eventId: event.eventId,
        outboxIds: outboxEntries.map((entry) => entry.key.resourceId),
    };
    return {
        outcome: 'write',
        principal: read.principal
            ? { operation: 'update', value: principal, expectedRevision: read.principal.entry.revision }
            : { operation: 'insert', value: principal },
        instance,
        session,
        event,
        snapshot,
        receipt,
        idempotency: command.requestId === null ? null : {
            requestId: command.requestId,
            commandHash: facts.commandHash,
            receipt,
        },
        stateSync,
        outboxEntries,
    };
}

function noOpReceipt(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
    persistIdempotency = true,
): ClientMutationComputed {
    const principal = read.principal?.value;
    if (!principal) {
        throw new ClientMutationRejectedError(
            `Client principal not found: ${command.aggregateRef.principalId}`,
        );
    }
    const receipt = toNoOpReceipt(command, read, facts);
    const snapshot = requireReadSnapshot(read, command);
    if (persistIdempotency && command.requestId !== null) {
        return {
            outcome: 'no-op',
            persistIdempotency: true,
            aggregateRef: command.aggregateRef,
            idempotency: {
                requestId: command.requestId,
                commandHash: facts.commandHash,
                receipt,
            },
            receipt,
            snapshot,
            event: null,
        };
    }
    return {
        outcome: 'no-op',
        persistIdempotency: false,
        receipt,
        snapshot,
        event: null,
    };
}

export function assertNeverClientMutationComputed(value: never): never {
    throw new Error(`Unhandled client mutation outcome: ${JSON.stringify(value)}`);
}

function toNoOpReceipt(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationReceipt {
    const principal = read.principal?.value;
    if (!principal) {
        throw new ClientMutationRejectedError(
            `Client principal not found: ${command.aggregateRef.principalId}`,
        );
    }
    return {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: 'no-op',
        attemptCount: facts.attemptCount,
        acceptedStorageRevision: read.principal.entry.revision,
        stateRevision: read.principal.entry.revision + 1,
        snapshotVersion: principal.snapshotVersion,
        presenceVersion: principal.presenceVersion,
        eventId: null,
        outboxIds: [],
    };
}

function requireReadSnapshot(
    read: ClientMutationRead,
    command: ClientMutationCommand,
): ClientSnapshot {
    if (!read.snapshot) {
        throw new ClientMutationRejectedError(
            `Client snapshot not found: ${command.aggregateRef.principalId}`,
        );
    }
    return read.snapshot;
}

function toComputedSnapshot(
    read: ClientMutationRead,
    principal: ClientPrincipal,
    instance: ConditionalCandidate<ClientInstance>,
    session: ConditionalCandidate<ClientSession>,
    stateRevision: number,
): ClientSnapshot {
    const instances = [...(read.snapshot?.instances ?? [])];
    if (instance.operation !== 'none') {
        const index = instances.findIndex(
            (candidate) => candidate.clientInstanceId === instance.value.clientInstanceId,
        );
        if (index < 0) instances.push(instance.value);
        else instances[index] = instance.value;
    }
    const activeSessions = [...(read.snapshot?.activeSessions ?? [])];
    if (session.operation !== 'none') {
        const index = activeSessions.findIndex(
            (candidate) =>
                candidate.clientInstanceId === session.value.clientInstanceId &&
                candidate.sessionId === session.value.sessionId,
        );
        const isActive =
            session.value.status === 'active' && session.value.disconnectedAtEpochMs === null;
        if (isActive && index < 0) activeSessions.push(session.value);
        else if (isActive) activeSessions[index] = session.value;
        else if (index >= 0) activeSessions.splice(index, 1);
    }
    const lastSeenAtEpochMs = activeSessions.reduce<number | null>(
        (latest, candidate) => latest === null
            ? candidate.lastHeartbeatAtEpochMs
            : Math.max(latest, candidate.lastHeartbeatAtEpochMs),
        principal.lastSeenAtEpochMs,
    );
    return {
        stateRevision,
        principal,
        instances,
        activeSessions,
        isOnline: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastSeenAtEpochMs,
    };
}

function toPrincipal(
    command: Extract<ClientMutationCommand, { operation: 'upsertPrincipal' }>,
    existing: ClientPrincipal | undefined,
    facts: ClientMutationFacts,
): ClientPrincipal {
    const audit = toAudit(command, facts);
    const status = command.input.status ?? existing?.status ?? 'active';
    const base = {
        applicationId: command.aggregateRef.applicationId,
        workspaceId: command.aggregateRef.workspaceId,
        principalId: command.aggregateRef.principalId,
        username: command.input.username,
        displayName: command.input.displayName ?? existing?.displayName ?? null,
        avatarUrl: command.input.avatarUrl ?? existing?.avatarUrl ?? null,
        authProvider: command.input.authProvider ?? existing?.authProvider ?? null,
        externalSubjectId:
            command.input.externalSubjectId ?? existing?.externalSubjectId ?? null,
        roles: command.input.roles ?? existing?.roles ?? [],
        metadata: { ...(command.input.metadata ?? existing?.metadata ?? {}) },
        snapshotVersion: existing ? existing.snapshotVersion + 1 : 1,
        profileVersion: existing ? existing.profileVersion + 1 : 1,
        presenceVersion: existing?.presenceVersion ?? 1,
        created: existing?.created ?? audit,
        updated: audit,
        lastSeenAtEpochMs:
            command.input.lastSeenAtEpochMs ?? existing?.lastSeenAtEpochMs ?? null,
    };
    if (status === 'active') {
        return { ...base, status, disabled: null, deleted: null };
    }
    if (status === 'disabled') {
        return {
            ...base,
            status,
            disabled: existing?.disabled ?? audit,
            deleted: null,
        };
    }
    return {
        ...base,
        status,
        disabled: existing?.disabled ?? null,
        deleted: existing?.deleted ?? audit,
    };
}

function defaultPrincipal(command: ClientMutationCommand, facts: ClientMutationFacts): ClientPrincipal {
    const audit = toAudit(command, facts);
    const connectInput = command.operation === 'connectSession' ||
            command.operation === 'connectAuthorisedWsSession'
        ? command.input
        : undefined;
    const username = connectInput?.principalUsername ?? command.aggregateRef.principalId;
    return {
        ...command.aggregateRef,
        username,
        displayName: connectInput?.principalDisplayName ?? username,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        status: 'active',
        roles: connectInput?.principalRoles ?? [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
        disabled: null,
        deleted: null,
        lastSeenAtEpochMs: null,
    };
}

function toInstance(
    command: Extract<ClientMutationCommand, { operation: 'upsertInstance' }>,
    existing: ClientInstance | undefined,
    facts: ClientMutationFacts,
): ClientInstance {
    const audit = toAudit(command, facts);
    const status = command.input.status ?? existing?.status ?? 'active';
    const base = {
        ...command.aggregateRef,
        clientInstanceId: command.clientInstanceId,
        platform: command.input.platform ?? existing?.platform ?? 'unknown',
        deviceLabel: command.input.deviceLabel ?? existing?.deviceLabel ?? null,
        appVersion: command.input.appVersion ?? existing?.appVersion ?? null,
        userAgent: command.input.userAgent ?? existing?.userAgent ?? null,
        capabilities: command.input.capabilities ?? existing?.capabilities ?? [],
        registered: existing?.registered ?? audit,
        updated: audit,
    };
    if (status === 'active') return { ...base, status, revoked: null };
    return { ...base, status, revoked: existing?.revoked ?? audit };
}

function defaultInstance(
    command: Extract<ClientMutationCommand, {
        operation: 'connectSession' | 'connectAuthorisedWsSession';
    }>,
    principal: ClientPrincipal,
    facts: ClientMutationFacts,
): ClientInstance {
    const audit = toAudit(command, facts);
    return {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId: command.clientInstanceId,
        status: 'active',
        platform: command.input.instancePlatform ??
            (command.operation === 'connectAuthorisedWsSession' ? 'web' : 'unknown'),
        deviceLabel: null,
        appVersion: null,
        userAgent: command.input.instanceUserAgent,
        capabilities: command.input.instanceCapabilities ??
            (command.input.transport ? [command.input.transport] : []),
        registered: audit,
        updated: audit,
        revoked: null,
    };
}

function activeSession(
    command: Extract<ClientMutationCommand, {
        operation: 'connectSession' | 'connectAuthorisedWsSession';
    }>,
    principal: ClientPrincipal,
    existing: ClientSession | undefined,
    facts: ClientMutationFacts,
): ClientSession {
    const connectedAt = command.input.connectedAtEpochMs ?? facts.nowEpochMs;
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? connectedAt;
    return {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId: command.clientInstanceId,
        sessionId: command.sessionId,
        generationId: command.input.generationId,
        generationVersion: (existing?.generationVersion ?? 0) + 1,
        status: 'active',
        presenceState: command.input.presenceState ?? 'online',
        transport: command.input.transport ?? 'unknown',
        connectionId: command.input.connectionId,
        authenticatedAtEpochMs: command.input.authenticatedAtEpochMs ?? connectedAt,
        connectedAtEpochMs: connectedAt,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: command.input.expiresAtEpochMs ??
            heartbeatAt + 24 * 60 * 60 * 1000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
}

function bumpPrincipal(
    principal: ClientPrincipal,
    input: NullableActorInput,
    facts: ClientMutationFacts,
    requestId: string | null,
    domain: 'profile' | 'presence',
    lastSeenAtEpochMs?: number,
): ClientPrincipal {
    return {
        ...principal,
        snapshotVersion: principal.snapshotVersion + 1,
        profileVersion: principal.profileVersion + (domain === 'profile' ? 1 : 0),
        presenceVersion: principal.presenceVersion + (domain === 'presence' ? 1 : 0),
        updated: toAuditInput(input, principal, facts, requestId),
        ...(lastSeenAtEpochMs === undefined ? {} : {
            lastSeenAtEpochMs: Math.max(
                principal.lastSeenAtEpochMs ?? Number.NEGATIVE_INFINITY,
                lastSeenAtEpochMs,
            ),
        }),
    };
}

function toEvent(
    command: ClientMutationCommand,
    principal: ClientPrincipal,
    facts: ClientMutationFacts,
    eventType: ClientEvent['eventType'],
    clientInstanceId?: string,
    sessionId?: string,
): ClientEvent {
    return {
        ...command.aggregateRef,
        eventId: facts.eventId,
        eventType,
        snapshotVersion: principal.snapshotVersion,
        clientInstanceId: clientInstanceId ?? null,
        sessionId: sessionId ?? null,
        occurredAtEpochMs: facts.nowEpochMs,
        actor: toMutationActor(command.input, principal, facts),
        reason: command.input.reason,
        traceId: command.input.traceId,
        requestId: command.requestId,
        payload: {},
    };
}

function toAudit(command: ClientMutationCommand, facts: ClientMutationFacts): AuditStamp {
    return toAuditInput(command.input, command.aggregateRef, facts, command.requestId);
}

function toAuditInput(
    input: NullableActorInput,
    ref: ClientPrincipalRef,
    facts: ClientMutationFacts,
    requestId: string | null = null,
): AuditStamp {
    return {
        atEpochMs: facts.nowEpochMs,
        actor: toMutationActor(input, ref, facts),
        reason: input.reason,
        traceId: input.traceId,
        requestId,
    };
}

function toMutationActor(
    input: NullableActorInput,
    ref: ClientPrincipalRef,
    facts: ClientMutationFacts,
): MutationActor {
    if (input.actorSessionId !== null) {
        return {
            kind: 'session',
            sessionId: input.actorSessionId,
            principalId: input.actorPrincipalId ?? ref.principalId,
        };
    }
    if (input.actorPrincipalId !== null) {
        return { kind: 'principal', principalId: input.actorPrincipalId };
    }
    return { kind: 'service', serviceId: facts.serviceId };
}

function requirePrincipal(read: ClientMutationRead, command: ClientMutationCommand): ClientPrincipal {
    if (!read.principal) {
        throw new ClientMutationRejectedError(
            `Client principal not found: ${command.aggregateRef.principalId}`,
        );
    }
    return read.principal.value;
}

function requireSession(read: ClientMutationRead, command: ClientMutationCommand): ClientSession {
    if (!read.session) {
        throw new ClientMutationRejectedError(
            `Client session not found: ${'sessionId' in command ? command.sessionId : ''}`,
        );
    }
    return read.session.value;
}

function toChildCandidate<T>(
    current: RuntimeStateEntryValue<T> | null,
    value: T,
): ConditionalCandidate<T> {
    return current
        ? { operation: 'update', value, expectedRevision: current.entry.revision }
        : { operation: 'insert', value };
}

function samePrincipalState(left: ClientPrincipal, right: ClientPrincipal): boolean {
    return left.username === right.username && left.displayName === right.displayName &&
        left.avatarUrl === right.avatarUrl && left.status === right.status &&
        left.authProvider === right.authProvider &&
        left.externalSubjectId === right.externalSubjectId &&
        arrayEquals(left.roles, right.roles) && jsonEquals(left.metadata, right.metadata) &&
        left.lastSeenAtEpochMs === right.lastSeenAtEpochMs;
}

function samePrincipalRef(
    left: ClientPrincipalRef,
    right: ClientPrincipalRef,
): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.principalId === right.principalId;
}

function sameInstanceState(left: ClientInstance, right: ClientInstance): boolean {
    return left.status === right.status && left.platform === right.platform &&
        left.deviceLabel === right.deviceLabel && left.appVersion === right.appVersion &&
        left.userAgent === right.userAgent &&
        arrayEquals(left.capabilities, right.capabilities);
}

function sameSessionState(left: ClientSession, right: ClientSession): boolean {
    return left.generationId === right.generationId &&
        left.generationVersion === right.generationVersion &&
        left.status === right.status && left.presenceState === right.presenceState &&
        left.transport === right.transport && left.connectionId === right.connectionId &&
        left.authenticatedAtEpochMs === right.authenticatedAtEpochMs &&
        left.connectedAtEpochMs === right.connectedAtEpochMs &&
        left.lastHeartbeatAtEpochMs === right.lastHeartbeatAtEpochMs &&
        left.expiresAtEpochMs === right.expiresAtEpochMs &&
        left.disconnectedAtEpochMs === right.disconnectedAtEpochMs &&
        left.disconnectReason === right.disconnectReason;
}

function toOptional<K extends string, V>(
    key: K,
    requested: V | null,
    existing: V | undefined,
): Partial<Record<K, V>> {
    const value = requested ?? existing;
    return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function arrayEquals<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function jsonEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => jsonEquals(value, right[index]));
    }
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return arrayEquals(leftKeys, rightKeys) &&
        leftKeys.every((key) => jsonEquals(left[key], right[key]));
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CLIENT_MUTATION_OPERATIONS = new Set([
    'upsertPrincipal',
    'upsertInstance',
    'connectSession',
    'connectAuthorisedWsSession',
    'heartbeatSession',
    'disconnectSession',
    'disconnectAuthorisedWsSession',
    'expireSession',
]);
const CLIENT_PRINCIPAL_STATUSES = new Set(['active', 'disabled', 'deleted']);
const CLIENT_INSTANCE_STATUSES = new Set(['active', 'revoked', 'retired']);
const CLIENT_SESSION_STATUSES = new Set(['active', 'disconnected', 'expired']);
const CLIENT_PRESENCE_STATES = new Set(['online', 'offline', 'away', 'busy']);
const CLIENT_PLATFORMS = new Set([
    'web', 'ios', 'android', 'desktop', 'server', 'unknown',
]);
const CLIENT_TRANSPORTS = new Set(['ws', 'http', 'rtc', 'unknown']);
const CLIENT_EVENT_TYPES = new Set([
    'principal-created', 'principal-updated', 'principal-disabled', 'principal-deleted',
    'instance-registered', 'instance-updated', 'instance-revoked',
    'session-authenticated', 'session-connected', 'session-heartbeat',
    'session-disconnected', 'session-expired',
]);
const ACTOR_INPUT_KEYS = [
    'actorPrincipalId', 'actorSessionId', 'reason', 'traceId',
] as const;
const COMMAND_BASE_KEYS = [
    'operation', 'aggregateRef', 'commandId', 'requestId', 'authority', 'facts', 'input',
] as const;
const INSTANCE_COMMAND_KEYS = [...COMMAND_BASE_KEYS, 'clientInstanceId'] as const;
const SESSION_COMMAND_KEYS = [...INSTANCE_COMMAND_KEYS, 'sessionId'] as const;
const PRINCIPAL_INPUT_KEYS = [
    'username', 'displayName', 'avatarUrl', 'status', 'authProvider',
    'externalSubjectId', 'roles', 'metadata', 'lastSeenAtEpochMs',
    ...ACTOR_INPUT_KEYS,
] as const;
const INSTANCE_INPUT_KEYS = [
    'status', 'platform', 'deviceLabel', 'appVersion', 'userAgent', 'capabilities',
    ...ACTOR_INPUT_KEYS,
] as const;
const CONNECT_INPUT_KEYS = [
    'generationId', 'presenceState', 'transport', 'connectionId',
    'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs', 'instancePlatform', 'instanceUserAgent',
    'instanceCapabilities', 'principalUsername', 'principalDisplayName',
    'principalRoles', ...ACTOR_INPUT_KEYS,
] as const;
const HEARTBEAT_INPUT_KEYS = [
    'generationId', 'presenceState', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs',
    ...ACTOR_INPUT_KEYS,
] as const;
const DISCONNECT_INPUT_KEYS = [
    'generationId', 'disconnectedAtEpochMs', 'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs', ...ACTOR_INPUT_KEYS,
] as const;
const EXPIRY_INPUT_KEYS = [
    'generationId', 'generationVersion', 'observedExpiresAtEpochMs',
    'expiresAtEpochMs', ...ACTOR_INPUT_KEYS,
] as const;
const CONNECT_TIMESTAMP_FIELDS = [
    'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
] as const;
const DISCONNECT_TIMESTAMP_FIELDS = [
    'disconnectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs',
] as const;
const RAW_ACTOR_KEYS = [
    'actorPrincipalId', 'actorSessionId', 'reason', 'traceId', 'requestId',
] as const;
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
const RAW_PRINCIPAL_REQUEST_KEYS = [
    'username', 'displayName', 'avatarUrl', 'status', 'authProvider',
    'externalSubjectId', 'roles', 'metadata', 'lastSeenAtEpochMs', ...RAW_ACTOR_KEYS,
] as const;
const RAW_INSTANCE_REQUEST_KEYS = [
    'status', 'platform', 'deviceLabel', 'appVersion', 'userAgent', 'capabilities',
    ...RAW_ACTOR_KEYS,
] as const;
const RAW_CONNECT_REQUEST_KEYS = [
    'generationId', 'presenceState', 'transport', 'connectionId',
    'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs', ...RAW_ACTOR_KEYS,
] as const;
const RAW_HEARTBEAT_REQUEST_KEYS = [
    'generationId', 'presenceState', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs',
    ...RAW_ACTOR_KEYS,
] as const;
const RAW_DISCONNECT_REQUEST_KEYS = [
    'generationId', 'disconnectedAtEpochMs', 'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs', ...RAW_ACTOR_KEYS,
] as const;

function validateConnectTimestampOrder(
    input: Readonly<Record<string, unknown>>,
): void {
    const authenticatedAt = timestampValue(input.authenticatedAtEpochMs);
    const connectedAt = timestampValue(input.connectedAtEpochMs);
    const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
    const expiresAt = timestampValue(input.expiresAtEpochMs);
    if (authenticatedAt !== undefined && connectedAt !== undefined &&
        authenticatedAt > connectedAt) {
        reject('Client connect authenticatedAtEpochMs must not follow connectedAtEpochMs');
    }
    if (connectedAt !== undefined && heartbeatAt !== undefined &&
        connectedAt > heartbeatAt) {
        reject('Client connect lastHeartbeatAtEpochMs must not predate connectedAtEpochMs');
    }
    if (heartbeatAt !== undefined && expiresAt !== undefined && heartbeatAt > expiresAt) {
        reject('Client connect expiresAtEpochMs must not predate lastHeartbeatAtEpochMs');
    }
}

function validateHeartbeatTimestampOrder(
    input: Readonly<Record<string, unknown>>,
): void {
    const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
    const expiresAt = timestampValue(input.expiresAtEpochMs);
    if (heartbeatAt !== undefined && expiresAt !== undefined && expiresAt < heartbeatAt) {
        reject('Client heartbeat expiresAtEpochMs must not predate lastHeartbeatAtEpochMs');
    }
}

function validateDisconnectTimestampOrder(
    input: Readonly<Record<string, unknown>>,
): void {
    const disconnectedAt = timestampValue(input.disconnectedAtEpochMs);
    const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
    const expiresAt = timestampValue(input.expiresAtEpochMs);
    if (disconnectedAt !== undefined && heartbeatAt !== undefined &&
        disconnectedAt < heartbeatAt) {
        reject('Client disconnect disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs');
    }
    if (expiresAt !== undefined && heartbeatAt !== undefined && expiresAt < heartbeatAt) {
        reject('Client disconnect expiresAtEpochMs must not predate lastHeartbeatAtEpochMs');
    }
}

function timestampValue(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function reject(message: string): never {
    throw new ClientMutationRejectedError(message);
}

function requirePlainRecord(
    value: unknown,
    label: string,
): Readonly<Record<string, unknown>> {
    if (!isJsonObject(value)) reject(`${label} must be a plain object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        reject(`${label} must be a plain object`);
    }
    return value;
}

function requireExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
    label: string,
): void {
    const expected = new Set(keys);
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            reject(`${label}.${key} is required`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) reject(`${label}.${key} is not allowed`);
    }
}

function requireAllowedKeys(
    value: Readonly<Record<string, unknown>>,
    required: readonly string[],
    allowed: readonly string[],
    label: string,
): void {
    const expected = new Set(allowed);
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            reject(`${label}.${key} is required`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) reject(`${label}.${key} is not allowed`);
    }
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        reject(`${label} must be a non-empty string`);
    }
}

function requireString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string') reject(`${label} must be a string`);
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
    if (typeof value !== 'boolean') reject(`${label} must be a boolean`);
}

function requireNullableString(value: unknown, label: string): void {
    if (value !== null) requireString(value, label);
}

function requireNullableNonEmptyString(value: unknown, label: string): void {
    if (value !== null) requireNonEmptyString(value, label);
}

function requireOptionalString(value: unknown, label: string): void {
    if (value !== undefined) requireString(value, label);
}

function requireOptionalNonEmptyString(value: unknown, label: string): void {
    if (value !== undefined) requireNonEmptyString(value, label);
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
        reject(`${label} must be a finite safe nonnegative integer`);
    }
}

function requireNullableTimestamp(
    value: unknown,
    label: string,
): asserts value is number | null {
    if (value !== null) requireTimestamp(value, label);
}

function requireOptionalTimestamp(value: unknown, label: string): void {
    if (value !== undefined) requireTimestamp(value, label);
}

function requirePositiveSafeInteger(
    value: unknown,
    label: string,
): asserts value is number {
    requireTimestamp(value, label);
    if ((value as number) < 1) reject(`${label} must be at least 1`);
}

function requireEnum(value: unknown, allowed: ReadonlySet<string>, label: string): void {
    if (typeof value !== 'string' || !allowed.has(value)) {
        reject(`${label} has an invalid value`);
    }
}

function requireNullableEnum(
    value: unknown,
    allowed: ReadonlySet<string>,
    label: string,
): void {
    if (value !== null) requireEnum(value, allowed, label);
}

function requireOptionalEnum(
    value: unknown,
    allowed: ReadonlySet<string>,
    label: string,
): void {
    if (value !== undefined) requireEnum(value, allowed, label);
}

function requireStringArray(
    value: unknown,
    label: string,
): asserts value is readonly string[] {
    if (!Array.isArray(value)) reject(`${label} must be an array`);
    value.forEach((item, index) =>
        requireNonEmptyString(item, `${label}[${index}]`)
    );
}

function requireNullableStringArray(value: unknown, label: string): void {
    if (value !== null) requireStringArray(value, label);
}

function requireJsonValue(value: unknown, label: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            reject(`${label} contains a non-JSON number`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => requireJsonValue(item, `${label}[${index}]`));
        return;
    }
    const record = requirePlainRecord(value, label);
    for (const [key, item] of Object.entries(record)) {
        requireJsonValue(item, `${label}.${key}`);
    }
}

function requireJsonRecord(value: unknown, label: string): void {
    requirePlainRecord(value, label);
    requireJsonValue(value, label);
}

function requireNullableJsonRecord(value: unknown, label: string): void {
    if (value !== null) requireJsonRecord(value, label);
}

function validateGenerationId(value: unknown): void {
    requireNonEmptyString(value, 'Client session generationId');
}

function validateActorInput(input: Readonly<Record<string, unknown>>): void {
    requireNullableNonEmptyString(
        input.actorPrincipalId,
        'Client mutation actorPrincipalId',
    );
    requireNullableNonEmptyString(input.actorSessionId, 'Client mutation actorSessionId');
    requireNullableString(input.reason, 'Client mutation reason');
    requireNullableString(input.traceId, 'Client mutation traceId');
}

function validateOptionalActorInput(input: Readonly<Record<string, unknown>>): void {
    requireOptionalNonEmptyString(
        input.actorPrincipalId,
        'Client request actorPrincipalId',
    );
    requireOptionalNonEmptyString(input.actorSessionId, 'Client request actorSessionId');
    requireOptionalString(input.reason, 'Client request reason');
    requireOptionalString(input.traceId, 'Client request traceId');
    requireOptionalNonEmptyString(input.requestId, 'Client request requestId');
}

function validateSessionCommandRoot(value: Readonly<Record<string, unknown>>): void {
    requireExactKeys(value, SESSION_COMMAND_KEYS, 'Client session command');
    requireNonEmptyString(value.clientInstanceId, 'Client session clientInstanceId');
    requireNonEmptyString(value.sessionId, 'Client session sessionId');
}

function validatePrincipalRef(
    value: unknown,
    label: string,
    exact = true,
): ClientPrincipalRef {
    const ref = requirePlainRecord(value, label);
    if (exact) {
        requireExactKeys(ref, ['applicationId', 'workspaceId', 'principalId'], label);
    }
    requireNonEmptyString(ref.applicationId, `${label}.applicationId`);
    requireNonEmptyString(ref.workspaceId, `${label}.workspaceId`);
    requireNonEmptyString(ref.principalId, `${label}.principalId`);
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        principalId: ref.principalId,
    };
}

function normalizePersistedClientAudit(value: unknown, label: string): AuditStamp {
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
    value: Readonly<Record<string, unknown>>,
    key: string,
    fallback: unknown,
): unknown {
    return Object.hasOwn(value, key) ? value[key] : fallback;
}

function normalizePersistedMutationActor(
    value: unknown,
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

function validateAudit(value: unknown, label: string): asserts value is AuditStamp {
    const audit = requirePlainRecord(value, label);
    requireExactKeys(
        audit,
        ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'],
        label,
    );
    requireTimestamp(audit.atEpochMs, `${label}.atEpochMs`);
    validateMutationActor(audit.actor, `${label}.actor`);
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        requireNullableString(audit[field], `${label}.${field}`);
    }
}

function validatePrincipal(
    value: unknown,
    label: string,
): asserts value is ClientPrincipal {
    const principal = requirePlainRecord(value, label);
    requireAllowedKeys(
        principal,
        [
            'applicationId', 'workspaceId', 'principalId', 'username', 'displayName',
            'avatarUrl', 'status', 'authProvider', 'externalSubjectId', 'roles',
            'metadata', 'snapshotVersion', 'profileVersion', 'presenceVersion',
            'created', 'updated', 'disabled', 'deleted', 'lastSeenAtEpochMs',
        ],
        [
            'applicationId', 'workspaceId', 'principalId', 'username', 'displayName',
            'avatarUrl', 'status', 'authProvider', 'externalSubjectId', 'roles',
            'metadata', 'snapshotVersion', 'profileVersion', 'presenceVersion',
            'created', 'updated', 'disabled', 'deleted', 'lastSeenAtEpochMs',
        ],
        label,
    );
    validatePrincipalRef(principal, label, false);
    requireNonEmptyString(principal.username, `${label}.username`);
    for (
        const field of [
            'displayName', 'avatarUrl', 'authProvider', 'externalSubjectId',
        ] as const
    ) {
        requireNullableString(principal[field], `${label}.${field}`);
    }
    requireEnum(principal.status, CLIENT_PRINCIPAL_STATUSES, `${label}.status`);
    requireStringArray(principal.roles, `${label}.roles`);
    requireJsonRecord(principal.metadata, `${label}.metadata`);
    for (const field of ['snapshotVersion', 'profileVersion', 'presenceVersion'] as const) {
        requirePositiveSafeInteger(principal[field], `${label}.${field}`);
    }
    validateAudit(principal.created, `${label}.created`);
    validateAudit(principal.updated, `${label}.updated`);
    if (principal.disabled !== null) validateAudit(principal.disabled, `${label}.disabled`);
    if (principal.deleted !== null) validateAudit(principal.deleted, `${label}.deleted`);
    requireNullableTimestamp(principal.lastSeenAtEpochMs, `${label}.lastSeenAtEpochMs`);
    if (principal.status === 'active' &&
        (principal.disabled !== null || principal.deleted !== null)) {
        reject(`${label} active lifecycle fields must be null`);
    }
    if (principal.status === 'disabled' &&
        (principal.disabled === null || principal.deleted !== null)) {
        reject(`${label} disabled lifecycle fields are invalid`);
    }
    if (principal.status === 'deleted' && principal.deleted === null) {
        reject(`${label} deleted lifecycle audit is required`);
    }
}

function validateInstance(
    value: unknown,
    label: string,
): asserts value is ClientInstance {
    const instance = requirePlainRecord(value, label);
    requireAllowedKeys(
        instance,
        [
            'applicationId', 'workspaceId', 'principalId', 'clientInstanceId', 'status',
            'platform', 'deviceLabel', 'appVersion', 'userAgent', 'capabilities',
            'registered', 'updated', 'revoked',
        ],
        [
            'applicationId', 'workspaceId', 'principalId', 'clientInstanceId', 'status',
            'platform', 'deviceLabel', 'appVersion', 'userAgent', 'capabilities',
            'registered', 'updated', 'revoked',
        ],
        label,
    );
    validatePrincipalRef(instance, label, false);
    requireNonEmptyString(instance.clientInstanceId, `${label}.clientInstanceId`);
    requireEnum(instance.status, CLIENT_INSTANCE_STATUSES, `${label}.status`);
    requireEnum(instance.platform, CLIENT_PLATFORMS, `${label}.platform`);
    for (const field of ['deviceLabel', 'appVersion', 'userAgent'] as const) {
        requireNullableString(instance[field], `${label}.${field}`);
    }
    requireStringArray(instance.capabilities, `${label}.capabilities`);
    validateAudit(instance.registered, `${label}.registered`);
    validateAudit(instance.updated, `${label}.updated`);
    if (instance.revoked !== null) validateAudit(instance.revoked, `${label}.revoked`);
    if ((instance.status === 'active') !== (instance.revoked === null)) {
        reject(`${label} revoked lifecycle field differs from status`);
    }
}

function validateSession(
    value: unknown,
    label: string,
): asserts value is ClientSession {
    const session = requirePlainRecord(value, label);
    requireAllowedKeys(
        session,
        [
            'applicationId', 'workspaceId', 'principalId', 'clientInstanceId', 'sessionId',
            'generationId', 'generationVersion', 'status', 'presenceState', 'transport',
            'connectionId',
            'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs', 'disconnectedAtEpochMs', 'disconnectReason',
        ],
        [
            'applicationId', 'workspaceId', 'principalId', 'clientInstanceId',
            'sessionId', 'generationId', 'generationVersion', 'status', 'presenceState',
            'transport', 'connectionId', 'authenticatedAtEpochMs', 'connectedAtEpochMs',
            'lastHeartbeatAtEpochMs', 'expiresAtEpochMs', 'disconnectedAtEpochMs',
            'disconnectReason',
        ],
        label,
    );
    validatePrincipalRef(session, label, false);
    requireNonEmptyString(session.clientInstanceId, `${label}.clientInstanceId`);
    requireNonEmptyString(session.sessionId, `${label}.sessionId`);
    validateGenerationId(session.generationId);
    requirePositiveSafeInteger(session.generationVersion, `${label}.generationVersion`);
    requireEnum(session.status, CLIENT_SESSION_STATUSES, `${label}.status`);
    requireEnum(session.presenceState, CLIENT_PRESENCE_STATES, `${label}.presenceState`);
    requireEnum(session.transport, CLIENT_TRANSPORTS, `${label}.transport`);
    requireNullableNonEmptyString(session.connectionId, `${label}.connectionId`);
    for (
        const field of [
            'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs',
        ] as const
    ) {
        requireTimestamp(session[field], `${label}.${field}`);
    }
    requireNullableTimestamp(session.disconnectedAtEpochMs, `${label}.disconnectedAtEpochMs`);
    requireNullableNonEmptyString(session.disconnectReason, `${label}.disconnectReason`);
    if (session.status === 'active' &&
        (session.disconnectedAtEpochMs !== null || session.disconnectReason !== null)) {
        reject(`${label} active disconnect fields must be null`);
    }
    if (session.status !== 'active' &&
        (session.disconnectedAtEpochMs === null || session.disconnectReason === null)) {
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
    if (disconnectedAt !== null && disconnectedAt < heartbeatAt) {
        reject(`${label}.disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs`);
    }
}

function validateRuntimeEntry(value: unknown, label: string): void {
    const entry = requirePlainRecord(value, label);
    requireExactKeys(
        entry,
        ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
        label,
    );
    requireNonEmptyString(entry.key, `${label}.key`);
    requireString(entry.value, `${label}.value`);
    requireTimestamp(entry.expireAtTimestamp, `${label}.expireAtTimestamp`);
    requireNonEmptyString(entry.updatedTimestamp, `${label}.updatedTimestamp`);
    requireTimestamp(entry.revision, `${label}.revision`);
}

function validateNullableEntryValue(
    value: unknown,
    label: string,
    validateValue: (value: unknown, label: string) => void,
): void {
    if (value === null) return;
    const wrapped = requirePlainRecord(value, label);
    requireExactKeys(wrapped, ['entry', 'value'], label);
    validateRuntimeEntry(wrapped.entry, `${label}.entry`);
    validateValue(wrapped.value, `${label}.value`);
}

function validateClientMutationFacts(facts: unknown): void {
    const value = requirePlainRecord(facts, 'Client mutation facts');
    requireExactKeys(
        value,
        ['nowEpochMs', 'serviceId', 'eventId', 'commandHash', 'attemptCount', 'expireAtEpochMs'],
        'Client mutation facts',
    );
    requireTimestamp(value.nowEpochMs, 'Client mutation facts.nowEpochMs');
    requireNonEmptyString(value.serviceId, 'Client mutation facts.serviceId');
    requireNonEmptyString(value.eventId, 'Client mutation facts.eventId');
    requireSha256(value.commandHash, 'Client mutation facts.commandHash');
    requirePositiveSafeInteger(value.attemptCount, 'Client mutation facts.attemptCount');
    requireTimestamp(value.expireAtEpochMs, 'Client mutation facts.expireAtEpochMs');
    if ((value.expireAtEpochMs as number) <= (value.nowEpochMs as number)) {
        reject('Client mutation facts.expireAtEpochMs must follow nowEpochMs');
    }
}

function validateClientMutationAuthority(authority: unknown): void {
    const value = requirePlainRecord(authority, 'Client mutation authority');
    if (value.kind === 'issued-session') {
        requireExactKeys(
            value,
            [
                'kind', 'version', 'principalId', 'sessionId',
                'sessionIssuedAtEpochMs', 'sessionExpiresAtEpochMs',
                'applicationId', 'workspaceId', 'operation',
            ],
            'Client mutation issued-session authority',
        );
        if (value.version !== 1 || value.operation === 'expireSession' ||
            !CLIENT_MUTATION_OPERATIONS.has(value.operation as string)) {
            reject('Client mutation issued-session authority is invalid');
        }
        for (
            const [field, label] of [
                ['principalId', 'principalId'], ['sessionId', 'sessionId'],
                ['applicationId', 'applicationId'], ['workspaceId', 'workspaceId'],
            ] as const
        ) {
            requireNonEmptyString(
                value[field],
                `Client mutation authority.${label}`,
            );
        }
        requireTimestamp(
            value.sessionIssuedAtEpochMs,
            'Client mutation authority.sessionIssuedAtEpochMs',
        );
        requireTimestamp(
            value.sessionExpiresAtEpochMs,
            'Client mutation authority.sessionExpiresAtEpochMs',
        );
        if (
            (value.sessionExpiresAtEpochMs as number) <=
                (value.sessionIssuedAtEpochMs as number)
        ) {
            reject('Client mutation authority expiry must follow issuance');
        }
        return;
    }
    if (value.kind === 'system') {
        requireExactKeys(
            value,
            ['kind', 'version', 'serviceId', 'operation'],
            'Client mutation system authority',
        );
        if (value.version !== 1 || value.operation !== 'expireSession') {
            reject('Client mutation system authority is invalid');
        }
        requireNonEmptyString(
            value.serviceId,
            'Client mutation authority.serviceId',
        );
        return;
    }
    reject('Client mutation authority kind is invalid');
}

function requireSha256(value: unknown, label: string): void {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        reject(`${label} must be a canonical SHA-256 digest`);
    }
}

function validateReceipt(value: unknown, label: string): void {
    const receipt = requirePlainRecord(value, label);
    requireExactKeys(
        receipt,
        [
            'commandId', 'requestId', 'commandHash', 'aggregateRef', 'outcome',
            'attemptCount', 'acceptedStorageRevision', 'stateRevision',
            'snapshotVersion', 'presenceVersion', 'eventId', 'outboxIds',
        ],
        label,
    );
    requireNonEmptyString(receipt.commandId, `${label}.commandId`);
    requireNullableNonEmptyString(receipt.requestId, `${label}.requestId`);
    requireSha256(receipt.commandHash, `${label}.commandHash`);
    validatePrincipalRef(receipt.aggregateRef, `${label}.aggregateRef`);
    requireEnum(receipt.outcome, new Set(['applied', 'no-op']), `${label}.outcome`);
    requirePositiveSafeInteger(receipt.attemptCount, `${label}.attemptCount`);
    if (receipt.acceptedStorageRevision === null) {
        reject(`${label}.acceptedStorageRevision is required`);
    }
    requireTimestamp(
        receipt.acceptedStorageRevision,
        `${label}.acceptedStorageRevision`,
    );
    requirePositiveSafeInteger(receipt.stateRevision, `${label}.stateRevision`);
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label}.snapshotVersion`);
    requirePositiveSafeInteger(receipt.presenceVersion, `${label}.presenceVersion`);
    requireNullableNonEmptyString(receipt.eventId, `${label}.eventId`);
    requireStringArray(receipt.outboxIds, `${label}.outboxIds`);
    if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
        reject(`${label}.eventId differs from outcome`);
    }
    if (receipt.stateRevision !== receipt.acceptedStorageRevision + 1) {
        reject(`${label}.stateRevision differs from acceptedStorageRevision`);
    }
    const expectedOutboxCount = receipt.outcome === 'applied' ? 2 : 0;
    if (receipt.outboxIds.length !== expectedOutboxCount) {
        reject(`${label}.outboxIds differs from outcome`);
    }
    if (receipt.outcome === 'applied' &&
        (new Set(receipt.outboxIds as string[]).size !== receipt.outboxIds.length ||
            receipt.outboxIds.some((outboxId) => outboxId.length === 0))) {
        reject(`${label}.outboxIds are not unique durable identities`);
    }
}

function validateClientEvent(
    value: unknown,
    label: string,
): asserts value is ClientEvent {
    const event = requirePlainRecord(value, label);
    requireExactKeys(
        event,
        [
            'applicationId', 'workspaceId', 'principalId', 'eventId', 'eventType',
            'snapshotVersion', 'clientInstanceId', 'sessionId', 'occurredAtEpochMs',
            'actor', 'reason', 'traceId', 'requestId', 'payload',
        ],
        label,
    );
    validatePrincipalRef(event, label, false);
    requireNonEmptyString(event.eventId, `${label}.eventId`);
    requireEnum(event.eventType, CLIENT_EVENT_TYPES, `${label}.eventType`);
    requirePositiveSafeInteger(event.snapshotVersion, `${label}.snapshotVersion`);
    requireNullableNonEmptyString(event.clientInstanceId, `${label}.clientInstanceId`);
    requireNullableNonEmptyString(event.sessionId, `${label}.sessionId`);
    requireTimestamp(event.occurredAtEpochMs, `${label}.occurredAtEpochMs`);
    validateMutationActor(event.actor, `${label}.actor`);
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        requireNullableString(event[field], `${label}.${field}`);
    }
    requireJsonRecord(event.payload, `${label}.payload`);
}

function validateMutationActor(
    value: unknown,
    label: string,
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

export function validateClientMutationIdempotencyRecord(
    value: unknown,
): asserts value is ClientMutationIdempotencyRecord {
    validateIdempotencyRecord(value, 'Stored client idempotency value');
}

function validateIdempotencyRecord(value: unknown, label: string): void {
    const record = requirePlainRecord(value, label);
    requireExactKeys(record, ['requestId', 'commandHash', 'receipt'], label);
    requireNonEmptyString(record.requestId, `${label}.requestId`);
    requireSha256(record.commandHash, `${label}.commandHash`);
    validateReceipt(record.receipt, `${label}.receipt`);
    const receipt = record.receipt as ClientMutationReceipt;
    if (
        receipt.commandHash !== record.commandHash ||
        receipt.requestId !== record.requestId ||
        receipt.commandId !== record.requestId
    ) {
        reject(`${label} receipt hash differs`);
    }
}

function validateConditionalCandidate(
    value: unknown,
    label: string,
    validateValue: (value: unknown, label: string) => void,
): void {
    const candidate = requirePlainRecord(value, label);
    switch (candidate.operation) {
        case 'none':
            requireExactKeys(candidate, ['operation'], label);
            return;
        case 'insert':
            requireExactKeys(candidate, ['operation', 'value'], label);
            validateValue(candidate.value, `${label}.value`);
            return;
        case 'update':
            requireExactKeys(
                candidate,
                ['operation', 'value', 'expectedRevision'],
                label,
            );
            validateValue(candidate.value, `${label}.value`);
            requireTimestamp(candidate.expectedRevision, `${label}.expectedRevision`);
            return;
        default:
            reject(`${label}.operation is invalid`);
    }
}


function validateClientMutationComputed(computed: unknown): void {
    const value = requirePlainRecord(computed, 'Client mutation computed');
    switch (value.outcome) {
        case 'replay':
            requireExactKeys(
                value,
                ['outcome', 'receipt', 'snapshot', 'event'],
                'Client mutation computed',
            );
            validateReceipt(value.receipt, 'Client mutation computed.receipt');
            validateAuthoritativeClientSnapshot(value.snapshot as ClientSnapshot);
            if (value.event !== null) {
                validateClientEvent(value.event, 'Client mutation computed.event');
            }
            return;
        case 'no-op':
            requireBoolean(
                value.persistIdempotency,
                'Client mutation computed.persistIdempotency',
            );
            requireExactKeys(
                value,
                value.persistIdempotency
                    ? [
                        'outcome', 'persistIdempotency', 'aggregateRef', 'idempotency',
                        'receipt', 'snapshot', 'event',
                    ]
                    : ['outcome', 'persistIdempotency', 'receipt', 'snapshot', 'event'],
                'Client mutation computed',
            );
            validateReceipt(value.receipt, 'Client mutation computed.receipt');
            validateAuthoritativeClientSnapshot(value.snapshot as ClientSnapshot);
            if (value.event !== null) {
                reject('Client mutation computed no-op event must be null');
            }
            if (value.persistIdempotency) {
                validatePrincipalRef(value.aggregateRef, 'Client mutation computed.aggregateRef');
                validateIdempotencyRecord(
                    value.idempotency,
                    'Client mutation computed.idempotency',
                );
            }
            return;
        case 'idempotency-conflict':
            requireExactKeys(
                value,
                ['outcome', 'existingCommandHash', 'receivedCommandHash'],
                'Client mutation computed',
            );
            requireSha256(
                value.existingCommandHash,
                'Client mutation computed.existingCommandHash',
            );
            requireSha256(
                value.receivedCommandHash,
                'Client mutation computed.receivedCommandHash',
            );
            return;
        case 'write':
            requireExactKeys(
                value,
                [
                    'outcome', 'principal', 'instance', 'session', 'event', 'receipt',
                    'snapshot', 'idempotency', 'stateSync', 'outboxEntries',
                ],
                'Client mutation computed',
            );
            validateConditionalCandidate(
                value.principal,
                'Client mutation computed.principal',
                validatePrincipal,
            );
            if ((value.principal as { operation?: unknown }).operation === 'none') {
                reject('Client mutation computed principal guard is required');
            }
            validateConditionalCandidate(
                value.instance,
                'Client mutation computed.instance',
                validateInstance,
            );
            validateConditionalCandidate(
                value.session,
                'Client mutation computed.session',
                validateSession,
            );
            validateClientEvent(value.event, 'Client mutation computed.event');
            validateAuthoritativeClientSnapshot(value.snapshot as ClientSnapshot);
            validateReceipt(value.receipt, 'Client mutation computed.receipt');
            if (value.idempotency !== null) {
                validateIdempotencyRecord(
                    value.idempotency,
                    'Client mutation computed.idempotency',
                );
            }
            if (!Array.isArray(value.stateSync) || value.stateSync.length !== 2) {
                reject('Client mutation computed stateSync must contain snapshot and event');
            }
            if (!Array.isArray(value.outboxEntries) || value.outboxEntries.length !== 2) {
                reject('Client mutation computed outboxEntries must contain snapshot and event');
            }
            return;
        default:
            reject('Client mutation computed outcome is invalid');
    }
}
