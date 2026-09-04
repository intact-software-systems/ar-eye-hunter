import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AppInboxExecutionMetadata, AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import {
    validateWsSessionConnectGuard,
    validateWsSessionGenerationClosed,
    type WsSessionGenerationFacts,
    type WsSessionGenerationLifecycleComputed
} from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import {
    requiresClientWrite,
    toClientStateWritten,
    type ClientStateMutationService,
    type ClientStateService,
    type ClientStateWritten
} from '../client-state-service-contracts.ts';
import {
    timeClientStateMutationCommit,
    timeClientStateMutationPhase,
    type ClientStateMutationTiming
} from '../client-state-service-timing.ts';
import { toClientMutationCommand, type ClientMutationPersistedFacts } from '../mutation/client-mutation-command.ts';
import type {
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputed
} from '../mutation/client-mutation-contracts.ts';
import { toConnectClientSessionMutationInput } from '../mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toDisconnectClientSessionMutationInput } from '../mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '../mutation/command-input/to-expire-client-session-mutation-input.ts';
import { validateClientMutationAuthorityPolicy } from '../mutation/result-validation/validate-client-mutation-authority-policy.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload
} from './app-client-inbox-contracts.ts';
import { readClientMutationAuthority } from './authenticated-client-mutation-ingress.ts';
import type {
    AuthorisedWsClientMutationResult,
    InactiveAuthorisedWsSessionResult
} from './client-state-inbox-result-codec.ts';

export interface ClientStateInboxHandlerDependencies {
    readonly mutationService: ClientStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly expiryCandidates: Pick<ClientStateService, 'listExpiredSessionCandidates'>;
    readonly snapshotObserver: Pick<ClientStateService, 'observeSnapshot'>;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly mutationTiming: ClientStateMutationTiming;
    readonly serviceId: string;
}

interface WriteMissingSessionDisconnectInput {
    readonly context: AppInboxMessageContext<AuthorisedWsClientMutationResult>;
    readonly disconnect: ClientAuthorisedWsSessionDisconnectAppInboxPayload;
    readonly command: ClientMutationCommand;
    readonly read: Awaited<ReturnType<ClientStateMutationService['read']>>;
    readonly lifecycleComputed: WsSessionGenerationLifecycleComputed;
}

export class ClientStateInboxHandler {
    private readonly dependencies: ClientStateInboxHandlerDependencies;

    constructor(dependencies: ClientStateInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async processCommand(
        context: AppInboxMessageContext<ClientStateWritten>,
        input: ClientMutationCommandInput
    ): Promise<ClientStateWritten> {
        const command = await this.toCommand(context, input);
        const read = await this.dependencies.mutationService.read(command);
        const computed = this.computeMutation(command, read);
        this.validateMutation(command, read, computed);
        return await this.commitComputed(context, computed);
    }

    async processAuthorisedWsConnect(
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>
    ): Promise<AuthorisedWsClientMutationResult> {
        const lifecycleFacts = toWsSessionGenerationFacts(connection);
        const lifecycleRead = await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts);
        if (
            this.dependencies.sessionGenerationLifecycle.isGenerationClosed(lifecycleFacts, lifecycleRead)
        ) {
            return await this.writeInactiveGeneration(context, connection);
        }
        const command = await this.toAuthorisedWsConnectCommand(context, connection);
        const computed = await this.readComputeValidateMutation(command);
        const lifecycleGuardFacts = {
            ...lifecycleFacts,
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
                connection.generationStartedAtEpochMs,
                connection.expiresAtEpochMs
            )
        };
        const lifecycleComputed = this.dependencies.sessionGenerationLifecycle.computeConnectGuard(
            lifecycleGuardFacts,
            lifecycleRead
        );
        validateWsSessionConnectGuard(lifecycleGuardFacts, lifecycleRead, lifecycleComputed);
        return await this.commitComputed(context, computed, lifecycleComputed);
    }

    async processAuthorisedWsDisconnect(
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>
    ): Promise<AuthorisedWsClientMutationResult> {
        const lifecycleComputed = await this.readComputeValidateAuthorisedWsDisconnectLifecycle(input);
        const command = await this.toAuthorisedWsDisconnectCommand(context, input);
        const read = await this.dependencies.mutationService.read(command);
        if (!read.session) {
            return await this.writeMissingSessionDisconnect({
                context,
                disconnect: input,
                command,
                read,
                lifecycleComputed
            });
        }
        const computed = this.computeMutation(command, read);
        this.validateMutation(command, read, computed);
        return await this.commitComputed(context, computed, lifecycleComputed);
    }

    async processExpiredSessionCommands(
        context: AppInboxMessageContext<readonly ClientStateWritten[]>,
        atEpochMs: number
    ): Promise<readonly ClientStateWritten[]> {
        const computed = await this.readComputeValidateExpiredSessionMutations(context, atEpochMs);
        const applied = computed.filter((successor) => successor.outcome === 'write');
        const durableResult = applied.map(toClientStateWritten);
        const committedSnapshots = applied.map((successor) => successor.snapshot);
        const completion = this.readComputeValidateCompletion(context, durableResult);
        const writes = computed.filter(requiresClientWrite);
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    completion,
                    async (transaction) => {
                        for (const successor of writes) {
                            await this.dependencies.mutationService.write(transaction, successor);
                        }
                    }
                )
        );
        await this.observeCommittedSnapshots(committedSnapshots);
        return result;
    }

    private async readComputeValidateMutation(
        command: ClientMutationCommand
    ): Promise<ClientMutationComputed> {
        const read = await this.dependencies.mutationService.read(command);
        const computed = this.computeMutation(command, read);
        this.validateMutation(command, read, computed);
        return computed;
    }

    private async commitComputed(
        context: AppInboxMessageContext<ClientStateWritten>,
        computed: ClientMutationComputed,
        lifecycleComputed?: WsSessionGenerationLifecycleComputed
    ): Promise<ClientStateWritten> {
        if (computed.outcome === 'idempotency-conflict') {
            throw new Error('Validated client idempotency conflict is unreachable');
        }
        const durableResult = toClientStateWritten(computed);
        const committedSnapshots = [computed.snapshot];
        const completion = this.readComputeValidateCompletion(context, durableResult);
        const writes = requiresClientWrite(computed) ? [computed] : [];
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    completion,
                    async (transaction) => {
                        await this.writeClientMutation(transaction, computed, lifecycleComputed);
                    }
                )
        );
        await this.observeCommittedSnapshots(committedSnapshots);
        return result;
    }

    private computeMutation(
        command: ClientMutationCommand,
        read: Awaited<ReturnType<ClientStateMutationService['read']>>
    ): ClientMutationComputed {
        return timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () => this.dependencies.mutationService.compute(command, read)
        );
    }

    private validateMutation(
        command: ClientMutationCommand,
        read: Awaited<ReturnType<ClientStateMutationService['read']>>,
        computed: ClientMutationComputed
    ): void {
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => this.dependencies.mutationService.validate(command, read, computed)
        );
    }

    private async writeClientMutation(
        transaction: PSqlSql,
        computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>,
        lifecycleComputed: WsSessionGenerationLifecycleComputed | undefined
    ): Promise<void> {
        if (lifecycleComputed) {
            await this.dependencies.sessionGenerationLifecycle.write(transaction, lifecycleComputed);
        }
        if (requiresClientWrite(computed)) {
            await this.dependencies.mutationService.write(transaction, computed);
        }
    }

    private async observeCommittedSnapshots(snapshots: readonly ClientSnapshot[]): Promise<void> {
        for (const snapshot of snapshots) {
            await this.dependencies.snapshotObserver.observeSnapshot(snapshot);
        }
    }

    private async toCommand(
        context: AppInboxExecutionMetadata,
        input: ClientMutationCommandInput
    ): Promise<ClientMutationCommand> {
        return await toClientMutationCommand(
            input,
            toClientMutationPersistedFacts(context, input.commandId, this.dependencies),
            readClientMutationAuthority(context.enqueue.authority, input.operation)
        );
    }

    private async writeInactiveGeneration(
        context: AppInboxMessageContext<InactiveAuthorisedWsSessionResult>,
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload
    ): Promise<InactiveAuthorisedWsSessionResult> {
        const durableResult = {
            status: 'inactive',
            sessionId: connection.authSession.sessionId,
            generationId: connection.generationId
        } as const;
        const completion = this.readComputeValidateCompletion(context, durableResult);
        return await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            completion,
            async () => {}
        );
    }

    private async readComputeValidateAuthorisedWsDisconnectLifecycle(
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload
    ): Promise<WsSessionGenerationLifecycleComputed> {
        const connection = input.connection;
        const lifecycleFacts = {
            ...toWsSessionGenerationFacts(connection),
            disconnectedAtEpochMs: input.disconnectedAtEpochMs,
            reason: input.reason,
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
                input.disconnectedAtEpochMs,
                Math.max(input.disconnectedAtEpochMs, connection.expiresAtEpochMs)
            )
        };
        const lifecycleRead = await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts);
        const computed = this.dependencies.sessionGenerationLifecycle.computeClosed(
            lifecycleFacts,
            lifecycleRead
        );
        validateWsSessionGenerationClosed(lifecycleFacts, lifecycleRead, computed);
        return computed;
    }

    private async writeMissingSessionDisconnect({
        context,
        disconnect,
        command,
        read,
        lifecycleComputed
    }: WriteMissingSessionDisconnectInput): Promise<InactiveAuthorisedWsSessionResult> {
        validateClientMutationAuthorityPolicy(command, read);
        const durableResult = {
            status: 'inactive',
            sessionId: disconnect.connection.authSession.sessionId,
            generationId: disconnect.connection.generationId
        } as const;
        const completion = this.readComputeValidateCompletion(context, durableResult);
        return await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            completion,
            async (transaction) => {
                await this.dependencies.sessionGenerationLifecycle.write(transaction, lifecycleComputed);
            }
        );
    }

    private readComputeValidateCompletion<Result>(
        context: AppInboxMessageContext<Result>,
        durableResult: Result
    ): AppInboxCompletionComputed<Result> {
        const input = {
            ...this.dependencies.transactionWriter.readCompletionFacts(context),
            durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        const computed = computeAppInboxCompletion(input);
        const issues = validateAppInboxCompletion(input, computed);
        if (issues.length > 0) {
            throw issues[0].cause;
        }
        return computed;
    }

    private async toAuthorisedWsConnectCommand(
        context: AppInboxExecutionMetadata,
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload
    ): Promise<ClientMutationCommand> {
        const requestId = toAuthorisedWsRequestId('connect', connection);
        return await this.toCommand(
            context,
            toConnectClientSessionMutationInput({
                operation: 'connectAuthorisedWsSession',
                scope: connection.scope,
                principalId: connection.principalId,
                clientInstanceId: connection.clientInstanceId,
                sessionId: connection.authSession.sessionId,
                request: {
                    generationId: connection.generationId,
                    presenceState: 'online',
                    transport: 'ws',
                    connectionId: connection.generationId,
                    connectedAtEpochMs: connection.generationStartedAtEpochMs,
                    expiresAtEpochMs: connection.expiresAtEpochMs,
                    actorPrincipalId: connection.principalId,
                    actorSessionId: connection.authSession.sessionId,
                    requestId
                },
                defaultCommandId: requestId,
                identityDefaults: {
                    platform: connection.platform,
                    userAgent: connection.userAgent ?? undefined,
                    capabilities: connection.capabilities,
                    principalUsername: connection.authSession.username,
                    principalDisplayName: connection.displayName,
                    principalRoles: ['member']
                }
            })
        );
    }

    private async toAuthorisedWsDisconnectCommand(
        context: AppInboxExecutionMetadata,
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload
    ): Promise<ClientMutationCommand> {
        const connection = input.connection;
        return await this.toCommand(
            context,
            toDisconnectClientSessionMutationInput({
                operation: 'disconnectAuthorisedWsSession',
                scope: connection.scope,
                principalId: connection.principalId,
                clientInstanceId: connection.clientInstanceId,
                sessionId: connection.authSession.sessionId,
                request: {
                    generationId: connection.generationId,
                    disconnectedAtEpochMs: input.disconnectedAtEpochMs,
                    reason: input.reason,
                    actorPrincipalId: connection.principalId,
                    actorSessionId: connection.authSession.sessionId,
                    requestId: toAuthorisedWsRequestId('disconnect', connection)
                },
                defaultCommandId: context.entry.key.resourceId
            })
        );
    }

    private async readComputeValidateExpiredSessionMutations(
        context: AppInboxExecutionMetadata,
        atEpochMs: number
    ): Promise<readonly ClientMutationComputed[]> {
        const computed: ClientMutationComputed[] = [];
        for (
            const candidate of await this.dependencies.expiryCandidates.listExpiredSessionCandidates(
                atEpochMs
            )
        ) {
            const command = await this.toCommand(
                context,
                toExpireClientSessionMutationInput(candidate)
            );
            computed.push(await this.readComputeValidateMutation(command));
        }
        return computed;
    }
}

function toClientMutationPersistedFacts(
    context: AppInboxExecutionMetadata,
    commandId: string,
    dependencies: Pick<ClientStateInboxHandlerDependencies, 'serviceId'>
): Omit<ClientMutationPersistedFacts, 'commandHash'> {
    return {
        nowEpochMs: context.message.id.ts,
        serviceId: dependencies.serviceId,
        eventId: `client-event:${
            JSON.stringify([
                context.entry.key.contextId,
                context.entry.key.topicId,
                commandId
            ])
        }`,
        attemptCount: context.entry.dequeueAudit.attempts,
        expireAtEpochMs: Number(context.entry.audit.expiryTs.epochMilliseconds)
    };
}

function toWsSessionGenerationFacts(
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): WsSessionGenerationFacts {
    return {
        scope: {
            kind: 'client' as const,
            ...connection.scope,
            principalId: connection.principalId,
            clientInstanceId: connection.clientInstanceId
        },
        sessionId: connection.authSession.sessionId,
        generationId: connection.generationId,
        generationStartedAtEpochMs: connection.generationStartedAtEpochMs
    };
}

function toAuthorisedWsRequestId(
    operation: 'connect' | 'disconnect',
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): string {
    return [
        'authorised-ws',
        operation,
        connection.authSession.sessionId,
        connection.generationId
    ].join(':');
}
