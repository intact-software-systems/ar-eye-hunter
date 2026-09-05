import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { requiresClientWrite } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type {
    ClientMutationCommandInput,
    ClientMutationComputed,
    ClientMutationComputedWrite
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toConnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import {
    assertClientMutationComputed,
    ClientMutationIdempotencyConflictError,
    validateClientMutation
} from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ConnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';

export type PostgresClientPhaseDriver = Readonly<{
    connectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: ConnectClientSessionRequest
    ): Promise<ClientMutationComputed>;
    expireExpiredSessions(atEpochMs: number): Promise<readonly ClientMutationComputed[]>;
}>;

export interface PostgresClientPhaseDriverOptions {
    readonly sql: PSqlSql;
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly atEpochMs: number;
    readonly serviceId: string;
    readonly clientStateEventStore?: ClientStateEventStore;
    readonly writeComputed?: (computed: ClientMutationComputedWrite) => Promise<void>;
}

type PostgresClientMutationExecutor = (
    commandInput: ClientMutationCommandInput,
    authority: IssuedAuthSession | null
) => Promise<ClientMutationComputed>;

interface ConnectPostgresClientSessionInput {
    readonly options: PostgresClientPhaseDriverOptions;
    readonly execute: PostgresClientMutationExecutor;
    readonly scope: StateScope;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly request: ConnectClientSessionRequest;
}

export function createPostgresClientPhaseDriver(
    options: PostgresClientPhaseDriverOptions
): PostgresClientPhaseDriver {
    const service = createClientStateService({
        runtimeRepository: options.runtimeRepository,
        clientStateEventStore: options.clientStateEventStore ?? new PSqlClientStateEventRepository(options.sql),
        serviceId: options.serviceId
    });
    const execute = createPostgresClientMutationExecutor(options, service);
    return {
        connectSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await connectPostgresClientSession({
                options,
                execute,
                scope,
                principalId,
                clientInstanceId,
                sessionId,
                request
            }),
        expireExpiredSessions: async (atEpochMs) => {
            const written: ClientMutationComputed[] = [];
            const page = await service.readExpiredSessionPage({ atEpochMs, afterKey: null });
            if (page.nextAfterKey !== null) {
                throw new Error('Postgres client test expiry exceeds one bounded page');
            }
            for (const candidate of page.candidates) {
                const computed = await execute(toExpireClientSessionMutationInput(candidate), null);
                if (computed.outcome === 'write') {
                    written.push(computed);
                }
            }
            return written;
        }
    };
}

function createPostgresClientMutationExecutor(
    options: PostgresClientPhaseDriverOptions,
    service: ReturnType<typeof createClientStateService>
): PostgresClientMutationExecutor {
    const attemptsByCommandId = new Map<string, number>();
    return async (commandInput, authority) => {
        const attempt = (attemptsByCommandId.get(commandInput.commandId) ?? 0) + 1;
        attemptsByCommandId.set(commandInput.commandId, attempt);
        try {
            const command = await toClientMutationCommand(
                commandInput,
                {
                    nowEpochMs: options.atEpochMs,
                    serviceId: options.serviceId,
                    eventId: `postgres-client-event:${commandInput.commandId}`,
                    attemptCount: attempt,
                    expireAtEpochMs: options.atEpochMs + 24 * 60 * 60 * 1_000
                },
                commandInput.operation === 'expireSession'
                    ? toClientMutationSystemAuthority(options.serviceId)
                    : authority
                    ? toClientMutationIssuedSessionAuthority(
                        authority,
                        commandInput.aggregateRef,
                        commandInput.operation
                    )
                    : missingPostgresClientAuthority()
            );
            const read = await service.read(command);
            const computed = computeClientMutation({ command, read });
            assertClientMutationComputed({ command, read, computed });
            const issue = validateClientMutation({ command, read })[0];
            if (issue !== undefined) {
                throw issue.cause;
            }
            if (computed.outcome === 'idempotency-conflict') {
                throw new ClientMutationIdempotencyConflictError(
                    command.commandId,
                    computed.existingCommandHash,
                    computed.receivedCommandHash
                );
            }
            await writePostgresClientMutation(options, service, computed);
            attemptsByCommandId.delete(commandInput.commandId);
            return computed;
        }
        catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) {
                attemptsByCommandId.delete(commandInput.commandId);
            }
            throw error;
        }
    };
}

async function writePostgresClientMutation(
    options: PostgresClientPhaseDriverOptions,
    service: ReturnType<typeof createClientStateService>,
    computed: ClientMutationComputed
): Promise<void> {
    if (!requiresClientWrite(computed)) {
        return;
    }
    if (options.writeComputed) {
        await options.writeComputed(computed);
        return;
    }
    await options.sql.begin(async (transaction) => await service.write(transaction, computed));
}

async function connectPostgresClientSession(
    input: ConnectPostgresClientSessionInput
): Promise<ClientMutationComputed> {
    const authority: IssuedAuthSession = {
        clientId: input.principalId,
        accessToken: `${input.sessionId}-postgres-test-token`,
        username: input.principalId,
        sessionId: input.sessionId,
        issuedAtEpochMs: Math.max(0, input.options.atEpochMs - 1),
        expiresAtEpochMs: input.options.atEpochMs + 24 * 60 * 60 * 1_000
    };
    await new AuthSessionRepository(input.options.runtimeRepository).putSession(authority);
    return await input.execute(
        toConnectClientSessionMutationInput({
            operation: 'connectSession',
            scope: input.scope,
            principalId: input.principalId,
            clientInstanceId: input.clientInstanceId,
            sessionId: input.sessionId,
            request: input.request,
            defaultCommandId: input.request.requestId ?? `postgres-connect:${input.sessionId}`,
            identityDefaults: {}
        }),
        authority
    );
}

function missingPostgresClientAuthority(): never {
    throw new Error('Issued client authority is required');
}
