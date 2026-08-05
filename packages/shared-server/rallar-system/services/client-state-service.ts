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
import { StateSnapshotReadConflictError } from '../repositories/state-snapshot-read.ts';
import {
    type ClientSessionExpiryCandidate,
    toClientSessionExpiryCandidate,
} from '../repositories/session-expiry.ts';
import type { ClientStateEventStore } from '../repositories/StateEventStore.ts';
import { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import type { PersistedAuthSession } from '../repositories/auth-persistence-contracts.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import { computeClientMutation } from '../client-state/mutation/compute/compute-client-mutation.ts';
import {
    assertNeverClientMutationComputed,
} from '../client-state/mutation/compute/compute-client-mutation-result.ts';
import {
    ClientMutationIdempotencyConflictError,
    validateClientMutation,
} from '../client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationRejectedError } from '../client-state/client-state-validation-primitives.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationComputedWrite,
    ClientMutationRead,
    ClientMutationReceipt,
} from '../client-state/mutation/client-mutation-contracts.ts';
import {
    toClientMutationCommand,
    toConnectCommandInput,
    toDisconnectCommandInput,
    toExpiryCommandInput,
    toHeartbeatCommandInput,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput,
} from '../client-state/mutation/client-mutation-command.ts';
export {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority,
} from '../client-state/mutation/client-mutation-authority.ts';
import { nowMs, type RallarTimingSink, recordRallarTiming, timeRallarAsync } from './timing.ts';
import {
    createWsSessionGenerationLifecycleService,
    type WsSessionGenerationLifecycleService,
} from './ws-session-generation-lifecycle.ts';

export { ClientMutationIdempotencyConflictError, ClientMutationRejectedError };
export type { ClientMutationReceipt };
// prettier-ignore
export type {
  ClientMutationPersistedFacts,
} from '../client-state/mutation/client-mutation-command.ts';
export {
    toClientMutationCommand,
    toConnectCommandInput,
    toDisconnectCommandInput,
    toExpiryCommandInput,
    toHeartbeatCommandInput,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput,
} from '../client-state/mutation/client-mutation-command.ts';
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
    const [authoritySession, idempotency, principalSnapshot, instance, sessionRead] =
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
            repository.readPrincipalSnapshot(command.aggregateRef),
            instanceRef ? repository.findInstanceEntry(instanceRef) : Promise.resolve(undefined),
            sessionRef ? repository.readSessionEntry(sessionRef) : Promise.resolve({ value: undefined, expiredEntry: undefined }),
        ]);
    if (
        principalSnapshot &&
        principalSnapshot.snapshot.stateRevision !==
            principalSnapshot.principal.entry.revision + 1
    ) {
        throw new StateSnapshotReadConflictError(principalSnapshot.principal.entry.key);
    }
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
        principal: principalSnapshot?.principal ?? null,
        instance: instance ?? null,
        session: sessionRead.value ?? null,
        expiredSessionEntry: sessionRead.expiredEntry ?? null,
        snapshot: principalSnapshot?.snapshot ?? null,
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
