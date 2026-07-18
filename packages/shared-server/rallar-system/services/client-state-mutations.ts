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
        outcome: 'replay' | 'no-op';
        receipt: ClientMutationReceipt;
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

    constructor(message: string) {
        super(message);
        this.name = 'ClientMutationRejectedError';
    }
}

export function computeClientMutation(input: Readonly<{
    command: ClientMutationCommand;
    read: ClientMutationRead;
    facts: ClientMutationFacts;
}>): ClientMutationComputed {
    const { command, read, facts } = input;
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

function computeHeartbeat(
    command: Extract<ClientMutationCommand, { operation: 'heartbeatSession' }>,
    read: ClientMutationRead,
    facts: ClientMutationFacts,
): ClientMutationComputed {
    const principal = requirePrincipal(read, command);
    const existing = requireSession(read, command);
    if (existing.generationId !== command.input.generationId ||
        existing.status !== 'active' || existing.disconnectedAtEpochMs !== undefined) {
        return noOpReceipt(command, read, facts);
    }
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (heartbeatAt < existing.lastHeartbeatAtEpochMs) {
        return noOpReceipt(command, read, facts);
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
        return noOpReceipt(command, read, facts);
    }
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    const session: ClientSession = {
        ...existing,
        status: 'disconnected',
        lastHeartbeatAtEpochMs: command.input.lastHeartbeatAtEpochMs ??
            existing.lastHeartbeatAtEpochMs,
        expiresAtEpochMs: command.input.expiresAtEpochMs ?? existing.expiresAtEpochMs,
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
        return noOpReceipt(command, read, facts);
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
): ClientMutationComputed {
    const principal = read.principal?.value;
    if (!principal) {
        throw new ClientMutationRejectedError(
            `Client principal not found: ${command.aggregateRef.principalId}`,
        );
    }
    return {
        outcome: 'no-op',
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
    return {
        ...command.aggregateRef,
        username: command.aggregateRef.principalId,
        displayName: command.aggregateRef.principalId,
        status: 'active',
        roles: [],
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
