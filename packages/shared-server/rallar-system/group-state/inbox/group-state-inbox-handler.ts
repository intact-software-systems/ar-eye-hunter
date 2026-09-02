import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type { GroupFormationMutationOutcome } from '@shared/rtc/group-formation-metrics.ts';
import { type AppInboxExecutionMetadata } from '../../app-inbox/app-inbox-contracts.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { GroupFormationGroupMutationSink } from '../../observability/formation-metrics.ts';
import {
    computeWsSessionConnectGuard,
    validateWsSessionConnectGuard,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleComputed
} from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    AuthorizedGroupMutation,
    GroupMutationAuthority,
    GroupMutationPreparation,
    GroupStateMutationCommand,
    GroupStateMutationService
} from '../group-state-service-contracts.ts';
import { GroupMutationIdempotencyConflictError } from '../group-state-service.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../group-state-validation-issues.ts';
import { toGroupMutationRejectionError } from '../mutation/group-mutation-result.ts';
import {
    readGroupPresenceConnect,
    type GroupPresenceConnectRead,
    type InactiveGroupPresenceResult
} from '../presence/group-presence-service.ts';
import { decodeGroupStateInboxAuthority } from './decode-group-state-inbox-authority.ts';
import {
    computeGroupStateInboxMutation,
    isGroupPresenceInboxOperation,
    validateGroupStateInboxMutation,
    type ComputeGroupStateInboxMutationInput,
    type GroupStateInboxDurableResult,
    type GroupStateInboxMutationComputed,
    type GroupStateInboxResultReadConflictError
} from './group-state-inbox-result.ts';

export interface GroupStateInboxResultReader {
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    readEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined>;
}

export interface GroupStateInboxHandlerDependencies {
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly resultReader: GroupStateInboxResultReader;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationGroupMutationSink;
    readonly prepareMutation: (
        descriptor: AuthorizedGroupMutation['descriptor'],
        authority: GroupMutationAuthority
    ) => Promise<GroupMutationPreparation>;
    readonly persistPreparation: (
        context: AppInboxExecutionMetadata,
        preparation: GroupMutationPreparation
    ) => Promise<void>;
}

interface CommitGroupStateMutationInput {
    readonly context: AppInboxExecutionMetadata;
    readonly command: GroupStateMutationCommand;
    readonly computed: GroupInboxExecutionComputed;
}

interface GroupInboxExecutionInput extends ComputeGroupStateInboxMutationInput {
    readonly completionFacts: AppInboxCompletionFacts;
    readonly presenceConnect: GroupPresenceConnectRead | undefined;
}

interface GroupInboxExecutionComputed {
    readonly result: GroupStateInboxMutationComputed;
    readonly lifecycleGuard: WsSessionGenerationLifecycleComputed | undefined;
    readonly completion: AppInboxCompletionComputed<GroupStateInboxDurableResult> | undefined;
}

export class GroupStateInboxHandler {
    private readonly dependencies: GroupStateInboxHandlerDependencies;

    constructor(dependencies: GroupStateInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async processGroupStateMutation(
        context: AppInboxExecutionMetadata
    ): Promise<GroupStateInboxDurableResult> {
        const command = await this.readGroupMutationCommand(context);
        const presenceConnect = command.command.operation === 'connectPresence'
            ? await readGroupPresenceConnect({
                command,
                sessionGenerationLifecycle: this.dependencies.sessionGenerationLifecycle
            })
            : undefined;
        if (presenceConnect?.status === 'inactive') {
            return await this.processInactivePresence(context, command, presenceConnect);
        }
        const input: GroupInboxExecutionInput = {
            ...await this.readMutationResultInput(command),
            completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context),
            presenceConnect
        };
        const computation = computeGroupInboxExecution(input);
        if (computation.right === undefined) {
            throw computation.left;
        }
        const computed = computation.right;
        const issues = validateGroupInboxExecution(input, computed);
        if (issues.length > 0) {
            throw issues[0].cause;
        }
        return await this.commitMutation({
            context,
            command,
            computed
        });
    }

    private async processInactivePresence(
        context: AppInboxExecutionMetadata,
        command: GroupStateMutationCommand,
        result: InactiveGroupPresenceResult
    ): Promise<GroupStateInboxDurableResult> {
        const input = {
            ...this.dependencies.transactionWriter.readCompletionFacts(context),
            durableResult: result,
            status: EntityStatus.COMPLETED
        } as const;
        const computed = computeAppInboxCompletion(input);
        const issues = validateAppInboxCompletion(input, computed);
        if (issues.length > 0) {
            throw issues[0].cause;
        }
        const durableResult = await this.dependencies.transactionWriter.writeMutation(
            context,
            computed,
            async () => {}
        );
        this.recordGroupMutation(command, 'rejected');
        return durableResult;
    }

    private async readMutationResultInput(
        command: GroupStateMutationCommand
    ): Promise<ComputeGroupStateInboxMutationInput> {
        const presence = isGroupPresenceInboxOperation(command.command.operation);
        const snapshotRead = presence
            ? undefined
            : this.dependencies.resultReader.readSnapshot(command.command.aggregateRef);
        const [currentSnapshot, read] = await Promise.all([
            snapshotRead,
            this.dependencies.mutationService.read(command)
        ]);
        const receipt = read.idempotency?.value.receipt;
        const recordedEvent =
            !presence && receipt && receipt.commandHash === command.facts.commandHash && receipt.eventId !== null
                ? await this.dependencies.resultReader.readEvent(command.command.aggregateRef, receipt.eventId)
                : undefined;
        return { currentSnapshot, command, read, recordedEvent };
    }

    private async readGroupMutationCommand(
        context: AppInboxExecutionMetadata
    ): Promise<GroupStateMutationCommand> {
        const authority = decodeGroupStateInboxAuthority(context.enqueue.authority);
        const prepared = authority.kind === 'prepared'
            ? authority.mutation
            : await this.dependencies.prepareMutation(
                authority.mutation.descriptor,
                authority.mutation.authorityProof
            );
        if (authority.kind !== 'prepared') {
            await this.dependencies.persistPreparation(context, prepared);
        }
        return {
            authorityProof: prepared.authorityProof,
            descriptor: prepared.descriptor,
            command: prepared.command,
            facts: {
                ...prepared.facts,
                attemptCount: context.entry.dequeueAudit.attempts
            }
        };
    }

    private async commitMutation(
        input: CommitGroupStateMutationInput
    ): Promise<GroupStateInboxDurableResult> {
        const { mutation } = input.computed.result;
        if (mutation.outcome === 'idempotency-conflict') {
            throw new GroupMutationIdempotencyConflictError(
                input.command.command.commandId,
                mutation.existingCommandHash,
                mutation.receivedCommandHash
            );
        }
        if (mutation.outcome === 'rejected') {
            throw toGroupMutationRejectionError(mutation);
        }
        if (input.computed.completion === undefined) {
            throw new TypeError('Committable group mutation is missing its computed durable result.');
        }
        const durableResult = await this.dependencies.transactionWriter
            .writeMutation(
                input.context,
                input.computed.completion,
                async (transaction) => {
                    if (input.computed.lifecycleGuard) {
                        await this.dependencies.sessionGenerationLifecycle.write(
                            transaction,
                            input.computed.lifecycleGuard
                        );
                    }
                    if (mutation.outcome === 'write') {
                        await this.dependencies.mutationService.write(transaction, mutation);
                    }
                }
            );
        this.dependencies.wakeQueue?.();
        this.recordGroupMutation(
            input.command,
            mutation.outcome === 'write'
                ? 'write'
                : 'noOp'
        );
        return durableResult;
    }

    private recordGroupMutation(
        command: GroupStateMutationCommand,
        outcome: GroupFormationMutationOutcome
    ): void {
        try {
            this.dependencies.formationMetrics?.({
                operation: command.command.operation,
                outcome
            });
        }
        catch {
            // Recording must never affect group mutation behavior.
        }
    }
}

function computeGroupInboxExecution(
    input: GroupInboxExecutionInput
): Either<GroupStateInboxResultReadConflictError, GroupInboxExecutionComputed> {
    return computeGroupStateInboxMutation(input).mapRight((result) => {
        const lifecycleFacts = toGroupConnectGuardFacts(input.presenceConnect);
        return {
            result,
            lifecycleGuard: lifecycleFacts && input.presenceConnect?.status === 'active'
                ? computeWsSessionConnectGuard(lifecycleFacts, input.presenceConnect.lifecycleRead)
                : undefined,
            completion: result.durableResult === undefined
                ? undefined
                : computeAppInboxCompletion({
                    ...input.completionFacts,
                    durableResult: result.durableResult,
                    status: EntityStatus.COMPLETED
                })
        };
    });
}

function validateGroupInboxExecution(
    input: GroupInboxExecutionInput,
    computed: GroupInboxExecutionComputed
): readonly GroupStateValidationIssue[] {
    return [
        ...validateGroupStateInboxMutation({ ...input, computed: computed.result }),
        ...validateGroupInboxLifecycle(input, computed),
        ...validateGroupInboxCompletion(input, computed)
    ];
}

function validateGroupInboxLifecycle(
    input: GroupInboxExecutionInput,
    computed: GroupInboxExecutionComputed
): readonly GroupStateValidationIssue[] {
    const facts = toGroupConnectGuardFacts(input.presenceConnect);
    if (facts && input.presenceConnect?.status === 'active') {
        return computed.lifecycleGuard === undefined
            ? [toGroupStateValidationIssue(
                'lifecycleGuard',
                'Group presence connect is missing its computed lifecycle guard.'
            )]
            : validateWsSessionConnectGuard(facts, input.presenceConnect.lifecycleRead, computed.lifecycleGuard);
    }
    return computed.lifecycleGuard === undefined
        ? []
        : [toGroupStateValidationIssue('lifecycleGuard', 'Group mutation has an unexpected lifecycle guard.')];
}

function validateGroupInboxCompletion(
    input: GroupInboxExecutionInput,
    computed: GroupInboxExecutionComputed
): readonly GroupStateValidationIssue[] {
    if (computed.result.durableResult === undefined) {
        return computed.completion === undefined
            ? []
            : [toGroupStateValidationIssue('completion', 'Rejected group mutation has an unexpected completion.')];
    }
    if (computed.completion === undefined) {
        return [
            toGroupStateValidationIssue('completion', 'Committable group mutation is missing its computed completion.')
        ];
    }
    return validateAppInboxCompletion({
        ...input.completionFacts,
        durableResult: computed.result.durableResult,
        status: EntityStatus.COMPLETED
    }, computed.completion);
}

function toGroupConnectGuardFacts(
    read: GroupPresenceConnectRead | undefined
): WsSessionGenerationGuardFacts | undefined {
    return read?.status === 'active'
        ? {
            ...read.facts,
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(read.facts.generationStartedAtEpochMs)
        }
        : undefined;
}
