import type {
    AuditStamp,
    ClientEvent,
    ClientInstance,
    ClientPlatform,
    ClientPresenceState,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientPrincipalStatus,
    ClientSession,
    ClientTransport,
} from '@shared/api/client-types.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';

type NullableActorInput = Readonly<{
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    reason: string | null;
    traceId: string | null;
}>;

type ClientMutationCommandBase = Readonly<{
    aggregateRef: ClientPrincipalRef;
    commandId: string;
    requestId: string | null;
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
    commandHash: string;
    outcome: 'applied' | 'no-op';
    stateRevision: number;
    snapshotVersion: number;
    presenceVersion: number;
    event:
        | Readonly<{ kind: 'none' }>
        | Readonly<{ kind: 'client'; event: ClientEvent }>;
}>;

export type ClientMutationIdempotencyRecord = Readonly<{
    requestId: string;
    commandHash: string;
    receipt: ClientMutationReceipt;
}>;

export type ClientMutationRead = Readonly<{
    idempotency: RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | null;
    principal: RuntimeStateEntryValue<ClientPrincipal> | null;
    instance: RuntimeStateEntryValue<ClientInstance> | null;
    session: RuntimeStateEntryValue<ClientSession> | null;
}>;

export type ClientMutationFacts = Readonly<{
    nowEpochMs: number;
    serviceId: string;
    eventId: string;
    commandHash: string;
}>;

type ConditionalCandidate<T> =
    | Readonly<{ operation: 'none' }>
    | Readonly<{ operation: 'insert'; value: T }>
    | Readonly<{ operation: 'update'; value: T; expectedRevision: number }>;

export type ClientMutationOutboxCandidate = Readonly<{
    kind: 'client';
    aggregateRef: ClientPrincipalRef;
    commandId: string;
    commandHash: string;
    createdAtEpochMs: number;
    acceptedCausalRevision: Readonly<{
        kind: 'client';
        stateRevision: number;
        snapshotVersion: number;
        presenceVersion: number;
    }>;
    effects: readonly ['client-state-sync'];
    event:
        | Readonly<{ kind: 'none' }>
        | Readonly<{ kind: 'client'; event: ClientEvent }>;
}>;

export type ClientMutationComputed =
    | Readonly<{
        outcome: 'replay';
        receipt: ClientMutationReceipt;
    }>
    | Readonly<{
        outcome: 'no-op';
        receipt: ClientMutationReceipt;
        persistIdempotency: boolean;
    }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>
    | Readonly<{
        outcome: 'write';
        principal: Exclude<ConditionalCandidate<ClientPrincipal>, { operation: 'none' }>;
        instance: ConditionalCandidate<ClientInstance>;
        session: ConditionalCandidate<ClientSession>;
        event: ClientEvent;
        receipt: ClientMutationReceipt;
        idempotency: ClientMutationIdempotencyRecord | null;
        outbox: ClientMutationOutboxCandidate;
    }>;

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

export function computeClientMutation(input: Readonly<{
    command: ClientMutationCommand;
    read: ClientMutationRead;
    facts: ClientMutationFacts;
}>): ClientMutationComputed {
    const { command, read, facts } = input;
    validateClientMutationCommand(command);
    validateClientMutationFacts(facts);
    validateClientMutationRead(command, read);
    if (read.idempotency) {
        return read.idempotency.value.commandHash === facts.commandHash
            ? { outcome: 'replay', receipt: read.idempotency.value.receipt }
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
    facts: ClientMutationFacts;
}>): void {
    const { command, read, computed, facts } = input;
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
        computed.outbox.commandHash !== facts.commandHash ||
        computed.outbox.acceptedCausalRevision.stateRevision !==
            computed.receipt.stateRevision) {
        throw new ClientMutationRejectedError('Invalid effectful client mutation');
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
        ['idempotency', 'principal', 'instance', 'session'],
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
        ? bumpPrincipal(principal, command.input, facts, 'profile')
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
        ? bumpPrincipal(principal, command.input, facts, 'presence', session.lastHeartbeatAtEpochMs)
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
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== undefined) {
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
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== undefined) {
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
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== undefined ||
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
    const receipt: ClientMutationReceipt = {
        commandId: command.commandId,
        commandHash: facts.commandHash,
        outcome: 'applied',
        stateRevision,
        snapshotVersion: principal.snapshotVersion,
        presenceVersion: principal.presenceVersion,
        event: { kind: 'client', event },
    };
    return {
        outcome: 'write',
        principal: read.principal
            ? { operation: 'update', value: principal, expectedRevision: read.principal.entry.revision }
            : { operation: 'insert', value: principal },
        instance,
        session,
        event,
        receipt,
        idempotency: command.requestId === null ? null : {
            requestId: command.requestId,
            commandHash: facts.commandHash,
            receipt,
        },
        outbox: {
            kind: 'client',
            aggregateRef: command.aggregateRef,
            commandId: command.commandId,
            commandHash: facts.commandHash,
            createdAtEpochMs: facts.nowEpochMs,
            acceptedCausalRevision: {
                kind: 'client',
                stateRevision,
                snapshotVersion: principal.snapshotVersion,
                presenceVersion: principal.presenceVersion,
            },
            effects: ['client-state-sync'],
            event: { kind: 'client', event },
        },
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
    return {
        outcome: 'no-op',
        persistIdempotency,
        receipt: {
            commandId: command.commandId,
            commandHash: facts.commandHash,
            outcome: 'no-op',
            stateRevision: (read.principal?.entry.revision ?? -1) + 1,
            snapshotVersion: principal.snapshotVersion,
            presenceVersion: principal.presenceVersion,
            event: { kind: 'none' },
        },
    };
}

function toPrincipal(
    command: Extract<ClientMutationCommand, { operation: 'upsertPrincipal' }>,
    existing: ClientPrincipal | undefined,
    facts: ClientMutationFacts,
): ClientPrincipal {
    const audit = toAudit(command, facts);
    const status = command.input.status ?? existing?.status ?? 'active';
    return {
        applicationId: command.aggregateRef.applicationId,
        ...(command.aggregateRef.workspaceId === undefined
            ? {} : { workspaceId: command.aggregateRef.workspaceId }),
        principalId: command.aggregateRef.principalId,
        username: command.input.username,
        ...(toOptional('displayName', command.input.displayName, existing?.displayName)),
        ...(toOptional('avatarUrl', command.input.avatarUrl, existing?.avatarUrl)),
        status,
        ...(toOptional('authProvider', command.input.authProvider, existing?.authProvider)),
        ...(toOptional('externalSubjectId', command.input.externalSubjectId,
            existing?.externalSubjectId)),
        roles: command.input.roles ?? existing?.roles ?? [],
        metadata: { ...(command.input.metadata ?? existing?.metadata ?? {}) },
        snapshotVersion: existing ? existing.snapshotVersion + 1 : 1,
        profileVersion: existing ? existing.profileVersion + 1 : 1,
        presenceVersion: existing?.presenceVersion ?? 1,
        created: existing?.created ?? audit,
        updated: audit,
        ...(status === 'disabled' ? { disabled: audit } :
            existing?.disabled ? { disabled: existing.disabled } : {}),
        ...(status === 'deleted' ? { deleted: audit } :
            existing?.deleted ? { deleted: existing.deleted } : {}),
        ...(toOptional('lastSeenAtEpochMs', command.input.lastSeenAtEpochMs,
            existing?.lastSeenAtEpochMs)),
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
        status: 'active',
        roles: connectInput?.principalRoles ?? [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
    };
}

function toInstance(
    command: Extract<ClientMutationCommand, { operation: 'upsertInstance' }>,
    existing: ClientInstance | undefined,
    facts: ClientMutationFacts,
): ClientInstance {
    const audit = toAudit(command, facts);
    const status = command.input.status ?? existing?.status ?? 'active';
    return {
        ...command.aggregateRef,
        clientInstanceId: command.clientInstanceId,
        status,
        platform: command.input.platform ?? existing?.platform ?? 'unknown',
        ...(toOptional('deviceLabel', command.input.deviceLabel, existing?.deviceLabel)),
        ...(toOptional('appVersion', command.input.appVersion, existing?.appVersion)),
        ...(toOptional('userAgent', command.input.userAgent, existing?.userAgent)),
        capabilities: command.input.capabilities ?? existing?.capabilities ?? [],
        registered: existing?.registered ?? audit,
        updated: audit,
        ...(status === 'revoked' ? { revoked: audit } :
            existing?.revoked ? { revoked: existing.revoked } : {}),
    };
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
        ...(principal.workspaceId === undefined ? {} : { workspaceId: principal.workspaceId }),
        principalId: principal.principalId,
        clientInstanceId: command.clientInstanceId,
        status: 'active',
        platform: command.input.instancePlatform ??
            (command.operation === 'connectAuthorisedWsSession' ? 'web' : 'unknown'),
        ...(command.input.instanceUserAgent === null ? {} : {
            userAgent: command.input.instanceUserAgent,
        }),
        capabilities: command.input.instanceCapabilities ??
            (command.input.transport ? [command.input.transport] : []),
        registered: audit,
        updated: audit,
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
        ...(principal.workspaceId === undefined ? {} : { workspaceId: principal.workspaceId }),
        principalId: principal.principalId,
        clientInstanceId: command.clientInstanceId,
        sessionId: command.sessionId,
        generationId: command.input.generationId,
        generationVersion: (existing?.generationVersion ?? 0) + 1,
        status: 'active',
        presenceState: command.input.presenceState ?? 'online',
        transport: command.input.transport ?? 'unknown',
        ...(command.input.connectionId === null ? {} : {
            connectionId: command.input.connectionId,
        }),
        authenticatedAtEpochMs: command.input.authenticatedAtEpochMs ?? connectedAt,
        connectedAtEpochMs: connectedAt,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: command.input.expiresAtEpochMs ??
            heartbeatAt + 24 * 60 * 60 * 1000,
    };
}

function bumpPrincipal(
    principal: ClientPrincipal,
    input: NullableActorInput,
    facts: ClientMutationFacts,
    domain: 'profile' | 'presence',
    lastSeenAtEpochMs?: number,
): ClientPrincipal {
    return {
        ...principal,
        snapshotVersion: principal.snapshotVersion + 1,
        profileVersion: principal.profileVersion + (domain === 'profile' ? 1 : 0),
        presenceVersion: principal.presenceVersion + (domain === 'presence' ? 1 : 0),
        updated: toAuditInput(input, principal, facts),
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
        ...(clientInstanceId === undefined ? {} : { clientInstanceId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        occurredAtEpochMs: facts.nowEpochMs,
        actor: {
            principalId: command.input.actorPrincipalId ?? principal.principalId,
            ...(command.input.actorSessionId === null
                ? {} : { sessionId: command.input.actorSessionId }),
            serviceId: facts.serviceId,
        },
        ...(command.input.reason === null ? {} : { reason: command.input.reason }),
        ...(command.input.traceId === null ? {} : { traceId: command.input.traceId }),
        ...(command.requestId === null ? {} : { requestId: command.requestId }),
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
        byPrincipalId: input.actorPrincipalId ?? ref.principalId,
        ...(input.actorSessionId === null ? {} : { bySessionId: input.actorSessionId }),
        byServiceId: facts.serviceId,
        ...(input.reason === null ? {} : { reason: input.reason }),
        ...(input.traceId === null ? {} : { traceId: input.traceId }),
        ...(requestId === null ? {} : { requestId }),
    };
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
    'operation', 'aggregateRef', 'commandId', 'requestId', 'input',
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

function requireNullableTimestamp(value: unknown, label: string): void {
    if (value !== null) requireTimestamp(value, label);
}

function requireOptionalTimestamp(value: unknown, label: string): void {
    if (value !== undefined) requireTimestamp(value, label);
}

function requirePositiveSafeInteger(value: unknown, label: string): void {
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

function requireStringArray(value: unknown, label: string): void {
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

function validatePrincipalRef(value: unknown, label: string, exact = true): void {
    const ref = requirePlainRecord(value, label);
    if (exact) {
        requireAllowedKeys(
            ref,
            ['applicationId', 'principalId'],
            ['applicationId', 'workspaceId', 'principalId'],
            label,
        );
    }
    requireNonEmptyString(ref.applicationId, `${label}.applicationId`);
    requireOptionalNonEmptyString(ref.workspaceId, `${label}.workspaceId`);
    requireNonEmptyString(ref.principalId, `${label}.principalId`);
}

function validateAudit(value: unknown, label: string): void {
    const audit = requirePlainRecord(value, label);
    requireAllowedKeys(
        audit,
        ['atEpochMs'],
        [
            'atEpochMs', 'byPrincipalId', 'bySessionId', 'byServiceId',
            'reason', 'traceId', 'requestId',
        ],
        label,
    );
    requireTimestamp(audit.atEpochMs, `${label}.atEpochMs`);
    for (const field of ['byPrincipalId', 'bySessionId', 'byServiceId'] as const) {
        requireOptionalNonEmptyString(audit[field], `${label}.${field}`);
    }
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        requireOptionalString(audit[field], `${label}.${field}`);
    }
    if (
        audit.byPrincipalId === undefined &&
        audit.bySessionId === undefined &&
        audit.byServiceId === undefined
    ) {
        reject(`${label} requires an actor identity`);
    }
}

function validatePrincipal(value: unknown, label: string): void {
    const principal = requirePlainRecord(value, label);
    requireAllowedKeys(
        principal,
        [
            'applicationId', 'principalId', 'username', 'status', 'roles', 'metadata',
            'snapshotVersion', 'profileVersion', 'presenceVersion', 'created', 'updated',
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
        requireOptionalString(principal[field], `${label}.${field}`);
    }
    requireEnum(principal.status, CLIENT_PRINCIPAL_STATUSES, `${label}.status`);
    requireStringArray(principal.roles, `${label}.roles`);
    requireJsonRecord(principal.metadata, `${label}.metadata`);
    for (const field of ['snapshotVersion', 'profileVersion', 'presenceVersion'] as const) {
        requirePositiveSafeInteger(principal[field], `${label}.${field}`);
    }
    validateAudit(principal.created, `${label}.created`);
    validateAudit(principal.updated, `${label}.updated`);
    if (principal.disabled !== undefined) validateAudit(principal.disabled, `${label}.disabled`);
    if (principal.deleted !== undefined) validateAudit(principal.deleted, `${label}.deleted`);
    requireOptionalTimestamp(principal.lastSeenAtEpochMs, `${label}.lastSeenAtEpochMs`);
}

function validateInstance(value: unknown, label: string): void {
    const instance = requirePlainRecord(value, label);
    requireAllowedKeys(
        instance,
        [
            'applicationId', 'principalId', 'clientInstanceId', 'status', 'platform',
            'capabilities', 'registered', 'updated',
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
        requireOptionalString(instance[field], `${label}.${field}`);
    }
    requireStringArray(instance.capabilities, `${label}.capabilities`);
    validateAudit(instance.registered, `${label}.registered`);
    validateAudit(instance.updated, `${label}.updated`);
    if (instance.revoked !== undefined) validateAudit(instance.revoked, `${label}.revoked`);
}

function validateSession(value: unknown, label: string): void {
    const session = requirePlainRecord(value, label);
    requireAllowedKeys(
        session,
        [
            'applicationId', 'principalId', 'clientInstanceId', 'sessionId',
            'generationId', 'generationVersion', 'status', 'presenceState', 'transport',
            'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs',
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
    requireOptionalNonEmptyString(session.connectionId, `${label}.connectionId`);
    for (
        const field of [
            'authenticatedAtEpochMs', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs',
        ] as const
    ) {
        requireTimestamp(session[field], `${label}.${field}`);
    }
    requireOptionalTimestamp(session.disconnectedAtEpochMs, `${label}.disconnectedAtEpochMs`);
    requireOptionalString(session.disconnectReason, `${label}.disconnectReason`);
    if (session.status === 'active' && session.disconnectedAtEpochMs !== undefined) {
        reject(`${label} active status cannot have disconnectedAtEpochMs`);
    }
    if (session.status !== 'active' && session.disconnectedAtEpochMs === undefined) {
        reject(`${label} terminal status requires disconnectedAtEpochMs`);
    }
    const authenticatedAt = session.authenticatedAtEpochMs as number;
    const connectedAt = session.connectedAtEpochMs as number;
    const heartbeatAt = session.lastHeartbeatAtEpochMs as number;
    const expiresAt = session.expiresAtEpochMs as number;
    const disconnectedAt = session.disconnectedAtEpochMs as number | undefined;
    if (authenticatedAt > connectedAt) {
        reject(`${label}.authenticatedAtEpochMs must not follow connectedAtEpochMs`);
    }
    if (connectedAt > heartbeatAt) {
        reject(`${label}.lastHeartbeatAtEpochMs must not predate connectedAtEpochMs`);
    }
    if (heartbeatAt > expiresAt) {
        reject(`${label}.expiresAtEpochMs must not predate lastHeartbeatAtEpochMs`);
    }
    if (disconnectedAt !== undefined && disconnectedAt < heartbeatAt) {
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
        ['nowEpochMs', 'serviceId', 'eventId', 'commandHash'],
        'Client mutation facts',
    );
    requireTimestamp(value.nowEpochMs, 'Client mutation facts.nowEpochMs');
    requireNonEmptyString(value.serviceId, 'Client mutation facts.serviceId');
    requireNonEmptyString(value.eventId, 'Client mutation facts.eventId');
    requireSha256(value.commandHash, 'Client mutation facts.commandHash');
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
            'commandId', 'commandHash', 'outcome', 'stateRevision',
            'snapshotVersion', 'presenceVersion', 'event',
        ],
        label,
    );
    requireNonEmptyString(receipt.commandId, `${label}.commandId`);
    requireSha256(receipt.commandHash, `${label}.commandHash`);
    requireEnum(receipt.outcome, new Set(['applied', 'no-op']), `${label}.outcome`);
    for (const field of ['stateRevision', 'snapshotVersion', 'presenceVersion'] as const) {
        requirePositiveSafeInteger(receipt[field], `${label}.${field}`);
    }
    validateEventEnvelope(receipt.event, `${label}.event`);
}

function validateEventEnvelope(value: unknown, label: string): void {
    const envelope = requirePlainRecord(value, label);
    if (envelope.kind === 'none') {
        requireExactKeys(envelope, ['kind'], label);
        return;
    }
    if (envelope.kind !== 'client') reject(`${label}.kind is invalid`);
    requireExactKeys(envelope, ['kind', 'event'], label);
    validateClientEvent(envelope.event, `${label}.event`);
}

function validateClientEvent(value: unknown, label: string): void {
    const event = requirePlainRecord(value, label);
    requireAllowedKeys(
        event,
        [
            'applicationId', 'principalId', 'eventId', 'eventType',
            'snapshotVersion', 'occurredAtEpochMs', 'actor',
        ],
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
    requireOptionalNonEmptyString(event.clientInstanceId, `${label}.clientInstanceId`);
    requireOptionalNonEmptyString(event.sessionId, `${label}.sessionId`);
    requireTimestamp(event.occurredAtEpochMs, `${label}.occurredAtEpochMs`);
    const actor = requirePlainRecord(event.actor, `${label}.actor`);
    requireAllowedKeys(
        actor,
        [],
        ['principalId', 'sessionId', 'serviceId'],
        `${label}.actor`,
    );
    for (const field of ['principalId', 'sessionId', 'serviceId'] as const) {
        requireOptionalNonEmptyString(actor[field], `${label}.actor.${field}`);
    }
    if (
        actor.principalId === undefined && actor.sessionId === undefined &&
        actor.serviceId === undefined
    ) {
        reject(`${label}.actor requires an identity`);
    }
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        requireOptionalString(event[field], `${label}.${field}`);
    }
    if (event.payload !== undefined) requireJsonRecord(event.payload, `${label}.payload`);
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
    if (receipt.commandHash !== record.commandHash) {
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

function validateOutboxCandidate(value: unknown, label: string): void {
    const outbox = requirePlainRecord(value, label);
    requireExactKeys(
        outbox,
        [
            'kind', 'aggregateRef', 'commandId', 'commandHash', 'createdAtEpochMs',
            'acceptedCausalRevision', 'effects', 'event',
        ],
        label,
    );
    if (outbox.kind !== 'client') reject(`${label}.kind must be client`);
    validatePrincipalRef(outbox.aggregateRef, `${label}.aggregateRef`);
    requireNonEmptyString(outbox.commandId, `${label}.commandId`);
    requireSha256(outbox.commandHash, `${label}.commandHash`);
    requireTimestamp(outbox.createdAtEpochMs, `${label}.createdAtEpochMs`);
    const revision = requirePlainRecord(
        outbox.acceptedCausalRevision,
        `${label}.acceptedCausalRevision`,
    );
    requireExactKeys(
        revision,
        ['kind', 'stateRevision', 'snapshotVersion', 'presenceVersion'],
        `${label}.acceptedCausalRevision`,
    );
    if (revision.kind !== 'client') {
        reject(`${label}.acceptedCausalRevision.kind must be client`);
    }
    for (const field of ['stateRevision', 'snapshotVersion', 'presenceVersion'] as const) {
        requirePositiveSafeInteger(
            revision[field],
            `${label}.acceptedCausalRevision.${field}`,
        );
    }
    if (!Array.isArray(outbox.effects) || outbox.effects.length !== 1 ||
        outbox.effects[0] !== 'client-state-sync') {
        reject(`${label}.effects must contain only client-state-sync`);
    }
    validateEventEnvelope(outbox.event, `${label}.event`);
}

function validateClientMutationComputed(computed: unknown): void {
    const value = requirePlainRecord(computed, 'Client mutation computed');
    switch (value.outcome) {
        case 'replay':
            requireExactKeys(value, ['outcome', 'receipt'], 'Client mutation computed');
            validateReceipt(value.receipt, 'Client mutation computed.receipt');
            return;
        case 'no-op':
            requireExactKeys(
                value,
                ['outcome', 'receipt', 'persistIdempotency'],
                'Client mutation computed',
            );
            requireBoolean(
                value.persistIdempotency,
                'Client mutation computed.persistIdempotency',
            );
            validateReceipt(value.receipt, 'Client mutation computed.receipt');
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
                    'idempotency', 'outbox',
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
            validateReceipt(value.receipt, 'Client mutation computed.receipt');
            if (value.idempotency !== null) {
                validateIdempotencyRecord(
                    value.idempotency,
                    'Client mutation computed.idempotency',
                );
            }
            validateOutboxCandidate(value.outbox, 'Client mutation computed.outbox');
            return;
        default:
            reject('Client mutation computed outcome is invalid');
    }
}
