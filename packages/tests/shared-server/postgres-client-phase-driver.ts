import type { ConnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { createClientStateEventRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { AuthSessionRepository, type IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import {
    createClientStateService,
    requiresClientWrite,
    toClientMutationCommand,
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority,
    toConnectCommandInput,
    toExpiryCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import type {
    ClientMutationCommandInput,
    ClientMutationComputed,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

export type PostgresClientPhaseDriver = Readonly<{
    connectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: ConnectClientSessionRequest,
    ): Promise<ClientMutationComputed>;
    expireExpiredSessions(atEpochMs: number): Promise<readonly ClientMutationComputed[]>;
}>;

export type PostgresClientPhaseDriverOptions = Readonly<{
    sql: PSqlSql;
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    atEpochMs: number;
    serviceId: string;
    createClientStateEventStore?: (
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => ClientStateEventStore;
    writeComputed?: (computed: ClientMutationComputed) => Promise<void>;
}>;

export function createPostgresClientPhaseDriver(
    options: PostgresClientPhaseDriverOptions,
): PostgresClientPhaseDriver {
    const service = createClientStateService({
        runtimeRepository: options.runtimeRepository,
        createClientStateEventStore: options.createClientStateEventStore ??
            createClientStateEventRepository,
        serviceId: options.serviceId,
    });
    const execute = async (
        commandInput: ClientMutationCommandInput,
        authority: IssuedAuthSession | null,
    ): Promise<ClientMutationComputed> => {
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            const command = await toClientMutationCommand(
                commandInput,
                {
                    nowEpochMs: options.atEpochMs,
                    serviceId: options.serviceId,
                    eventId: `postgres-client-event:${commandInput.commandId}`,
                    attemptCount: attempt,
                    expireAtEpochMs: options.atEpochMs + 24 * 60 * 60 * 1_000,
                },
                commandInput.operation === 'expireSession'
                    ? toClientMutationSystemAuthority(options.serviceId)
                    : authority
                    ? toClientMutationIssuedSessionAuthority(
                        authority,
                        commandInput.aggregateRef,
                        commandInput.operation,
                    )
                    : missingPostgresClientAuthority(),
            );
            const read = await service.read(command);
            const computed = service.compute(command, read);
            service.validate(command, read, computed);
            try {
                if (requiresClientWrite(computed)) {
                    if (options.writeComputed) {
                        await options.writeComputed(computed);
                    } else {
                        await options.sql.begin(async (transaction) =>
                            await service.write(transaction, computed)
                        );
                    }
                }
                return computed;
            } catch (error) {
                if (!(error instanceof RuntimeStateWriteConflictError) || attempt === 8) {
                    throw error;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(16, 2 ** (attempt - 1)))
                );
            }
        }
        throw new Error('Postgres client AppInbox-equivalent attempts exhausted');
    };

    return {
        connectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            const authority: IssuedAuthSession = {
                clientId: principalId,
                accessToken: `${sessionId}-postgres-test-token`,
                username: principalId,
                sessionId,
                issuedAtEpochMs: Math.max(0, options.atEpochMs - 1),
                expiresAtEpochMs: options.atEpochMs + 24 * 60 * 60 * 1_000,
            };
            await new AuthSessionRepository(options.runtimeRepository).putSession(authority);
            return await execute(
                toConnectCommandInput(
                    'connectSession',
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                    request.requestId ?? `postgres-connect:${sessionId}`,
                    {},
                ),
                authority,
            );
        },
        expireExpiredSessions: async (expiryAtEpochMs) => {
            const written: ClientMutationComputed[] = [];
            for (const candidate of await service.listExpiredSessionCandidates(expiryAtEpochMs)) {
                const computed = await execute(toExpiryCommandInput(candidate), null);
                if (computed.outcome === 'write') written.push(computed);
            }
            return written;
        },
    };
}

function missingPostgresClientAuthority(): never {
    throw new Error('Issued client authority is required');
}
