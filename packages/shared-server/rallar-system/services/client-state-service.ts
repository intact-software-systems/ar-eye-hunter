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
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { requireConditionalWrite } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ClientStateRepository,
    createTransactionBoundClientStateRepository,
} from '../repositories/ClientStateRepository.ts';
import {
    type ClientSessionExpiryCandidate,
    toClientSessionExpiryCandidate,
} from '../repositories/session-expiry.ts';
import type { ClientStateEventStore } from '../repositories/StateEventStore.ts';
import { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import type { IssuedAuthSession } from '../repositories/auth-session-types.ts';
import type { PersistedAuthSession } from '../repositories/auth-persistence-contracts.ts';
import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import {
    assertNeverClientMutationComputed,
    type ClientMutationAuthority,
    type ClientMutationCommand,
    type ClientMutationCommandInput,
    type ClientMutationComputed,
    type ClientMutationComputedWrite,
    type ClientMutationFacts,
    ClientMutationIdempotencyConflictError,
    type ClientMutationIssuedSessionAuthority,
    type ClientMutationOperation,
    type ClientMutationRead,
    type ClientMutationReceipt,
    ClientMutationRejectedError,
    type ClientMutationSystemAuthority,
    computeClientMutation,
    validateClientMutation,
    validateClientMutationCommand,
} from './client-state-mutations.ts';
import { nowMs, type RallarTimingSink, recordRallarTiming, timeRallarAsync } from './timing.ts';
import {
    createWsSessionGenerationLifecycleService,
    type WsSessionGenerationLifecycleService,
} from './ws-session-generation-lifecycle.ts';

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
    sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    listSnapshots(scope: ClientScope): Promise<readonly ClientSnapshot[]>;
    readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    readPresenceSnapshot(ref: ClientPrincipalRef): Promise<ClientPresenceSnapshot | undefined>;
    listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
    listRecentEvents?(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
    ): Promise<readonly ClientEvent[]>;
    listEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
    ): Promise<StateEventPage<ClientEvent>>;
    read(command: ClientMutationCommand): Promise<ClientMutationRead>;
    compute(command: ClientMutationCommand, read: ClientMutationRead): ClientMutationComputed;
    validate(
        command: ClientMutationCommand,
        read: ClientMutationRead,
        computed: ClientMutationComputed,
    ): void;
    write(
        transaction: PSqlTransactionSql,
        computed: ClientMutationComputedWrite,
    ): Promise<ClientMutationReceipt>;
    listExpiredSessionCandidates(
        atEpochMs: number,
    ): Promise<readonly ClientSessionExpiryCandidate[]>;
    findSessionBySessionId(sessionId: string): Promise<ClientSession | undefined>;
    readIssuedAuthSession(sessionId: string): Promise<PersistedAuthSession | undefined>;
    observeSnapshot(snapshot: ClientSnapshot): Promise<ClientSnapshot>;
}>;

export type ClientStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    createClientStateEventStore?: (
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => ClientStateEventStore;
    serviceId: string;
    timing?: RallarTimingSink;
}>;
export function createClientStateService(
    dependencies: ClientStateServiceDependencies,
): ClientStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const authSessionRepository = new AuthSessionRepository(runtimeRepository);
    const repositoryFor = (runtime: RuntimeStateOptimisticTransactionalRepositoryLike) =>
        new ClientStateRepository(runtime, {
            events: dependencies.createClientStateEventStore?.(runtime),
        });
    const service: ClientStateService = {
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtimeRepository),
        listSnapshots: async (scope) => await repositoryFor(runtimeRepository).listSnapshots(scope),
        readSnapshot: async (ref) => await repositoryFor(runtimeRepository).readSnapshot(ref),
        readPresenceSnapshot: async (ref) =>
            await repositoryFor(runtimeRepository).readPresenceSnapshot(ref),
        listEvents: async (ref) => await repositoryFor(runtimeRepository).listEvents(ref),
        listRecentEvents: async (ref, query) =>
            await repositoryFor(runtimeRepository).listRecentEvents(ref, query),
        listEventPage: async (ref, query) =>
            await repositoryFor(runtimeRepository).listEventPage(ref, query),
        read: async (command) =>
            await readClientMutation(
                repositoryFor(runtimeRepository),
                authSessionRepository,
                command,
            ),
        compute: (command, read) => computeClientMutation({ command, read }),
        validate: (command, read, computed) => validateClientMutation({ command, read, computed }),
        write: async (transaction, computed) => {
            const repository = createTransactionBoundClientStateRepository(transaction);
            return await writeClientMutation(transaction, repository, computed);
        },
        listExpiredSessionCandidates: async (atEpochMs) =>
            (await repositoryFor(runtimeRepository).listAllSessions())
                .filter(
                    (session) =>
                        session.status === 'active' &&
                        session.disconnectedAtEpochMs === null &&
                        session.expiresAtEpochMs <= atEpochMs,
                )
                .map(toClientSessionExpiryCandidate),
        findSessionBySessionId: async (sessionId) =>
            await findClientSessionBySessionId(repositoryFor(runtimeRepository), sessionId),
        readIssuedAuthSession: async (sessionId) =>
            await authSessionRepository.findBySessionId(sessionId),
        observeSnapshot: (snapshot) => Promise.resolve(snapshot),
    };

    return withClientStateServiceTiming(service, dependencies.timing, dependencies.serviceId);
}

async function readClientMutation(
    repository: ClientStateRepository,
    authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>,
    command: ClientMutationCommand,
): Promise<ClientMutationRead> {
    const instanceRef =
        'clientInstanceId' in command
            ? {
                  ...command.aggregateRef,
                  clientInstanceId: command.clientInstanceId,
              }
            : null;
    const sessionRef =
        instanceRef && 'sessionId' in command
            ? { ...instanceRef, sessionId: command.sessionId }
            : null;
    const [authoritySession, idempotency, principal, instance, session, snapshot] =
        await Promise.all([
            command.authority.kind === 'issued-session'
                ? authSessionRepository.findBySessionId(command.authority.sessionId)
                : Promise.resolve(undefined),
            command.requestId === null
                ? Promise.resolve(undefined)
                : repository.findIdempotentClientMutationReceiptEntry(
                      command.aggregateRef,
                      command.requestId,
                  ),
            repository.findPrincipalEntry(command.aggregateRef),
            instanceRef ? repository.findInstanceEntry(instanceRef) : Promise.resolve(undefined),
            sessionRef ? repository.findSessionEntry(sessionRef) : Promise.resolve(undefined),
            repository.readSnapshot(command.aggregateRef),
        ]);
    const receiptEvent =
        !idempotency || idempotency.value.receipt.eventId === null
            ? null
            : ((await repository.listEvents(command.aggregateRef)).find(
                  (event) => event.eventId === idempotency.value.receipt.eventId,
              ) ?? null);
    if (idempotency && idempotency.value.receipt.eventId !== null && !receiptEvent) {
        throw new ClientMutationRejectedError(
            `Client mutation receipt event not found: ${idempotency.value.receipt.eventId}`,
        );
    }
    return {
        authoritySession: authoritySession ?? null,
        idempotency: idempotency ?? null,
        principal: principal ?? null,
        instance: instance ?? null,
        session: session ?? null,
        snapshot: snapshot ?? null,
        receiptEvent,
    };
}

async function writeClientMutation(
    transaction: PSqlTransactionSql,
    repository: ClientStateRepository,
    computed: ClientMutationComputedWrite,
): Promise<ClientMutationReceipt> {
    if (computed.outcome === 'no-op') {
        requireConditionalWrite(
            await repository.insertIdempotentClientStateWritten(
                computed.aggregateRef,
                computed.idempotency.requestId,
                computed.idempotency,
            ),
        );
        return computed.receipt;
    }

    // Aggregate ownership must be the first database statement.
    requireConditionalWrite(
        computed.principal.operation === 'insert'
            ? await repository.insertPrincipal(computed.principal.value)
            : await repository.updatePrincipal(
                  computed.principal.value,
                  computed.principal.expectedRevision,
              ),
    );

    await writeChildCandidate(repository, computed.instance, 'instance');
    await writeChildCandidate(repository, computed.session, 'session');

    if (computed.idempotency) {
        requireConditionalWrite(
            await repository.insertIdempotentClientStateWritten(
                computed.receipt.aggregateRef,
                computed.idempotency.requestId,
                computed.idempotency,
            ),
        );
    }

    await repository.appendEvent(computed.event);
    const outbox = new ResourceInboxRepository(transaction);
    for (const entry of computed.outboxEntries) {
        await outbox.writeIfAbsentOrMatch(entry);
    }
    return computed.receipt;
}

async function writeChildCandidate(
    repository: ClientStateRepository,
    candidate:
        | Extract<ClientMutationComputedWrite, { outcome: 'write' }>['instance']
        | Extract<ClientMutationComputedWrite, { outcome: 'write' }>['session'],
    kind: 'instance' | 'session',
): Promise<void> {
    if (candidate.operation === 'none') return;
    if (kind === 'instance') {
        const value = candidate.value as Parameters<ClientStateRepository['insertInstance']>[0];
        requireConditionalWrite(
            candidate.operation === 'insert'
                ? await repository.insertInstance(value)
                : await repository.updateInstance(value, candidate.expectedRevision),
        );
        return;
    }
    const value = candidate.value as Parameters<ClientStateRepository['insertSession']>[0];
    requireConditionalWrite(
        candidate.operation === 'insert'
            ? await repository.insertSession(value)
            : await repository.updateSession(value, candidate.expectedRevision),
    );
}

export type ClientMutationPersistedFacts = Omit<ClientMutationFacts, 'commandHash'>;

export async function toClientMutationCommand(
    input: ClientMutationCommandInput,
    facts: ClientMutationPersistedFacts,
    authority: ClientMutationAuthority,
): Promise<ClientMutationCommand> {
    const command = {
        ...input,
        authority,
        facts: {
            ...facts,
            commandHash: await hashStateMutationCommand({
                ...input,
                authority,
            }),
        },
    } as ClientMutationCommand;
    validateClientMutationCommand(command);
    return command;
}

export function toClientMutationIssuedSessionAuthority(
    session: IssuedAuthSession | PersistedAuthSession,
    scope: StateScope,
    operation: Exclude<ClientMutationOperation, 'expireSession'>,
): ClientMutationIssuedSessionAuthority {
    return {
        kind: 'issued-session',
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        operation,
    };
}

export function toClientMutationSystemAuthority(serviceId: string): ClientMutationSystemAuthority {
    return {
        kind: 'system',
        version: 1,
        serviceId,
        operation: 'expireSession',
    };
}

export function requiresClientWrite(
    computed: ClientMutationComputed,
): computed is ClientMutationComputedWrite {
    switch (computed.outcome) {
        case 'write':
            return true;
        case 'no-op':
            return computed.persistIdempotency;
        case 'replay':
        case 'idempotency-conflict':
            return false;
        default:
            return assertNeverClientMutationComputed(computed);
    }
}

export function toClientMutationReceipt(
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict' }>,
): ClientMutationReceipt {
    return computed.receipt;
}

export function toClientStateWritten(
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict' }>,
): ClientStateWritten {
    switch (computed.outcome) {
        case 'write':
        case 'no-op':
        case 'replay':
            break;
        default:
            return assertNeverClientMutationComputed(computed);
    }
    return {
        status: 'ok',
        result: Either.ofRight({
            snapshot: computed.snapshot,
            event: computed.event,
        }),
    };
}

export function toUpsertPrincipalCommandInput(
    scope: StateScope,
    principalId: string,
    request: UpsertClientPrincipalRequest,
    fallbackCommandId: string,
): ClientMutationCommandInput {
    const commandId = request.requestId ?? fallbackCommandId;
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

export function toUpsertInstanceCommandInput(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    request: UpsertClientInstanceRequest,
    fallbackCommandId: string,
): ClientMutationCommandInput {
    const commandId = request.requestId ?? fallbackCommandId;
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

export function toConnectCommandInput(
    operation: 'connectSession' | 'connectAuthorisedWsSession',
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectClientSessionRequest,
    fallbackCommandId: string,
    instance: Readonly<{
        platform?: ClientPlatform;
        userAgent?: string;
        capabilities?: readonly string[];
        principalUsername?: string;
        principalDisplayName?: string;
        principalRoles?: readonly string[];
    }>,
): ClientMutationCommandInput {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Connection generation id is required');
    }
    const commandId = request.requestId ?? fallbackCommandId;
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
            instanceCapabilities: instance.capabilities ? [...instance.capabilities] : null,
            principalUsername: instance.principalUsername ?? null,
            principalDisplayName: instance.principalDisplayName ?? null,
            principalRoles: instance.principalRoles ? [...instance.principalRoles] : null,
            ...toActorInput(request),
        },
    };
}

export function toHeartbeatCommandInput(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatClientSessionRequest,
    fallbackCommandId: string,
): ClientMutationCommandInput {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Heartbeat generation id is required');
    }
    const commandId = request.requestId ?? fallbackCommandId;
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

export function toDisconnectCommandInput(
    operation: 'disconnectSession' | 'disconnectAuthorisedWsSession',
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: DisconnectClientSessionRequest,
    fallbackCommandId: string,
): ClientMutationCommandInput {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Disconnect generation id is required');
    }
    const commandId = request.requestId ?? fallbackCommandId;
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

export function toExpiryCommandInput(
    session: ClientSessionExpiryCandidate,
): Extract<ClientMutationCommandInput, { operation: 'expireSession' }> {
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

function toActorInput(
    request: Readonly<{
        actorPrincipalId?: string;
        actorSessionId?: string;
        reason?: string;
        traceId?: string;
    }>,
) {
    return {
        actorPrincipalId: request.actorPrincipalId ?? null,
        actorSessionId: request.actorSessionId ?? null,
        reason: request.reason ?? null,
        traceId: request.traceId ?? null,
    };
}

async function findClientSessionBySessionId(
    repository: ClientStateRepository,
    sessionId: string,
): Promise<ClientSession | undefined> {
    const sessions = await repository.listAllSessions();
    return (
        sessions.find(
            (session) =>
                session.sessionId === sessionId &&
                session.status === 'active' &&
                session.disconnectedAtEpochMs === null,
        ) ?? sessions.find((session) => session.sessionId === sessionId)
    );
}

function withClientStateServiceTiming(
    service: ClientStateService,
    timing: RallarTimingSink | undefined,
    serviceId: string,
): ClientStateService {
    if (!timing) return service;
    const timed = <T>(
        operation: string,
        details: Record<string, unknown>,
        action: () => Promise<T>,
    ) =>
        timeRallarAsync(
            timing,
            {
                component: 'client-state-service',
                operation,
                serviceId,
                requestId: typeof details.requestId === 'string' ? details.requestId : undefined,
                applicationId:
                    typeof details.applicationId === 'string' ? details.applicationId : undefined,
                workspaceId:
                    typeof details.workspaceId === 'string' ? details.workspaceId : undefined,
                principalId:
                    typeof details.principalId === 'string' ? details.principalId : undefined,
                sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
            },
            action,
        );
    const timedSync = <T>(
        operation: string,
        command: ClientMutationCommand,
        action: () => T,
    ): T => {
        const startedAt = nowMs();
        try {
            const result = action();
            recordRallarTiming(
                timing,
                mutationTiming(operation, command, serviceId),
                'ok',
                nowMs() - startedAt,
            );
            return result;
        } catch (error) {
            recordRallarTiming(
                timing,
                mutationTiming(operation, command, serviceId),
                'error',
                nowMs() - startedAt,
                error,
            );
            throw error;
        }
    };
    return {
        ...service,
        read: (command) =>
            timed(
                'mutation.read',
                {
                    ...command.aggregateRef,
                    requestId: command.requestId,
                },
                () => service.read(command),
            ),
        compute: (command, read) =>
            timedSync('mutation.compute', command, () => service.compute(command, read)),
        validate: (command, read, computed) =>
            timedSync('mutation.validate', command, () =>
                service.validate(command, read, computed),
            ),
        write: (transaction, computed) =>
            timed(
                'mutation.write',
                {
                    ...computed.receipt.aggregateRef,
                    requestId: computed.receipt.requestId,
                },
                () => service.write(transaction, computed),
            ),
    };
}

function mutationTiming(operation: string, command: ClientMutationCommand, serviceId: string) {
    return {
        component: 'client-state-service',
        operation,
        serviceId,
        requestId: command.requestId ?? undefined,
        ...command.aggregateRef,
        details: {
            attempt: command.facts.attemptCount,
            mutationOperation: command.operation,
        },
    };
}
