import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import {
    requiresClientWrite,
    toClientStateWritten,
    type ClientStateService,
    type ClientStateWritten
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import {
    timeClientStateMutationCommit,
    timeClientStateMutationPhase,
    type ClientStateMutationTiming
} from '@shared-server/rallar-system/client-state/client-state-service-timing.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationComputed } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import {
    ClientMutationIdempotencyConflictError,
    validateClientMutation
} from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { TestClientStateEventStore } from '@shared-test/shared-server/test-client-state-event-store.ts';

import type { ClientStatePhaseTestDriver } from './client-state-test-driver-contracts.ts';
import {
    createClientStateTestDriverOperations,
    type ClientStateTestMutationExecutor,
    type ClientStateTestOperationContext
} from './client-state-test-operations.ts';
import {
    captureClientStateTestOutbox,
    createClientStateTestTransaction,
    failNextClientStateTestOutboxWrite,
    getClientStateTestOutbox,
    restoreClientStateTestOutbox
} from './client-state-test-transaction.ts';

const TEST_AUTH_ISSUED_AT_EPOCH_MS = 0;
const TEST_AUTH_EXPIRES_AT_EPOCH_MS = 253_402_300_799_000;

type ClientMutationInput = Parameters<typeof toClientMutationCommand>[0];
interface ClientStateTestExecutorInput {
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly eventStore: TestClientStateEventStore;
    readonly authSessions: AuthSessionRepository;
    readonly service: ClientStateService;
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
    readonly nextSequence: () => number;
    readonly mutationTiming: ClientStateMutationTiming;
}

interface ClientStateTestDriverDependencies {
    readonly runtimeRepository: ClientStateTestRuntimeRepository;
    readonly now?: () => number;
    readonly serviceId: string;
    readonly timing?: RallarTimingSink;
}

type ClientStateTestRuntimeRepository =
    & RuntimeStateOptimisticTransactionalRepositoryLike
    & Readonly<{ clientStateEventStore: TestClientStateEventStore; }>;

export type { ClientStatePhaseTestDriver } from './client-state-test-driver-contracts.ts';
export { failNextClientStateTestOutboxWrite, getClientStateTestOutbox };

export function createClientStatePhaseTestDriver(
    runtimeRepository: ClientStateTestRuntimeRepository,
    nowEpochMs: () => number,
    options: Readonly<{ serviceId?: string; timing?: RallarTimingSink; }> = {}
): ClientStatePhaseTestDriver {
    const eventStore = runtimeRepository.clientStateEventStore;
    const serviceId = options.serviceId ?? 'client-service';
    const service = createClientStateService({
        runtimeRepository,
        clientStateEventStore: eventStore,
        serviceId,
        timing: options.timing
    });
    let commandSequence = 0;
    const context: ClientStateTestOperationContext = {
        service,
        execute: createClientStateTestMutationExecutor({
            runtimeRepository,
            eventStore,
            authSessions: new AuthSessionRepository(runtimeRepository),
            service,
            serviceId,
            nowEpochMs,
            mutationTiming: { sink: options.timing, serviceId },
            nextSequence: () => ++commandSequence
        }),
        nextId: () => `test-client-command-${++commandSequence}`
    };
    return createClientStateTestDriverOperations(context);
}

export function createClientStateTestDriver(
    dependencies: ClientStateTestDriverDependencies
): ClientStatePhaseTestDriver {
    return createClientStatePhaseTestDriver(
        dependencies.runtimeRepository,
        dependencies.now ?? Date.now,
        { serviceId: dependencies.serviceId, timing: dependencies.timing }
    );
}

function createClientStateTestMutationExecutor(
    input: ClientStateTestExecutorInput
): ClientStateTestMutationExecutor {
    const attemptsByCommandId = new Map<string, number>();
    return async (inputFactory) => {
        const commandInput = inputFactory();
        const attempt = (attemptsByCommandId.get(commandInput.commandId) ?? 0) + 1;
        attemptsByCommandId.set(commandInput.commandId, attempt);
        try {
            const computed = await computeClientStateTestMutation(input, commandInput, attempt);
            if (requiresClientWrite(computed)) {
                await writeClientStateTestMutation(input, computed);
            }
            if (computed.outcome === 'idempotency-conflict') {
                throw new ClientMutationIdempotencyConflictError(
                    commandInput.commandId,
                    computed.existingCommandHash,
                    computed.receivedCommandHash
                );
            }
            attemptsByCommandId.delete(commandInput.commandId);
            return toClientStateWritten(computed);
        }
        catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) {
                attemptsByCommandId.delete(commandInput.commandId);
            }
            throw error;
        }
    };
}

async function computeClientStateTestMutation(
    context: ClientStateTestExecutorInput,
    input: ClientMutationInput,
    attempt: number
): Promise<ClientMutationComputed> {
    const authority = await toTestAuthority(context.authSessions, input, context.serviceId);
    const command = await toClientMutationCommand(
        input,
        {
            nowEpochMs: context.nowEpochMs(),
            serviceId: context.serviceId,
            eventId: `test-client-event:${input.commandId}:${context.nextSequence()}`,
            attemptCount: attempt,
            expireAtEpochMs: TEST_AUTH_EXPIRES_AT_EPOCH_MS
        },
        authority
    );
    const read = await context.service.read(command);
    const computed = timeClientStateMutationPhase(
        { timing: context.mutationTiming, command, operation: 'mutation.compute' },
        () => computeClientMutation({ command, read })
    );
    timeClientStateMutationPhase(
        { timing: context.mutationTiming, command, operation: 'mutation.validate' },
        () => {
            const issue = validateClientMutation({ command, read, computed })[0];
            if (issue !== undefined) {
                throw issue.cause;
            }
        }
    );
    return computed;
}

async function writeClientStateTestMutation(
    context: ClientStateTestExecutorInput,
    computed: Parameters<ClientStateService['write']>[1]
): Promise<void> {
    await timeClientStateMutationCommit(
        { timing: context.mutationTiming, writes: [computed] },
        async () =>
            await context.runtimeRepository.begin(async (runtime) => {
                const outboxBefore = captureClientStateTestOutbox(context.runtimeRepository);
                const eventsBefore = [...context.eventStore.events];
                try {
                    await context.service.write(
                        createClientStateTestTransaction({
                            runtime,
                            runtimeRepository: context.runtimeRepository,
                            eventStore: context.eventStore
                        }),
                        computed
                    );
                }
                catch (error) {
                    restoreClientStateTestOutbox(context.runtimeRepository, outboxBefore);
                    context.eventStore.events.length = 0;
                    context.eventStore.events.push(...eventsBefore);
                    throw error;
                }
            })
    );
}

async function toTestAuthority(
    authSessions: AuthSessionRepository,
    input: ClientMutationInput,
    serviceId: string
) {
    if (input.operation === 'expireSession') {
        return toClientMutationSystemAuthority(serviceId);
    }
    const sessionId = 'sessionId' in input
        ? input.sessionId
        : (input.input.actorSessionId ?? `${input.aggregateRef.principalId}-test-authority-session`);
    const existing = await authSessions.findBySessionId(sessionId);
    if (existing) {
        return toClientMutationIssuedSessionAuthority(existing, input.aggregateRef, input.operation);
    }
    const session: IssuedAuthSession = {
        clientId: input.aggregateRef.principalId,
        accessToken: `${sessionId}-test-token`,
        username: input.aggregateRef.principalId,
        sessionId,
        issuedAtEpochMs: TEST_AUTH_ISSUED_AT_EPOCH_MS,
        expiresAtEpochMs: TEST_AUTH_EXPIRES_AT_EPOCH_MS
    };
    await authSessions.putSession(session);
    return toClientMutationIssuedSessionAuthority(session, input.aggregateRef, input.operation);
}
