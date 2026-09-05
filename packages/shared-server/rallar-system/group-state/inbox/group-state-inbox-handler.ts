import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { GroupFormationMutationOutcome } from '@shared/rtc/group-formation-metrics.ts';
import { type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionInput
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { GroupFormationGroupMutationSink } from '../../observability/formation-metrics.ts';
import type { WsSessionGenerationLifecycleComputed } from '../../websocket/ws-session-generation-computation.ts';
import { validateWsSessionConnectGuard } from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    AuthorizedGroupMutation,
    GroupMutationAuthority,
    GroupMutationIngress,
    GroupStateMutationCommand,
    GroupStateMutationService
} from '../group-state-service-contracts.ts';
import { GroupMutationIdempotencyConflictError } from '../group-state-service.ts';
import type { GroupMutationComputed, GroupMutationRead } from '../mutation/group-mutation-contracts.ts';
import { toGroupMutationRejectionError } from '../mutation/group-mutation-result.ts';
import {
    readAndComputeGroupPresenceConnect,
    type InactiveGroupPresenceResult
} from '../presence/group-presence-service.ts';
import { decodeGroupStateInboxAuthority } from './decode-group-state-inbox-authority.ts';
import {
    computeGroupStateInboxResult,
    validateGroupStateInboxResult,
    type ComputeGroupStateInboxResultInput,
    type GroupStateInboxDurableResult,
    type GroupStateInboxResultComputation,
    type GroupStateInboxResultReadConflict
} from './group-state-inbox-result.ts';

export interface GroupStateInboxResultReader {
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    readEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined>;
}

export interface GroupStateInboxHandlerDependencies {
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly resultReader: GroupStateInboxResultReader;
    readonly transactionWriter: Pick<
        AppInboxMutationTransactionWriter,
        'readCompletionFacts' | 'writeComputedMutation'
    >;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationGroupMutationSink;
    readonly captureAuthenticatedMutationIngress: (
        descriptor: AuthorizedGroupMutation['descriptor'],
        authority: GroupMutationAuthority
    ) => Promise<GroupMutationIngress>;
    readonly persistMutationIngress: (
        context: AppInboxMessageContext<GroupStateInboxDurableResult>,
        ingress: GroupMutationIngress
    ) => Promise<void>;
}

interface CommitGroupStateMutationInput {
    readonly context: AppInboxMessageContext<GroupStateInboxDurableResult>;
    readonly command: GroupStateMutationCommand;
    readonly computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict' | 'rejected'; }>;
    readonly durableResult: GroupStateInboxDurableResult;
    readonly completion: AppInboxCompletionComputed<GroupStateInboxDurableResult>;
    readonly lifecycleGuard?: WsSessionGenerationLifecycleComputed;
}

interface GroupStateInboxResultRead {
    readonly mutationRead: GroupMutationRead;
    readonly currentSnapshot: GroupSnapshot | undefined;
    readonly recordedEvent: GroupEvent | undefined;
}

export class GroupStateInboxHandler {
    private readonly dependencies: GroupStateInboxHandlerDependencies;

    constructor(dependencies: GroupStateInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async processGroupStateMutation(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>
    ): Promise<GroupStateInboxDurableResult | InactiveGroupPresenceResult> {
        const ingress = await this.loadOrCaptureGroupMutationIngress(context);
        const command: GroupStateMutationCommand = {
            authorityProof: ingress.authorityProof,
            descriptor: ingress.descriptor,
            command: ingress.command,
            facts: {
                ...ingress.facts,
                attemptCount: context.entry.dequeueAudit.attempts
            }
        };
        if (command.command.operation === 'connectPresence') {
            const outcome = await readAndComputeGroupPresenceConnect({
                command,
                mutationService: this.dependencies.mutationService,
                sessionGenerationLifecycle: this.dependencies.sessionGenerationLifecycle
            });
            if (outcome.status === 'inactive') {
                const completionInput = this.readCompletionInput(context, outcome);
                const completion = computeAppInboxCompletion(completionInput);
                this.assertCompletionValid(completionInput, completion);
                const durableResult = await this.dependencies.transactionWriter.writeComputedMutation(
                    context,
                    completion,
                    async () => {}
                );
                this.recordGroupMutation(command, 'rejected');
                return durableResult;
            }
            if (!isCommittableMutation(outcome.computed)) {
                this.assertMutationValid(command, outcome.read, outcome.computed);
                validateWsSessionConnectGuard(
                    outcome.lifecycleGuardFacts,
                    outcome.lifecycleRead,
                    outcome.lifecycleGuard
                );
                throwNonCommittableMutation(command, outcome.computed);
            }
            const computed = outcome.computed;
            const durableResult = computed.receipt;
            const completionInput = this.readCompletionInput(context, durableResult);
            const completion = computeAppInboxCompletion(completionInput);
            this.assertMutationValid(command, outcome.read, computed);
            validateWsSessionConnectGuard(
                outcome.lifecycleGuardFacts,
                outcome.lifecycleRead,
                outcome.lifecycleGuard
            );
            this.assertCompletionValid(completionInput, completion);
            return await this.commitMutation({
                context,
                command,
                computed,
                durableResult,
                completion,
                lifecycleGuard: outcome.lifecycleGuard
            });
        }
        const resultRead = await this.readResultFacts(command);
        const computed = this.dependencies.mutationService.compute(command, resultRead.mutationRead);
        if (!isCommittableMutation(computed)) {
            this.assertMutationValid(command, resultRead.mutationRead, computed);
            throwNonCommittableMutation(command, computed);
        }
        const resultInput = {
            command,
            read: resultRead.mutationRead,
            computed,
            currentSnapshot: resultRead.currentSnapshot,
            recordedEvent: resultRead.recordedEvent
        } as const;
        const result = computeGroupStateInboxResult(resultInput);
        this.assertInboxResultValid(resultInput, result);
        const computedResult = result.fold(
            (conflict) => {
                throw new GroupStateInboxResultReadConflictError(conflict);
            },
            (computed) => computed
        );
        const durableResult = computedResult.durableResult;
        const completionInput = this.readCompletionInput(context, durableResult);
        const completion = computeAppInboxCompletion(completionInput);
        this.assertMutationValid(command, resultRead.mutationRead, computed);
        this.assertCompletionValid(completionInput, completion);
        return await this.commitMutation({ context, command, computed, durableResult, completion });
    }

    private async readResultFacts(command: GroupStateMutationCommand): Promise<GroupStateInboxResultRead> {
        const readsSnapshot = !isPresenceOperation(command.command.operation);
        const [mutationRead, currentSnapshot] = await Promise.all([
            this.dependencies.mutationService.read(command),
            readsSnapshot
                ? this.dependencies.resultReader.readSnapshot(command.command.aggregateRef)
                : Promise.resolve(undefined)
        ]);
        const receipt = mutationRead.idempotency?.value.receipt;
        const recordedEvent =
            readsSnapshot && receipt?.commandHash === command.facts.commandHash && receipt.eventId !== null
                ? await this.dependencies.resultReader.readEvent(command.command.aggregateRef, receipt.eventId)
                : undefined;
        return { mutationRead, currentSnapshot, recordedEvent };
    }

    private async loadOrCaptureGroupMutationIngress(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>
    ): Promise<GroupMutationIngress> {
        const authority = decodeGroupStateInboxAuthority(context.enqueue.authority);
        if (authority.kind === 'ingress') {
            return authority.mutation;
        }
        const ingress = await this.dependencies.captureAuthenticatedMutationIngress(
            authority.mutation.descriptor,
            authority.mutation.authorityProof
        );
        await this.dependencies.persistMutationIngress(context, ingress);
        return ingress;
    }

    private async commitMutation(
        input: CommitGroupStateMutationInput
    ): Promise<GroupStateInboxDurableResult> {
        const durableResult = await this.dependencies.transactionWriter
            .writeComputedMutation(
                input.context,
                input.completion,
                async (transaction) => {
                    if (input.lifecycleGuard) {
                        await this.dependencies.sessionGenerationLifecycle.write(
                            transaction,
                            input.lifecycleGuard
                        );
                    }
                    if (input.computed.outcome === 'write') {
                        await this.dependencies.mutationService.write(transaction, input.computed);
                    }
                }
            );
        this.dependencies.wakeQueue?.();
        this.recordGroupMutation(
            input.command,
            input.computed.outcome === 'write'
                ? 'write'
                : 'noOp'
        );
        return durableResult;
    }

    private readCompletionInput<Result>(
        context: AppInboxMessageContext<Result>,
        durableResult: Result
    ): AppInboxCompletionInput<Result> {
        return {
            ...this.dependencies.transactionWriter.readCompletionFacts(context),
            durableResult,
            status: EntityStatus.COMPLETED
        } as const;
    }

    private assertCompletionValid<Result>(
        input: AppInboxCompletionInput<Result>,
        computed: AppInboxCompletionComputed<Result>
    ): void {
        const issues = validateAppInboxCompletion(input, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
    }

    private assertMutationValid(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
        computed: GroupMutationComputed
    ): void {
        const issue = this.dependencies.mutationService.validate(command, read, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
    }

    private assertInboxResultValid(
        input: ComputeGroupStateInboxResultInput,
        computed: GroupStateInboxResultComputation
    ): void {
        const issue = validateGroupStateInboxResult(input, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
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

class GroupStateInboxResultReadConflictError extends Error {
    readonly code = 'runtime-state-write-conflict';

    constructor(conflict: GroupStateInboxResultReadConflict) {
        super(conflict.message);
        this.name = 'GroupStateInboxResultReadConflictError';
    }
}

function isCommittableMutation(
    computed: GroupMutationComputed
): computed is Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict' | 'rejected'; }> {
    return computed.outcome !== 'idempotency-conflict' && computed.outcome !== 'rejected';
}

function throwNonCommittableMutation(
    command: GroupStateMutationCommand,
    computed: Extract<GroupMutationComputed, { outcome: 'idempotency-conflict' | 'rejected'; }>
): never {
    if (computed.outcome === 'idempotency-conflict') {
        throw new GroupMutationIdempotencyConflictError(
            command.command.commandId,
            computed.existingCommandHash,
            computed.receivedCommandHash
        );
    }
    throw toGroupMutationRejectionError(computed);
}

function isPresenceOperation(operation: GroupStateMutationCommand['command']['operation']): boolean {
    return operation === 'connectPresence' || operation === 'heartbeatPresence' || operation === 'disconnectPresence';
}
