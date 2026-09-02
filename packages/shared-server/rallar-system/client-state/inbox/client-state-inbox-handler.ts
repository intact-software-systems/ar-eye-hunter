import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AppInboxExecutionMetadata } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import { isWsSessionGenerationClosed } from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    ClientStateMutationService,
    ClientStateService,
    ClientStateWritten
} from '../client-state-service-contracts.ts';
import {
    timeClientStateInboxPhase,
    timeClientStateMutationCommit,
    type ClientStateMutationTiming
} from '../client-state-service-timing.ts';
import { toClientMutationCommand, type ClientMutationPersistedFacts } from '../mutation/client-mutation-command.ts';
import type { ClientMutationCommand, ClientMutationCommandInput } from '../mutation/client-mutation-contracts.ts';
import { toConnectClientSessionMutationInput } from '../mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toDisconnectClientSessionMutationInput } from '../mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '../mutation/command-input/to-expire-client-session-mutation-input.ts';
import { validateClientMutationAuthorityPolicy } from '../mutation/result-validation/validate-client-mutation-authority-policy.ts';
import { validateClientMutationRead } from '../mutation/result-validation/validate-client-mutation-read.ts';
import { validateClientMutation } from '../mutation/result-validation/validate-client-mutation.ts';
import { clientStatePrincipalStorageKey } from '../persistence/client-state-principal-storage-key.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload
} from './app-client-inbox-contracts.ts';
import { readClientMutationAuthority } from './authenticated-client-mutation-ingress.ts';
import {
    computeClientExpiryInboxCompletion,
    computeClientExpiryMutation,
    validateClientExpiryInboxCompletion,
    type ClientExpiryMutationComputed
} from './client-expiry-inbox-computation.ts';
import {
    computeClientStateInboxMutation,
    validateClientStateInboxMutation,
    type ClientInboxMutationRead,
    type ClientStateInboxAfterCommitResult,
    type ClientStateInboxComputed
} from './client-state-inbox-computation.ts';
import type { AuthorisedWsClientMutationResult } from './client-state-inbox-result-codec.ts';
import {
    computeClientWsConnectInbox,
    computeClientWsDisconnectInbox,
    toClientWsConnectGuardFacts,
    toClientWsDisconnectFacts,
    validateClientWsConnectInbox,
    validateClientWsDisconnectInbox
} from './client-ws-inbox-computation.ts';

export interface ClientStateInboxHandlerDependencies {
    readonly mutationService: Pick<ClientStateMutationService, 'read' | 'write'>;
    readonly mutationTiming: ClientStateMutationTiming;
    readonly sessionGenerationLifecycle: Pick<WsSessionGenerationLifecycleService, 'read' | 'write'>;
    readonly expiryCandidates: Pick<ClientStateService, 'listExpiredSessionCandidates'>;
    readonly snapshotObserver: Pick<ClientStateService, 'observeSnapshot'>;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly serviceId: string;
}

export class ClientStateInboxHandler {
    private readonly dependencies: ClientStateInboxHandlerDependencies;

    constructor(dependencies: ClientStateInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async processCommand(
        context: AppInboxExecutionMetadata,
        input: ClientMutationCommandInput
    ): Promise<ClientStateWritten> {
        const command = await this.toCommand(context, input);
        const mutation = { command, read: await this.dependencies.mutationService.read(command) };
        const read = { mutation, completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context) };
        const timing = this.dependencies.mutationTiming;
        const computed = timeClientStateInboxPhase(
            { timing, command, operation: 'mutation.compute' },
            () => computeClientStateInboxMutation(read)
        );
        timeClientStateInboxPhase({ timing, command, operation: 'mutation.validate' }, () => {
            const issues = validateClientStateInboxMutation(read, computed);
            if (issues.length > 0) {
                throw issues[0].cause;
            }
            validateClientMutation({ ...mutation, computed: computed.mutation });
        });
        return await this.commitComputed(context, computed);
    }

    async processAuthorisedWsConnect(
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
        context: AppInboxExecutionMetadata
    ): Promise<AuthorisedWsClientMutationResult> {
        const facts = toClientWsConnectGuardFacts(connection);
        const lifecycle = await this.dependencies.sessionGenerationLifecycle.read(facts);
        const mutation = isWsSessionGenerationClosed(facts, lifecycle)
            ? undefined
            : await this.readAuthorisedWsConnectMutation(context, connection);
        const read = {
            facts,
            lifecycle,
            mutation,
            completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context)
        };
        const timing = this.dependencies.mutationTiming;
        const command = mutation?.command;
        const computed = timeClientStateInboxPhase(
            { timing, command, operation: 'mutation.compute' },
            () => computeClientWsConnectInbox(read)
        );
        timeClientStateInboxPhase({ timing, command, operation: 'mutation.validate' }, () => {
            const issues = validateClientWsConnectInbox(read, computed);
            if (issues.length > 0) {
                throw issues[0].cause;
            }
            if (mutation && computed.mutation) {
                validateClientMutation({ ...mutation, computed: computed.mutation });
            }
        });
        return await this.commitComputed(context, computed);
    }

    async processAuthorisedWsDisconnect(
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
        context: AppInboxExecutionMetadata
    ): Promise<AuthorisedWsClientMutationResult> {
        const facts = toClientWsDisconnectFacts(input);
        const lifecycle = await this.dependencies.sessionGenerationLifecycle.read(facts);
        const command = await this.toAuthorisedWsDisconnectCommand(context, input);
        const mutation = { command, read: await this.dependencies.mutationService.read(command) };
        const read = {
            facts,
            lifecycle,
            mutation,
            completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context)
        };
        const timing = this.dependencies.mutationTiming;
        const timedCommand = mutation.read.session ? command : undefined;
        const computed = timeClientStateInboxPhase(
            { timing, command: timedCommand, operation: 'mutation.compute' },
            () => computeClientWsDisconnectInbox(read)
        );
        timeClientStateInboxPhase({ timing, command: timedCommand, operation: 'mutation.validate' }, () => {
            const issues = validateClientWsDisconnectInbox(read, computed);
            if (issues.length > 0) {
                throw issues[0].cause;
            }
            if (computed.mutation) {
                validateClientMutation({ ...mutation, computed: computed.mutation });
            }
            else {
                validateClientMutationAuthorityPolicy(command, mutation.read);
            }
        });
        return await this.commitComputed(context, computed);
    }

    async processExpiredSessionCommands(
        context: AppInboxExecutionMetadata,
        atEpochMs: number
    ): Promise<readonly ClientStateWritten[]> {
        const mutations = await this.readExpiredSessionMutations(context, atEpochMs);
        const read = { mutations, completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context) };
        const timing = this.dependencies.mutationTiming;
        const computedMutations: ClientExpiryMutationComputed[] = [];
        const previousByPrincipal = new Map<string, ClientExpiryMutationComputed>();
        for (const mutation of mutations) {
            const principalKey = clientStatePrincipalStorageKey(mutation.command.aggregateRef);
            const previous = previousByPrincipal.get(principalKey);
            const computedMutation = timeClientStateInboxPhase(
                { timing, command: mutation.command, operation: 'mutation.compute' },
                () => computeClientExpiryMutation(mutation, previous)
            );
            computedMutations.push(computedMutation);
            previousByPrincipal.set(principalKey, computedMutation);
        }
        const computed = computeClientExpiryInboxCompletion(read.completionFacts, computedMutations);
        for (const mutation of computedMutations) {
            validateClientMutationRead(mutation.read.command, mutation.read.read);
            timeClientStateInboxPhase(
                { timing, command: mutation.read.command, operation: 'mutation.validate' },
                () => {
                    validateClientMutation({
                        command: mutation.read.command,
                        read: mutation.predecessor,
                        computed: mutation.computed
                    });
                }
            );
        }
        const issues = validateClientExpiryInboxCompletion(read, computed);
        if (issues.length > 0) {
            throw issues[0].cause;
        }
        return await this.commitComputed(context, computed);
    }

    private async commitComputed<Result>(
        context: AppInboxExecutionMetadata,
        computed: ClientStateInboxComputed<Result>
    ): Promise<Result> {
        const result = await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.clientWrites },
            async () =>
                await this.dependencies.transactionWriter.writeMutationWithAfterCommitResult(
                    context,
                    computed.completion,
                    async (transaction) => {
                        await this.writeComputedMutation(transaction, computed);
                        return computed.afterCommitResult;
                    }
                )
        );
        await this.observeCommittedSnapshots(result.afterCommitResult);
        return result.durableResult;
    }

    private async writeComputedMutation<Result>(
        transaction: PSqlSql,
        computed: ClientStateInboxComputed<Result>
    ): Promise<void> {
        if (computed.lifecycleWrite) {
            await this.dependencies.sessionGenerationLifecycle.write(transaction, computed.lifecycleWrite);
        }
        for (const mutation of computed.clientWrites) {
            await this.dependencies.mutationService.write(transaction, mutation);
        }
    }

    private async observeCommittedSnapshots(result: ClientStateInboxAfterCommitResult): Promise<void> {
        for (const snapshot of result.committedSnapshots) {
            await this.dependencies.snapshotObserver.observeSnapshot(snapshot);
        }
    }

    private async readAuthorisedWsConnectMutation(
        context: AppInboxExecutionMetadata,
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload
    ): Promise<ClientInboxMutationRead> {
        const command = await this.toAuthorisedWsConnectCommand(context, connection);
        return { command, read: await this.dependencies.mutationService.read(command) };
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

    private async readExpiredSessionMutations(
        context: AppInboxExecutionMetadata,
        atEpochMs: number
    ): Promise<readonly ClientInboxMutationRead[]> {
        const reads: ClientInboxMutationRead[] = [];
        for (
            const candidate of await this.dependencies.expiryCandidates.listExpiredSessionCandidates(
                atEpochMs
            )
        ) {
            const command = await this.toCommand(
                context,
                toExpireClientSessionMutationInput(candidate)
            );
            const read = await this.dependencies.mutationService.read(command);
            reads.push({ command, read });
        }
        return reads;
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
