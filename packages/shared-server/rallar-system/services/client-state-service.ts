import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    ClientEvent,
    ClientPlatform,
    ClientPresenceSnapshot,
    ClientPrincipalRef,
    ClientScope,
    ClientSession,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
} from '@shared/api/state-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import { ClientStateRepository } from '../repositories/ClientStateRepository.ts';
import {
    type ClientSessionExpiryCandidate,
    toClientSessionExpiryCandidate,
} from '../repositories/session-expiry.ts';
import type { ClientStateEventStore } from '../repositories/StateEventStore.ts';
import type { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import {
    createStateMutationOutboxRecord,
    hashStateMutationCommand,
    StateMutationOutboxRepository,
} from '../repositories/StateMutationOutboxRepository.ts';
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import {
    ClientMutationIdempotencyConflictError,
    ClientMutationRejectedError,
    computeClientMutation,
    type ClientMutationCommand,
    type ClientMutationComputed,
    type ClientMutationFacts,
    type ClientMutationRead,
    type ClientMutationReceipt,
    validateClientMutation,
    validateClientMutationCommand,
} from './client-state-mutations.ts';
import {
    nowMs,
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingSink,
} from './timing.ts';

export { ClientMutationIdempotencyConflictError, ClientMutationRejectedError };
export type { ClientMutationReceipt };

export type RegisterAuthorisedWsClientInput = Readonly<{
    applicationId?: string;
    workspaceId?: string;
    principalId?: string;
    clientInstanceId?: string;
    displayName?: string;
    userAgent?: string;
    platform?: ClientPlatform;
    capabilities?: readonly string[];
    connectedAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type ClientMutationWritten = Readonly<{
    snapshot: ClientSnapshot;
    event: ClientEvent | null;
}>;

export type ClientStateWritten = Readonly<{
    status: 'ok';
    result: Either<string, ClientMutationWritten>;
}>;

export type ClientStateService = Readonly<{
    listSnapshots(scope: ClientScope): Promise<readonly ClientSnapshot[]>;
    readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    readPresenceSnapshot(
        ref: ClientPrincipalRef,
    ): Promise<ClientPresenceSnapshot | undefined>;
    listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
    listRecentEvents?(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
    ): Promise<readonly ClientEvent[]>;
    listEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
    ): Promise<StateEventPage<ClientEvent>>;
    upsertPrincipal(
        scope: StateScope,
        principalId: string,
        request: UpsertClientPrincipalRequest,
    ): Promise<ClientStateWritten>;
    upsertInstance(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        request: UpsertClientInstanceRequest,
    ): Promise<ClientStateWritten>;
    connectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: ConnectClientSessionRequest,
    ): Promise<ClientStateWritten>;
    heartbeatSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: HeartbeatClientSessionRequest,
    ): Promise<ClientStateWritten>;
    disconnectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: DisconnectClientSessionRequest,
    ): Promise<ClientStateWritten>;
    registerAuthorisedWsClientSession(
        authSession: AuthSession,
        generationId: string,
        input?: RegisterAuthorisedWsClientInput,
    ): Promise<ClientStateWritten>;
    disconnectAuthorisedWsClientSession(
        sessionId: string,
        generationId: string,
        reason?: string,
    ): Promise<ClientStateWritten>;
    expireExpiredSessions(atEpochMs?: number): Promise<readonly ClientStateWritten[]>;
}>;

export type ClientStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    createClientStateEventStore?: (
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => ClientStateEventStore;
    /** Retained as a composition compatibility dependency; publication is outbox-owned. */
    syncPublisher: StateSyncPublisher;
    authSessionRepository?: Pick<AuthSessionRepository, 'findBySessionId'>;
    now?: () => number;
    randomId?: () => string;
    sleep?: (delayMs: number) => Promise<void>;
    serviceId: string;
    timing?: RallarTimingSink;
}>;

type ClientMutationExecution = Readonly<{
    receipt: ClientMutationReceipt;
    source: 'write' | 'replay' | 'no-op';
    event: ClientEvent | null;
}>;

export function createClientStateService(
    dependencies: ClientStateServiceDependencies,
): ClientStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const now = dependencies.now ?? (() => Date.now());
    const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    const repositoryFor = (
        runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => new ClientStateRepository(runtime, {
        events: dependencies.createClientStateEventStore?.(runtime),
    });

    const executeReceipt = async (
        command: ClientMutationCommand,
        mutationAtEpochMs: number = now(),
    ): Promise<ClientMutationExecution> => {
        validateClientMutationCommand(command);
        const stableFacts: Omit<ClientMutationFacts, 'attemptCount'> = {
            nowEpochMs: mutationAtEpochMs,
            serviceId: dependencies.serviceId,
            eventId: randomId(),
            commandHash: await hashStateMutationCommand(command),
        };
        let lastConflict: RuntimeStateWriteConflictError | undefined;

        for (
            let attempt = 0;
            attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS;
            attempt++
        ) {
            const facts: ClientMutationFacts = {
                ...stableFacts,
                attemptCount: attempt + 1,
            };
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: dependencies.sleep },
            );
            let activePhase: 'read' | 'compute' | 'validate' | 'write' = 'read';
            let phaseStarted = nowMs();
            let phaseRecorded = false;
            let transactionStarted: number | undefined;
            try {
                const read = await readClientMutation(
                    repositoryFor(runtimeRepository),
                    command,
                );
                recordMutationPhase(
                    dependencies,
                    command,
                    'read',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'compute';
                phaseStarted = nowMs();
                phaseRecorded = false;
                const computed = computeClientMutation({ command, read, facts });
                recordMutationPhase(
                    dependencies,
                    command,
                    'compute',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'validate';
                phaseStarted = nowMs();
                phaseRecorded = false;
                validateClientMutation({ command, read, computed, facts });
                recordMutationPhase(
                    dependencies,
                    command,
                    'validate',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;
                if (computed.outcome === 'idempotency-conflict') {
                    throw new ClientMutationIdempotencyConflictError(
                        command.commandId,
                        computed.existingCommandHash,
                        computed.receivedCommandHash,
                    );
                }
                if (computed.outcome === 'no-op' && computed.persistIdempotency &&
                    command.requestId !== null) {
                    const inserted = await repositoryFor(runtimeRepository)
                        .insertIdempotentClientStateWritten(
                            command.aggregateRef,
                            command.requestId,
                            {
                                requestId: command.requestId,
                                commandHash: facts.commandHash,
                                receipt: computed.receipt,
                            },
                        );
                    if (inserted.status === 'conflict') {
                        lastConflict = new RuntimeStateWriteConflictError();
                        recordMutationConflict(
                            dependencies,
                            command,
                            attempt,
                            backoffMs,
                        );
                        continue;
                    }
                }
                if (computed.outcome !== 'write') {
                    return {
                        receipt: computed.receipt,
                        source: computed.outcome,
                        event: await readClientReceiptEvent(
                            repositoryFor(runtimeRepository),
                            command.aggregateRef,
                            computed.receipt.eventId,
                        ),
                    };
                }

                activePhase = 'write';
                phaseStarted = nowMs();
                phaseRecorded = false;
                transactionStarted = nowMs();
                const written = await writeClientMutation(
                    runtimeRepository,
                    repositoryFor,
                    computed,
                );
                recordMutationPhase(
                    dependencies,
                    command,
                    'transaction',
                    'ok',
                    transactionStarted,
                    attempt,
                    backoffMs,
                );
                recordMutationPhase(
                    dependencies,
                    command,
                    'write',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;
                return { receipt: written, source: 'write', event: computed.event };
            } catch (error) {
                if (activePhase === 'write' && transactionStarted !== undefined) {
                    recordMutationPhase(
                        dependencies,
                        command,
                        'transaction',
                        'error',
                        transactionStarted,
                        attempt,
                        backoffMs,
                        error,
                    );
                }
                if (!phaseRecorded) {
                    recordMutationPhase(
                        dependencies,
                        command,
                        activePhase,
                        'error',
                        phaseStarted,
                        attempt,
                        backoffMs,
                        error,
                    );
                }
                if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
                lastConflict = error;
                recordMutationConflict(dependencies, command, attempt, backoffMs);
            }
        }
        throw new RuntimeStateRetryExhaustedError(
            lastConflict ?? new RuntimeStateWriteConflictError(),
        );
    };

    const executeCompatible = async (
        command: ClientMutationCommand,
    ): Promise<ClientStateWritten> => {
        const execution = await executeReceipt(command);
        const snapshot = await repositoryFor(runtimeRepository).readSnapshot(
            command.aggregateRef,
        );
        if (!snapshot) {
            throw new ClientMutationRejectedError(
                `Client snapshot not found: ${command.aggregateRef.principalId}`,
            );
        }
        return {
            status: 'ok',
            result: Either.ofRight({
                snapshot,
                event: execution.event,
            }),
        };
    };

    const service: ClientStateService = {
        listSnapshots: async (scope) =>
            await repositoryFor(runtimeRepository).listSnapshots(scope),
        readSnapshot: async (ref) =>
            await repositoryFor(runtimeRepository).readSnapshot(ref),
        readPresenceSnapshot: async (ref) =>
            await repositoryFor(runtimeRepository).readPresenceSnapshot(ref),
        listEvents: async (ref) =>
            await repositoryFor(runtimeRepository).listEvents(ref),
        listRecentEvents: async (ref, query) =>
            await repositoryFor(runtimeRepository).listRecentEvents(ref, query),
        listEventPage: async (ref, query) =>
            await repositoryFor(runtimeRepository).listEventPage(ref, query),
        upsertPrincipal: async (scope, principalId, request) =>
            await executeCompatible(toUpsertPrincipalCommand(
                scope,
                principalId,
                request,
                randomId,
            )),
        upsertInstance: async (scope, principalId, clientInstanceId, request) =>
            await executeCompatible(toUpsertInstanceCommand(
                scope,
                principalId,
                clientInstanceId,
                request,
                randomId,
            )),
        connectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => await executeCompatible(toConnectCommand(
            'connectSession',
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
            randomId,
            {},
        )),
        heartbeatSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => await executeCompatible(toHeartbeatCommand(
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
            randomId,
        )),
        disconnectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => await executeCompatible(toDisconnectCommand(
            'disconnectSession',
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
            randomId,
        )),
        registerAuthorisedWsClientSession: async (
            authSession,
            generationId,
            input = {},
        ) => {
            const scope = toAuthorisedWsScope(input);
            const principalId = input.principalId ?? authSession.clientId;
            const clientInstanceId = input.clientInstanceId ?? authSession.clientId;
            const requestId = `authorised-ws:connect:${authSession.sessionId}:${generationId}`;
            return await executeCompatible(toConnectCommand(
                'connectAuthorisedWsSession',
                scope,
                principalId,
                clientInstanceId,
                authSession.sessionId,
                {
                    generationId,
                    presenceState: 'online',
                    transport: 'ws',
                    connectionId: generationId,
                    connectedAtEpochMs: input.connectedAtEpochMs,
                    expiresAtEpochMs: input.expiresAtEpochMs ?? authSession.expiresAtEpochMs,
                    actorPrincipalId: principalId,
                    actorSessionId: authSession.sessionId,
                    requestId,
                },
                randomId,
                {
                    platform: input.platform,
                    userAgent: input.userAgent,
                    capabilities: input.capabilities,
                    principalUsername: authSession.username,
                    principalDisplayName: input.displayName ?? authSession.username,
                    principalRoles: ['member'],
                },
            ));
        },
        disconnectAuthorisedWsClientSession: async (
            sessionId,
            generationId,
            reason = 'websocket-closed',
        ) => {
            const session = await findClientSessionBySessionId(
                repositoryFor(runtimeRepository),
                sessionId,
            );
            const issued = await dependencies.authSessionRepository?.findBySessionId(
                sessionId,
            );
            if (!session && !issued) {
                throw new NonRetryableException(`Client session not found: ${sessionId}`);
            }
            if (!session) {
                throw new NonRetryableException(
                    `Durable client connection generation not found: ${sessionId}`,
                );
            }
            const scope: StateScope = {
                applicationId: session.applicationId,
                workspaceId: session.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
            };
            return await executeCompatible(toDisconnectCommand(
                'disconnectAuthorisedWsSession',
                scope,
                session.principalId,
                session.clientInstanceId,
                sessionId,
                {
                    generationId,
                    reason,
                    actorPrincipalId: session.principalId,
                    actorSessionId: sessionId,
                    requestId:
                        `authorised-ws:disconnect:${sessionId}:${generationId}`,
                },
                randomId,
            ));
        },
        expireExpiredSessions: async (atEpochMs = now()) => {
            const sessions = (await repositoryFor(runtimeRepository).listAllSessions())
                .filter((session) =>
                    session.status === 'active' &&
                    session.disconnectedAtEpochMs === null &&
                    session.expiresAtEpochMs <= atEpochMs
                )
                .map(toClientSessionExpiryCandidate);
            const results: ClientStateWritten[] = [];
            for (const candidate of sessions) {
                const command = toExpiryCommand(candidate);
                const execution = await executeReceipt(command, atEpochMs);
                if (execution.source !== 'write') continue;
                const snapshot = await repositoryFor(runtimeRepository).readSnapshot(
                    command.aggregateRef,
                );
                if (!snapshot) continue;
                results.push({
                    status: 'ok',
                    result: Either.ofRight({
                        snapshot,
                        event: execution.event,
                    }),
                });
            }
            return results;
        },
    };

    return withClientStateServiceTiming(
        service,
        dependencies.timing,
        dependencies.serviceId,
    );
}

async function readClientReceiptEvent(
    repository: ClientStateRepository,
    ref: ClientPrincipalRef,
    eventId: string | null,
): Promise<ClientEvent | null> {
    if (eventId === null) return null;
    const event = (await repository.listEvents(ref))
        .find((candidate) => candidate.eventId === eventId);
    if (!event) {
        throw new ClientMutationRejectedError(
            `Client mutation receipt event not found: ${eventId}`,
        );
    }
    return event;
}

async function readClientMutation(
    repository: ClientStateRepository,
    command: ClientMutationCommand,
): Promise<ClientMutationRead> {
    const instanceRef = 'clientInstanceId' in command
        ? { ...command.aggregateRef, clientInstanceId: command.clientInstanceId }
        : null;
    const sessionRef = instanceRef && 'sessionId' in command
        ? { ...instanceRef, sessionId: command.sessionId }
        : null;
    const [idempotency, principal, instance, session] = await Promise.all([
        command.requestId === null
            ? Promise.resolve(undefined)
            : repository.findIdempotentClientMutationReceiptEntry(
                command.aggregateRef,
                command.requestId,
            ),
        repository.findPrincipalEntry(command.aggregateRef),
        instanceRef
            ? repository.findInstanceEntry(instanceRef)
            : Promise.resolve(undefined),
        sessionRef
            ? repository.findSessionEntry(sessionRef)
            : Promise.resolve(undefined),
    ]);
    return {
        idempotency: idempotency ?? null,
        principal: principal ?? null,
        instance: instance ?? null,
        session: session ?? null,
    };
}

async function writeClientMutation(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    repositoryFor: (
        runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => ClientStateRepository,
    computed: Extract<ClientMutationComputed, { outcome: 'write' }>,
): Promise<ClientMutationReceipt> {
    return await runtime.begin(async (transaction) => {
        const repository = repositoryFor(transaction);

        // Aggregate ownership must be the first database statement.
        requireConditionalWrite(computed.principal.operation === 'insert'
            ? await repository.insertPrincipal(computed.principal.value)
            : await repository.updatePrincipal(
                computed.principal.value,
                computed.principal.expectedRevision,
            ));

        await writeChildCandidate(repository, computed.instance, 'instance');
        await writeChildCandidate(repository, computed.session, 'session');

        if (computed.idempotency) {
            requireConditionalWrite(
                await repository.insertIdempotentClientStateWritten(
                    computed.outbox.aggregateRef,
                    computed.idempotency.requestId,
                    computed.idempotency,
                ),
            );
        }

        await new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite(
            createStateMutationOutboxRecord(computed.outbox),
        );
        await repository.appendEvent(computed.event);
        return computed.receipt;
    });
}

async function writeChildCandidate(
    repository: ClientStateRepository,
    candidate: Extract<ClientMutationComputed, { outcome: 'write' }>['instance'] |
        Extract<ClientMutationComputed, { outcome: 'write' }>['session'],
    kind: 'instance' | 'session',
): Promise<void> {
    if (candidate.operation === 'none') return;
    if (kind === 'instance') {
        const value = candidate.value as Parameters<ClientStateRepository['insertInstance']>[0];
        requireConditionalWrite(candidate.operation === 'insert'
            ? await repository.insertInstance(value)
            : await repository.updateInstance(value, candidate.expectedRevision));
        return;
    }
    const value = candidate.value as Parameters<ClientStateRepository['insertSession']>[0];
    requireConditionalWrite(candidate.operation === 'insert'
        ? await repository.insertSession(value)
        : await repository.updateSession(value, candidate.expectedRevision));
}

function toUpsertPrincipalCommand(
    scope: StateScope,
    principalId: string,
    request: UpsertClientPrincipalRequest,
    randomId: () => string,
): ClientMutationCommand {
    const commandId = request.requestId ?? randomId();
    return {
        operation: 'upsertPrincipal',
        aggregateRef: { ...scope, principalId },
        commandId,
        requestId: request.requestId ?? null,
        input: {
            username: request.username,
            displayName: request.displayName ?? null,
            avatarUrl: request.avatarUrl ?? null,
            status: request.status ?? null,
            authProvider: request.authProvider ?? null,
            externalSubjectId: request.externalSubjectId ?? null,
            roles: request.roles ? [...request.roles] : null,
            metadata: request.metadata ? structuredClone(request.metadata) : null,
            lastSeenAtEpochMs: request.lastSeenAtEpochMs ?? null,
            ...toActorInput(request),
        },
    };
}

function toUpsertInstanceCommand(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    request: UpsertClientInstanceRequest,
    randomId: () => string,
): ClientMutationCommand {
    const commandId = request.requestId ?? randomId();
    return {
        operation: 'upsertInstance',
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            status: request.status ?? null,
            platform: request.platform ?? null,
            deviceLabel: request.deviceLabel ?? null,
            appVersion: request.appVersion ?? null,
            userAgent: request.userAgent ?? null,
            capabilities: request.capabilities ? [...request.capabilities] : null,
            ...toActorInput(request),
        },
    };
}

function toConnectCommand(
    operation: 'connectSession' | 'connectAuthorisedWsSession',
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectClientSessionRequest,
    randomId: () => string,
    instance: Readonly<{
        platform?: ClientPlatform;
        userAgent?: string;
        capabilities?: readonly string[];
        principalUsername?: string;
        principalDisplayName?: string;
        principalRoles?: readonly string[];
    }>,
): ClientMutationCommand {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Connection generation id is required');
    }
    const commandId = request.requestId ?? randomId();
    return {
        operation,
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        sessionId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            generationId: request.generationId,
            presenceState: request.presenceState ?? null,
            transport: request.transport ?? null,
            connectionId: request.connectionId ?? null,
            authenticatedAtEpochMs: request.authenticatedAtEpochMs ?? null,
            connectedAtEpochMs: request.connectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            instancePlatform: instance.platform ?? null,
            instanceUserAgent: instance.userAgent ?? null,
            instanceCapabilities: instance.capabilities
                ? [...instance.capabilities]
                : null,
            principalUsername: instance.principalUsername ?? null,
            principalDisplayName: instance.principalDisplayName ?? null,
            principalRoles: instance.principalRoles
                ? [...instance.principalRoles]
                : null,
            ...toActorInput(request),
        },
    };
}

function toHeartbeatCommand(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatClientSessionRequest,
    randomId: () => string,
): ClientMutationCommand {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Heartbeat generation id is required');
    }
    const commandId = request.requestId ?? randomId();
    return {
        operation: 'heartbeatSession',
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        sessionId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            generationId: request.generationId,
            presenceState: request.presenceState ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toActorInput(request),
        },
    };
}

function toDisconnectCommand(
    operation: 'disconnectSession' | 'disconnectAuthorisedWsSession',
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: DisconnectClientSessionRequest,
    randomId: () => string,
): ClientMutationCommand {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Disconnect generation id is required');
    }
    const commandId = request.requestId ?? randomId();
    return {
        operation,
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        sessionId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            generationId: request.generationId,
            disconnectedAtEpochMs: request.disconnectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toActorInput(request),
        },
    };
}

function toExpiryCommand(session: ClientSessionExpiryCandidate): ClientMutationCommand {
    const commandId = [
        'expire-client-session',
        session.sessionId,
        session.generationId,
        session.generationVersion,
        session.observedExpiresAtEpochMs,
    ].join(':');
    return {
        operation: 'expireSession',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            principalId: session.principalId,
        },
        clientInstanceId: session.clientInstanceId,
        sessionId: session.sessionId,
        commandId,
        requestId: commandId,
        input: {
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.observedExpiresAtEpochMs,
            expiresAtEpochMs: session.observedExpiresAtEpochMs,
            actorPrincipalId: session.principalId,
            actorSessionId: session.sessionId,
            reason: 'expired',
            traceId: null,
        },
    };
}

function toActorInput(request: Readonly<{
    actorPrincipalId?: string;
    actorSessionId?: string;
    reason?: string;
    traceId?: string;
}>) {
    return {
        actorPrincipalId: request.actorPrincipalId ?? null,
        actorSessionId: request.actorSessionId ?? null,
        reason: request.reason ?? null,
        traceId: request.traceId ?? null,
    };
}

function toAuthorisedWsScope(input: RegisterAuthorisedWsClientInput): StateScope {
    return {
        applicationId: input.applicationId ?? DEFAULT_STATE_APPLICATION_ID,
        workspaceId: input.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
    };
}

async function findClientSessionBySessionId(
    repository: ClientStateRepository,
    sessionId: string,
): Promise<ClientSession | undefined> {
    const sessions = await repository.listAllSessions();
    return sessions.find((session) =>
        session.sessionId === sessionId && session.status === 'active' &&
        session.disconnectedAtEpochMs === undefined
    ) ?? sessions.find((session) => session.sessionId === sessionId);
}

function recordMutationPhase(
    dependencies: ClientStateServiceDependencies,
    command: ClientMutationCommand,
    phase: 'read' | 'compute' | 'validate' | 'write' | 'transaction',
    status: 'ok' | 'error',
    startedAt: number,
    attempt: number,
    backoffMs: number,
    error?: unknown,
): void {
    recordRallarTiming(dependencies.timing, {
        component: 'client-state-service',
        operation: `mutation.${phase}`,
        serviceId: dependencies.serviceId,
        requestId: command.requestId ?? undefined,
        ...command.aggregateRef,
        details: { attempt, backoffMs, mutationOperation: command.operation },
    }, status, nowMs() - startedAt, error);
}

function recordMutationConflict(
    dependencies: ClientStateServiceDependencies,
    command: ClientMutationCommand,
    attempt: number,
    backoffMs: number,
): void {
    recordRallarTiming(dependencies.timing, {
        component: 'client-state-service',
        operation: 'mutation.conflict',
        serviceId: dependencies.serviceId,
        requestId: command.requestId ?? undefined,
        ...command.aggregateRef,
        details: {
            attempt,
            backoffMs,
            conflict: true,
            mutationOperation: command.operation,
        },
    }, 'ok', 0);
}

function withClientStateServiceTiming(
    service: ClientStateService,
    timing: RallarTimingSink | undefined,
    serviceId: string,
): ClientStateService {
    if (!timing) return service;
    const timed = <T>(operation: string, details: Record<string, unknown>, action: () => Promise<T>) =>
        timeRallarAsync(timing, {
            component: 'client-state-service',
            operation,
            serviceId,
            requestId: typeof details.requestId === 'string' ? details.requestId : undefined,
            applicationId: typeof details.applicationId === 'string'
                ? details.applicationId : undefined,
            workspaceId: typeof details.workspaceId === 'string'
                ? details.workspaceId : undefined,
            principalId: typeof details.principalId === 'string'
                ? details.principalId : undefined,
            sessionId: typeof details.sessionId === 'string'
                ? details.sessionId : undefined,
        }, action);
    return {
        ...service,
        upsertPrincipal: (scope, principalId, request) => timed('upsertPrincipal', {
            ...scope, principalId, ...request, sessionId: request.actorSessionId,
        }, () => service.upsertPrincipal(scope, principalId, request)),
        upsertInstance: (scope, principalId, clientInstanceId, request) =>
            timed('upsertInstance', { ...scope, principalId, clientInstanceId, ...request },
                () => service.upsertInstance(scope, principalId, clientInstanceId, request)),
        connectSession: (scope, principalId, clientInstanceId, sessionId, request) =>
            timed('connectSession', {
                ...scope, principalId, clientInstanceId, sessionId, ...request,
            }, () => service.connectSession(scope, principalId, clientInstanceId, sessionId, request)),
        heartbeatSession: (scope, principalId, clientInstanceId, sessionId, request) =>
            timed('heartbeatSession', {
                ...scope, principalId, clientInstanceId, sessionId, ...request,
            }, () => service.heartbeatSession(scope, principalId, clientInstanceId, sessionId, request)),
        disconnectSession: (scope, principalId, clientInstanceId, sessionId, request) =>
            timed('disconnectSession', {
                ...scope, principalId, clientInstanceId, sessionId, ...request,
            }, () => service.disconnectSession(scope, principalId, clientInstanceId, sessionId, request)),
        registerAuthorisedWsClientSession: (auth, generationId, input) =>
            timed('registerAuthorisedWsClientSession', {
                requestId: auth.sessionId,
                applicationId: input?.applicationId,
                workspaceId: input?.workspaceId,
                principalId: input?.principalId ?? auth.clientId,
                sessionId: auth.sessionId,
                generationId,
            }, () => service.registerAuthorisedWsClientSession(
                auth,
                generationId,
                input,
            )),
        disconnectAuthorisedWsClientSession: (sessionId, generationId, reason) =>
            timed('disconnectAuthorisedWsClientSession', {
                sessionId,
                generationId,
                reason,
            }, () => service.disconnectAuthorisedWsClientSession(
                sessionId,
                generationId,
                reason,
            )),
        expireExpiredSessions: (atEpochMs) =>
            timed('expireExpiredSessions', { atEpochMs },
                () => service.expireExpiredSessions(atEpochMs)),
    };
}
