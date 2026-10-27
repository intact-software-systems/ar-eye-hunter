import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AppInboxExecutionMetadata, AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import {
    writeAuthWsTicketConsumption,
    type AuthWsTicketConsumptionClaim
} from '../../auth/ws-ticket/auth-ws-ticket-consumption.ts';
import type { ClientSessionExpiryCandidate } from '../../presence/session-expiry.ts';
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
    ClientMutationComputed,
    ClientMutationRead
} from '../mutation/client-mutation-contracts.ts';
import { toConnectClientSessionMutationInput } from '../mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toDisconnectClientSessionMutationInput } from '../mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '../mutation/command-input/to-expire-client-session-mutation-input.ts';
import { ClientMutationIdempotencyConflictError } from '../mutation/result-validation/assert-client-mutation.ts';
import { validateClientMutationAuthorityPolicy } from '../mutation/result-validation/validate-client-mutation-authority-policy.ts';
import { writeClientMutationRecords, writeClientRuntimeBatch } from '../mutation/write-client-mutation.ts';
import { writeClientSnapshotProvenance } from '../persistence/client-snapshot-provenance.ts';
import type { ClientMutationValidationIssue } from '../validation/client-mutation-rejection.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload,
    ClientAuthorisedWsTicketConnectAppInboxPayload
} from './app-client-inbox-contracts.ts';
import { readClientMutationAuthority } from './authenticated-client-mutation-ingress.ts';
import {
    assertAuthorisedWsConnectOperation,
    assertClientMutationOperation,
    assertExpiredSessionsOperation,
    assertMissingSessionDisconnect,
    computeAuthorisedWsConnectOperation,
    computeClientMutationOperation,
    computeExpiredSessionsOperation,
    computeMissingSessionDisconnect,
    type AuthorisedWsConnectOperationComputed,
    type ClientExpiredSessionMutationRead,
    type ClientMutationOperationComputed,
    type ComputeAuthorisedWsConnectOperationInput,
    type ComputeClientMutationOperationInput,
    type ComputeExpiredSessionsOperationInput,
    type ComputeMissingSessionDisconnectInput,
    type ExpiredSessionsOperationComputed,
    type MissingSessionDisconnectComputed
} from './client-state-inbox-computation.ts';
import type { AuthorisedWsClientMutationResult } from './client-state-inbox-result-codec.ts';

export interface ClientExpiryContinuationWriter {
    write(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void>;
}

interface MissingSessionDisconnectAttemptInput extends ComputeMissingSessionDisconnectInput {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
}

interface WriteClientMutationOperationInput {
    readonly context: AppInboxExecutionMetadata;
    readonly computed: Extract<ClientMutationOperationComputed, { outcome: 'completed'; }>;
}

interface WriteExpiredSessionsOperationInput {
    readonly context: AppInboxExecutionMetadata;
    readonly computed: Extract<ExpiredSessionsOperationComputed, { outcome: 'completed'; }>;
}

export namespace ClientStateInboxHandler {
    export interface Input {
        readonly mutationService: ClientStateMutationService;
        readonly sessionGenerationLifecycle: Pick<WsSessionGenerationLifecycleService, 'read' | 'write'>;
        readonly expiryCandidates: Pick<ClientStateService, 'readExpiredSessionPage'>;
        readonly expiryContinuationWriter: ClientExpiryContinuationWriter;
        readonly snapshotObserver: Pick<ClientStateService, 'observeSnapshot'>;
        readonly transactionWriter: AppInboxMutationTransactionWriter;
        readonly mutationTiming: ClientStateMutationTiming;
        readonly wakeQueue?: () => void;
        readonly serviceId: string;
        readonly disconnectedSessionRetentionMs: number;
        /** How long a command's idempotency record and state-sync outbox rows stay after it was enqueued. */
        readonly finishedRetentionMs: number;
    }
}

export class ClientStateInboxHandler {
    private readonly dependencies: ClientStateInboxHandler.Input;

    constructor(dependencies: ClientStateInboxHandler.Input) {
        this.dependencies = dependencies;
    }

    async processCommand(
        context: AppInboxMessageContext<ClientStateWritten>,
        input: ClientMutationCommandInput
    ): Promise<ClientStateWritten> {
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const command = this.toCommand(context, input);
        const read = await this.dependencies.mutationService.read(command);
        const computed = this.measureMutationComputation({
            command,
            read,
            completionFacts,
            lifecycle: undefined
        });
        if (computed.outcome === 'idempotency-conflict') {
            throwClientMutationIdempotencyConflict(command, computed.mutation);
        }
        const result = await this.writeMutationOperation({ context, computed });
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        return result;
    }

    async processAuthorisedWsConnect(
        ticketConnect: ClientAuthorisedWsTicketConnectAppInboxPayload,
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>
    ): Promise<AuthorisedWsClientMutationResult> {
        const { connection } = ticketConnect;
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const ticketClaim = toAuthWsTicketConsumptionClaim(ticketConnect, context.message.id.ts);
        const lifecycleFacts = toWsSessionGenerationFacts(connection);
        const command = this.toAuthorisedWsConnectCommand(context, connection);
        const read = await this.dependencies.mutationService.readAuthorisedWsConnect({
            command,
            ticketClaim,
            lifecycle: lifecycleFacts
        });
        const computed = this.measureAuthorisedConnectComputation({
            connection,
            ticketClaim,
            ticketRead: read.ticket,
            command,
            read: read.mutation,
            lifecycleFacts,
            lifecycleRead: read.lifecycle,
            completionFacts
        });
        if (computed.outcome === 'idempotency-conflict') {
            throwClientMutationIdempotencyConflict(command, computed.mutation);
        }
        return await this.writeAuthorisedConnectOperation(context, computed);
    }

    /** The ticket's guarded delete is the first write of every connect that presented a live ticket. */
    private async writeAuthorisedConnectOperation(
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>,
        computed: Exclude<AuthorisedWsConnectOperationComputed, { outcome: 'idempotency-conflict'; }>
    ): Promise<AuthorisedWsClientMutationResult> {
        switch (computed.outcome) {
            case 'ticket-rejected':
                console.warn('Authorised WebSocket connect rejected its ticket', {
                    ...computed.durableResult,
                    issues: computed.issues
                });
                return await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async () => {}
                );
            case 'inactive':
                return await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => await writeAuthWsTicketConsumption(transaction, computed.ticketConsumption)
                );
            case 'completed': {
                const result = await this.writeAuthorisedConnectMutation(context, computed);
                this.dependencies.wakeQueue?.();
                await this.observeCommittedSnapshots(computed.committedSnapshots);
                return result;
            }
        }
    }

    async processAuthorisedWsDisconnect(
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>
    ): Promise<AuthorisedWsClientMutationResult> {
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const lifecycleFacts = toAuthorisedWsDisconnectLifecycleFacts(input);
        const lifecycleRead = await this.dependencies.sessionGenerationLifecycle.read(lifecycleFacts);
        const command = this.toAuthorisedWsDisconnectCommand(context, input);
        const read = await this.dependencies.mutationService.read(command);
        if (!read.session) {
            const computed = this.measureMissingDisconnectComputation({
                commandInput: input,
                command,
                read,
                lifecycleFacts,
                lifecycleRead,
                completionFacts
            });
            return await this.dependencies.transactionWriter.writeComputedMutation(
                context,
                computed.completion,
                async (transaction) =>
                    await this.dependencies.sessionGenerationLifecycle.write(transaction, computed.lifecycleComputed)
            );
        }
        const computed = this.measureMutationComputation({
            command,
            read,
            completionFacts,
            lifecycle: { kind: 'disconnect', facts: lifecycleFacts, read: lifecycleRead }
        });
        if (computed.outcome === 'idempotency-conflict') {
            throwClientMutationIdempotencyConflict(command, computed.mutation);
        }
        const result = await this.writeMutationOperation({ context, computed });
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        return result;
    }

    async processExpiredSessionCommands(
        context: AppInboxMessageContext<readonly ClientStateWritten[]>,
        input: ClientExpiredSessionPageInput
    ): Promise<readonly ClientStateWritten[]> {
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const page = await this.dependencies.expiryCandidates.readExpiredSessionPage(input);
        const reads = await this.readExpiredSessionMutations(context, page.candidates);
        const computed = this.measureExpiredSessionsComputation({
            context,
            pageInput: input,
            page,
            reads,
            completionFacts
        });
        if (computed.outcome === 'idempotency-conflict') {
            const conflictIndex = computed.mutations.findIndex((mutation) =>
                mutation.outcome === 'idempotency-conflict'
            );
            const conflict = computed.mutations[conflictIndex];
            if (!conflict || conflict.outcome !== 'idempotency-conflict') {
                throw new TypeError('Expired client mutation conflict is missing');
            }
            throwClientMutationIdempotencyConflict(reads[conflictIndex]!.command, conflict);
        }
        const result = await this.writeExpiredSessionsOperation({ context, computed });
        await this.observeCommittedSnapshots(computed.committedSnapshots);
        if (computed.successorWrite !== null) {
            this.dependencies.wakeQueue?.();
        }
        return result;
    }

    private async readExpiredSessionMutations(
        context: AppInboxExecutionMetadata,
        candidates: readonly ClientSessionExpiryCandidate[]
    ): Promise<ClientExpiredSessionMutationRead[]> {
        const reads: ClientExpiredSessionMutationRead[] = [];
        for (const candidate of candidates) {
            const command = this.toCommand(context, toExpireClientSessionMutationInput(candidate));
            reads.push({ command, read: await this.dependencies.mutationService.read(command) });
        }
        return reads;
    }

    private measureMutationComputation(
        input: ComputeClientMutationOperationInput
    ): ClientMutationOperationComputed {
        const { command, read } = input;
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () => computeClientMutationOperation(input)
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => {
                assertClientMutationOperation({ ...input, computed });
                throwFirstClientMutationValidationIssue(validateClientMutationAuthorityPolicy(command, read));
            }
        );
        return computed;
    }

    private measureAuthorisedConnectComputation(
        input: ComputeAuthorisedWsConnectOperationInput
    ): AuthorisedWsConnectOperationComputed {
        const { command, read } = input;
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () => computeAuthorisedWsConnectOperation(input)
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => {
                assertAuthorisedWsConnectOperation({ ...input, computed });
                throwFirstClientMutationValidationIssue(validateClientMutationAuthorityPolicy(command, read));
            }
        );
        return computed;
    }

    private measureMissingDisconnectComputation(
        input: MissingSessionDisconnectAttemptInput
    ): MissingSessionDisconnectComputed {
        const { command, read } = input;
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.compute' },
            () => computeMissingSessionDisconnect(input)
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command, operation: 'mutation.validate' },
            () => {
                assertMissingSessionDisconnect({ ...input, computed });
                throwFirstClientMutationValidationIssue(validateClientMutationAuthorityPolicy(command, read));
            }
        );
        return computed;
    }

    private measureExpiredSessionsComputation(
        input: ComputeExpiredSessionsOperationInput
    ): ExpiredSessionsOperationComputed {
        const firstRead = input.reads[0];
        if (!firstRead) {
            const computed = computeExpiredSessionsOperation(input);
            assertExpiredSessionsOperation({ ...input, computed });
            return computed;
        }
        const computed = timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command: firstRead.command, operation: 'mutation.compute' },
            () => computeExpiredSessionsOperation(input)
        );
        timeClientStateMutationPhase(
            { timing: this.dependencies.mutationTiming, command: firstRead.command, operation: 'mutation.validate' },
            () => {
                assertExpiredSessionsOperation({ ...input, computed });
                throwFirstClientMutationValidationIssue(
                    input.reads.flatMap(({ command, read }) => validateClientMutationAuthorityPolicy(command, read))
                );
            }
        );
        return computed;
    }

    /** The connect's guarded batch is its first write: the ticket, lifecycle, client and proof rows in one statement. */
    private async writeAuthorisedConnectMutation(
        context: AppInboxMessageContext<AuthorisedWsClientMutationResult>,
        computed: Extract<AuthorisedWsConnectOperationComputed, { outcome: 'completed'; }>
    ): Promise<ClientStateWritten> {
        return await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => {
                        await writeClientRuntimeBatch(transaction, computed.runtimeBatch, computed.sidecarWrites);
                        for (const mutation of computed.writes) {
                            await writeClientMutationRecords(transaction, mutation);
                        }
                    }
                )
        );
    }

    private async writeMutationOperation(input: WriteClientMutationOperationInput): Promise<ClientStateWritten> {
        const { context, computed } = input;
        return await timeClientStateMutationCommit(
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
                        await writeClientSnapshotProvenance(transaction, computed.sidecarWrites);
                    }
                )
        );
    }

    private async writeExpiredSessionsOperation(
        input: WriteExpiredSessionsOperationInput
    ): Promise<readonly ClientStateWritten[]> {
        const { context, computed } = input;
        return await timeClientStateMutationCommit(
            { timing: this.dependencies.mutationTiming, writes: computed.writes },
            async () =>
                await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    computed.completion,
                    async (transaction) => {
                        for (const mutation of computed.writes) {
                            await this.dependencies.mutationService.write(transaction, mutation);
                        }
                        await writeClientSnapshotProvenance(transaction, computed.sidecarWrites);
                        if (computed.successorWrite !== null) {
                            await this.dependencies.expiryContinuationWriter.write(
                                transaction,
                                computed.successorWrite
                            );
                        }
                    }
                )
        );
    }

    private async observeCommittedSnapshots(snapshots: readonly ClientSnapshot[]): Promise<void> {
        for (const snapshot of snapshots) {
            await this.dependencies.snapshotObserver.observeSnapshot(snapshot);
        }
    }

    private toCommand(
        context: AppInboxExecutionMetadata,
        input: ClientMutationCommandInput
    ): ClientMutationCommand {
        return toClientMutationCommand(
            input,
            toClientMutationPersistedFacts(context, input.commandId, this.dependencies),
            readClientMutationAuthority(context.enqueue.authority, input.operation)
        );
    }

    private toAuthorisedWsConnectCommand(
        context: AppInboxExecutionMetadata,
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload
    ): ClientMutationCommand {
        const requestId = toAuthorisedWsRequestId('connect', connection);
        return this.toCommand(
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

    private toAuthorisedWsDisconnectCommand(
        context: AppInboxExecutionMetadata,
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload
    ): ClientMutationCommand {
        const connection = input.connection;
        return this.toCommand(
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
    dependencies: Pick<
        ClientStateInboxHandler.Input,
        'serviceId' | 'disconnectedSessionRetentionMs' | 'finishedRetentionMs'
    >
): Omit<ClientMutationPersistedFacts, 'commandHash'> {
    return {
        nowEpochMs: context.message.id.ts,
        serviceId: dependencies.serviceId,
        // The enqueue instant makes the event one per execution: a request executed again after its retention window.
        eventId: `client-event:${
            JSON.stringify([
                context.entry.key.contextId,
                context.entry.key.topicId,
                commandId,
                context.message.id.ts
            ])
        }`,
        attemptCount: context.entry.dequeueAudit.attempts,
        expireAtEpochMs: context.message.id.ts + dependencies.finishedRetentionMs,
        disconnectedSessionRetentionMs: dependencies.disconnectedSessionRetentionMs,
        traceId: context.message.id.traceId
    };
}

function toAuthWsTicketConsumptionClaim(
    ticketConnect: ClientAuthorisedWsTicketConnectAppInboxPayload,
    capturedAtEpochMs: number
): AuthWsTicketConsumptionClaim {
    const { authSession } = ticketConnect.connection;
    return {
        ticketDigest: ticketConnect.ticketDigest,
        clientId: authSession.clientId,
        sessionId: authSession.sessionId,
        sessionIssuedAtEpochMs: authSession.issuedAtEpochMs,
        sessionExpiresAtEpochMs: authSession.expiresAtEpochMs,
        capturedAtEpochMs
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
