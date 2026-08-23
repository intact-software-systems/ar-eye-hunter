import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { requiresClientWrite } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import {
    toClientMutationCommand,
    toConnectCommandInput,
    toExpiryCommandInput
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationCommandInput, ClientMutationComputed } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
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
    readonly writeComputed?: (computed: ClientMutationComputed) => Promise<void>;
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
            for (const candidate of await service.listExpiredSessionCandidates(atEpochMs)) {
                const computed = await execute(toExpiryCommandInput(candidate), null);
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
    return async (commandInput, authority) => {
        for (let attempt = 1; attempt <= 8; attempt += 1) {
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
            const computed = service.compute(command, read);
            service.validate(command, read, computed);
            try {
                await writePostgresClientMutation(options, service, computed);
                return computed;
            }
            catch (error) {
                if (!(error instanceof RuntimeStateWriteConflictError) || attempt === 8) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(16, 2 ** (attempt - 1))));
            }
        }
        throw new Error('Postgres client AppInbox-equivalent attempts exhausted');
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
        toConnectCommandInput(
            'connectSession',
            input.scope,
            input.principalId,
            input.clientInstanceId,
            input.sessionId,
            input.request,
            input.request.requestId ?? `postgres-connect:${input.sessionId}`,
            {}
        ),
        authority
    );
}

function missingPostgresClientAuthority(): never {
    throw new Error('Issued client authority is required');
}
