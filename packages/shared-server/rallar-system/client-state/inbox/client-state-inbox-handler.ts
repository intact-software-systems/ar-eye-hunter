import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AppInboxExecutionMetadata, AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import {
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts
} from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import {
    type ClientExpiredSessionPageInput,
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
import { ClientMutationIdempotencyConflictError } from '../mutation/result-validation/validate-client-mutation.ts';
import type { ClientMutationValidationIssue } from '../validation/client-mutation-rejection.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload
} from './app-client-inbox-contracts.ts';
import { readClientMutationAuthority } from './authenticated-client-mutation-ingress.ts';
import {
    computeAuthorisedWsConnectOperation,
    computeClientMutationOperation,
    computeExpiredSessionsOperation,
    computeMissingSessionDisconnect,
    validateAuthorisedWsConnectOperation,
    validateClientMutationOperation,
    validateExpiredSessionsOperation,
    validateMissingSessionDisconnect,
    type ClientExpiredSessionMutationRead
} from './client-state-inbox-computation.ts';
import type { AuthorisedWsClientMutationResult } from './client-state-inbox-result-codec.ts';

export interface ClientStateInboxHandlerDependencies {
    readonly mutationService: ClientStateMutationService;
    readonly sessionGenerationLifecycle: Pick<WsSessionGenerationLifecycleService, 'read' | 'write'>;
    readonly expiryCandidates: Pick<ClientStateService, 'readExpiredSessionPage'>;
    readonly expiryContinuationWriter: ClientExpiryContinuationWriter;
    readonly snapshotObserver: Pick<ClientStateService, 'observeSnapshot'>;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly mutationTiming: ClientStateMutationTiming;
    readonly wakeQueue?: () => void;
    readonly serviceId: string;
}

export interface ClientExpiryContinuationWriter {
    write(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void>;
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
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const command = await this.toCommand(context, input);
        const read = await this.dependencies.mutationService.read(command);
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () =>
                computeClientMutationOperation({
                    command,
                    read,
                    completionFacts,
                    lifecycle: undefined
                })
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => {
                const validationInput = {
                    command,
                    read,
                    completionFacts,
                    lifecycle: undefined,
                    computed
                } as const;
                throwFirstClientMutationValidationIssue(
                    validateClientMutationOperation(validationInput)
                );
            }
        );
        if (computed.outcome === 'idempotency-conflict') {
            throwClientMutationIdempotencyConflict(command, computed.mutation);
        }
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => {
                        for (const mutation of computed.writes) {
                            await this.dependencies.mutationService.write(transaction, mutation);
                        }
                    }
                )
        );
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        return result;
    }

    async processAuthorisedWsConnect(
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>
    ): Promise<AuthorisedWsClientMutationResult> {
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const lifecycleFacts = toWsSessionGenerationFacts(connection);
        const lifecycleRead = await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts);
        const command = await this.toAuthorisedWsConnectCommand(context, connection);
        const read = await this.dependencies.mutationService.read(command);
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () =>
                computeAuthorisedWsConnectOperation({
                    connection,
                    command,
                    read,
                    lifecycleFacts,
                    lifecycleRead,
                    completionFacts
                })
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => {
                const validationInput = {
                    connection,
                    command,
                    read,
                    lifecycleFacts,
                    lifecycleRead,
                    completionFacts,
                    computed
                } as const;
                throwFirstClientMutationValidationIssue(
                    validateAuthorisedWsConnectOperation(validationInput)
                );
            }
        );
        if (computed.outcome === 'idempotency-conflict') {
            throwClientMutationIdempotencyConflict(command, computed.mutation);
        }
        if (computed.outcome === 'inactive') {
            return await this.dependencies.transactionWriter.writeComputedMutation(
                context,
                computed.completion,
                async () => {}
            );
        }
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => {
                        if (computed.lifecycleComputed) {
                            await this.dependencies.sessionGenerationLifecycle.write(
                                transaction,
                                computed.lifecycleComputed
                            );
                        }
                        for (const mutation of computed.writes) {
                            await this.dependencies.mutationService.write(transaction, mutation);
                        }
                    }
                )
        );
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        return result;
    }

    async processAuthorisedWsDisconnect(
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>
    ): Promise<AuthorisedWsClientMutationResult> {
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const lifecycleFacts = toAuthorisedWsDisconnectLifecycleFacts(input);
        const lifecycleRead = await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts);
        const command = await this.toAuthorisedWsDisconnectCommand(context, input);
        const read = await this.dependencies.mutationService.read(command);
        if (!read.session) {
            const computed = timeClientStateMutationPhase(
                { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
                () =>
                    computeMissingSessionDisconnect({
                        commandInput: input,
                        lifecycleFacts,
                        lifecycleRead,
                        completionFacts
                    })
            );
            timeClientStateMutationPhase(
                { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
                () => {
                    const validationInput = {
                        commandInput: input,
                        command,
                        read,
                        lifecycleFacts,
                        lifecycleRead,
                        completionFacts,
                        computed
                    } as const;
                    throwFirstClientMutationValidationIssue(
                        validateMissingSessionDisconnect(validationInput)
                    );
                }
            );
            return await this.dependencies.transactionWriter.writeComputedMutation(
                context,
                computed.completion,
                async (transaction) => {
                    await this.dependencies.sessionGenerationLifecycle.write(
                        transaction,
                        computed.lifecycleComputed
                    );
                }
            );
        }
        const lifecycleInput = {
            kind: 'disconnect',
            facts: lifecycleFacts,
            read: lifecycleRead
        } as const;
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () =>
                computeClientMutationOperation({
                    command,
                    read,
                    completionFacts,
                    lifecycle: lifecycleInput
                })
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => {
                const validationInput = {
                    command,
                    read,
                    completionFacts,
                    lifecycle: lifecycleInput,
                    computed
                } as const;
                throwFirstClientMutationValidationIssue(
                    validateClientMutationOperation(validationInput)
                );
            }
        );
        if (computed.outcome === 'idempotency-conflict') {
            throwClientMutationIdempotencyConflict(command, computed.mutation);
        }
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => {
                        if (computed.lifecycleComputed) {
                            await this.dependencies.sessionGenerationLifecycle.write(
                                transaction,
                                computed.lifecycleComputed
                            );
                        }
                        for (const mutation of computed.writes) {
                            await this.dependencies.mutationService.write(transaction, mutation);
                        }
                    }
                )
        );
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        return result;
    }

    async processExpiredSessionCommands(
        context: AppInboxMessageContext<readonly ClientStateWritten[]>,
        input: ClientExpiredSessionPageInput
    ): Promise<readonly ClientStateWritten[]> {
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const page = await this.dependencies.expiryCandidates.readExpiredSessionPage(input);
        const reads: ClientExpiredSessionMutationRead[] = [];
        for (const candidate of page.candidates) {
            const command = await this.toCommand(
                context,
                toExpireClientSessionMutationInput(candidate)
            );
            reads.push({ command, read: await this.dependencies.mutationService.read(command) });
        }
        const computeInput = {
            context,
            pageInput: input,
            page,
            reads,
            completionFacts
        } as const;
        const firstRead = reads[0];
        const computed = firstRead
            ? timeClientStateMutationPhase(
                {
                    timing: this.dependencies.mutationTiming,
                    command: firstRead.command,
                    operation: 'mutation.compute'
                },
                () => computeExpiredSessionsOperation(computeInput)
            )
            : computeExpiredSessionsOperation(computeInput);
        const validateInput = {
            context,
            pageInput: input,
            page,
            reads,
            completionFacts,
            computed
        } as const;
        if (firstRead) {
            timeClientStateMutationPhase(
                {
                    timing: this.dependencies.mutationTiming,
                    command: firstRead.command,
                    operation: 'mutation.validate'
                },
                () => {
                    throwFirstClientMutationValidationIssue(
                        validateExpiredSessionsOperation(validateInput)
                    );
                }
            );
        }
        else {
            throwFirstClientMutationValidationIssue(
                validateExpiredSessionsOperation(validateInput)
            );
        }
        if (computed.outcome === 'idempotency-conflict') {
            const conflictIndex = computed.mutations.findIndex(
                (mutation) => mutation.outcome === 'idempotency-conflict'
            );
            const conflict = computed.mutations[conflictIndex];
            if (!conflict || conflict.outcome !== 'idempotency-conflict') {
                throw new TypeError('Expired client mutation conflict is missing');
            }
            throwClientMutationIdempotencyConflict(
                reads[conflictIndex]!.command,
                conflict
            );
        }
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => {
                        for (const mutation of computed.writes) {
                            await this.dependencies.mutationService.write(transaction, mutation);
                        }
                        if (computed.successorWrite !== null) {
                            await this.dependencies.expiryContinuationWriter.write(
                                transaction,
                                computed.successorWrite
                            );
                        }
                    }
                )
        );
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        if (computed.successorWrite !== null) {
            this.dependencies.wakeQueue?.();
        }
        return result;
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
}

function throwFirstClientMutationValidationIssue(
    issues: readonly ClientMutationValidationIssue[]
): void {
    if (issues[0] !== undefined) {
        throw issues[0].cause;
    }
}

function throwClientMutationIdempotencyConflict(
    command: ClientMutationCommand,
    computed: Extract<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>
): never {
    throw new ClientMutationIdempotencyConflictError(
        command.commandId,
        computed.existingCommandHash,
        computed.receivedCommandHash
    );
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

function toAuthorisedWsDisconnectLifecycleFacts(
    input: ClientAuthorisedWsSessionDisconnectAppInboxPayload
): WsSessionGenerationCloseFacts {
    const connection = input.connection;
    return {
        ...toWsSessionGenerationFacts(connection),
        disconnectedAtEpochMs: input.disconnectedAtEpochMs,
        reason: input.reason,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
            input.disconnectedAtEpochMs,
            Math.max(input.disconnectedAtEpochMs, connection.expiresAtEpochMs)
        )
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
