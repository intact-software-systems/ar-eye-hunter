import { toGroupLayoutIdentity, type GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type {
    GroupEvent,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
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
import { nowMs, recordRallarTiming, type RallarTimingSink } from '../../observability/timing.ts';
import type { WsSessionGenerationLifecycleComputed } from '../../websocket/ws-session-generation-computation.ts';
import { validateWsSessionConnectGuard } from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    GroupMutationIngress,
    GroupStateMutationCommand,
    GroupStateMutationService
} from '../group-state-service-contracts.ts';
import { GroupMutationIdempotencyConflictError } from '../group-state-service.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationRead
} from '../mutation/group-mutation-contracts.ts';
import { toGroupMutationRejectionError } from '../mutation/group-mutation-result.ts';
import { toGroupMutationAttemptFacts } from '../mutation/to-group-mutation-attempt-facts.ts';
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
    readEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined>;
}

/** A timing sink and the service its lines name. */
export interface GroupStateInboxTiming {
    readonly sink: RallarTimingSink;
    readonly serviceId: string;
}

interface PlannedLayoutPromotionAttempt {
    readonly command: Extract<GroupMutationCommand, { operation: 'applyPlannedLayout'; }>;
    readonly read: GroupMutationRead;
    readonly computed: GroupMutationComputed;
    readonly startedAtMs: number;
}

export interface GroupStateInboxHandlerDependencies {
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly resultReader: GroupStateInboxResultReader;
    readonly transactionWriter: Pick<
        AppInboxMutationTransactionWriter,
        'readCompletionFacts' | 'writeComputedMutation'
    >;
    /** Present while the service is timed; a layout promotion attempt then reports as `group-topology-publication`. */
    readonly publicationTiming: GroupStateInboxTiming | undefined;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationGroupMutationSink;
    readonly nowEpochMs: () => number;
}

interface CommitGroupStateMutationInput {
    readonly context: AppInboxMessageContext<GroupStateInboxDurableResult>;
    readonly command: GroupStateMutationCommand;
    readonly computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict' | 'rejected'; }>;
    readonly durableResult: GroupStateInboxDurableResult;
    readonly completion: AppInboxCompletionComputed<GroupStateInboxDurableResult>;
    readonly lifecycleGuard?: WsSessionGenerationLifecycleComputed;
    /** A layout promotion's timing line, recorded once its transaction committed. */
    readonly promotion?: PlannedLayoutPromotionAttempt;
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

    /** The queued command carries the ingress its enqueue captured; every attempt reuses those facts. */
    async processGroupStateMutation(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>
    ): Promise<GroupStateInboxDurableResult | InactiveGroupPresenceResult> {
        return await this.processCapturedMutation(context, decodeGroupStateInboxAuthority(context.enqueue.authority));
    }

    private async processCapturedMutation(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>,
        ingress: GroupMutationIngress
    ): Promise<GroupStateInboxDurableResult | InactiveGroupPresenceResult> {
        const command: GroupStateMutationCommand = {
            authorityProof: ingress.authorityProof,
            descriptor: ingress.descriptor,
            command: ingress.command,
            facts: toGroupMutationAttemptFacts(
                ingress.facts,
                context.entry.dequeueAudit.attempts,
                this.dependencies.nowEpochMs()
            )
        };
        if (command.command.operation === 'connectPresence') {
            return await this.processPresenceConnect(context, command);
        }
        const startedAtMs = nowMs();
        const resultRead = await this.readResultFacts(command);
        const computed = this.dependencies.mutationService.compute(command, resultRead.mutationRead);
        const promotion = command.command.operation === 'applyPlannedLayout'
            ? { command: command.command, read: resultRead.mutationRead, computed, startedAtMs }
            : undefined;
        if (!isCommittableMutation(computed)) {
            this.validateMutation(command, resultRead.mutationRead, computed);
            if (promotion !== undefined) {
                this.recordPlannedLayoutPromotion(promotion);
            }
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
        const computedResult = result.fold(
            (conflict) => {
                throw new GroupStateInboxResultReadConflictError(conflict);
            },
            (computed) => computed
        );
        const durableResult = computedResult.durableResult;
        const completionInput = this.readCompletionInput(context, durableResult);
        const completion = computeAppInboxCompletion(completionInput);
        this.validateMutation(command, resultRead.mutationRead, computed);
        this.validateInboxResult(resultInput, result);
        this.validateCompletion(completionInput, completion);
        return await this.commitMutation({ context, command, computed, durableResult, completion, promotion });
    }

    private async processPresenceConnect(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>,
        command: GroupStateMutationCommand
    ): Promise<GroupStateInboxDurableResult | InactiveGroupPresenceResult> {
        const outcome = await readAndComputeGroupPresenceConnect({
            command,
            mutationService: this.dependencies.mutationService,
            sessionGenerationLifecycle: this.dependencies.sessionGenerationLifecycle
        });
        if (outcome.status === 'inactive') {
            const completionInput = this.readCompletionInput(context, outcome);
            const completion = computeAppInboxCompletion(completionInput);
            this.validateCompletion(completionInput, completion);
            const durableResult = await this.dependencies.transactionWriter.writeComputedMutation(
                context,
                completion,
                async () => {}
            );
            this.recordGroupMutation(command, 'rejected');
            return durableResult;
        }
        if (!isCommittableMutation(outcome.computed)) {
            this.validateMutation(command, outcome.read, outcome.computed);
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
        this.validateMutation(command, outcome.read, computed);
        validateWsSessionConnectGuard(
            outcome.lifecycleGuardFacts,
            outcome.lifecycleRead,
            outcome.lifecycleGuard
        );
        this.validateCompletion(completionInput, completion);
        return await this.commitMutation({
            context,
            command,
            computed,
            durableResult,
            completion,
            lifecycleGuard: outcome.lifecycleGuard
        });
    }

    private async readResultFacts(command: GroupStateMutationCommand): Promise<GroupStateInboxResultRead> {
        if (isPresenceOperation(command.command.operation)) {
            const mutationRead = await this.dependencies.mutationService.read(command);
            return { mutationRead, currentSnapshot: undefined, recordedEvent: undefined };
        }
        const { read: mutationRead, currentSnapshot } = await this.dependencies.mutationService.readWithSnapshot(
            command
        );
        const receipt = mutationRead.idempotency?.value.receipt;
        const recordedEvent = receipt?.commandHash === command.facts.commandHash && receipt.eventId !== null
            ? await this.dependencies.resultReader.readEvent(command.command.aggregateRef, receipt.eventId)
            : undefined;
        return { mutationRead, currentSnapshot, recordedEvent };
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
        if (input.promotion !== undefined) {
            this.recordPlannedLayoutPromotion(input.promotion);
        }
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

    private validateCompletion<Result>(
        input: AppInboxCompletionInput<Result>,
        computed: AppInboxCompletionComputed<Result>
    ): void {
        const issues = validateAppInboxCompletion(input, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
    }

    private validateMutation(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
        computed: GroupMutationComputed
    ): void {
        const issue = this.dependencies.mutationService.validate(command, read, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
    }

    private validateInboxResult(
        input: ComputeGroupStateInboxResultInput,
        computed: GroupStateInboxResultComputation
    ): void {
        const issue = validateGroupStateInboxResult(input, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
    }

    private recordPlannedLayoutPromotion(attempt: PlannedLayoutPromotionAttempt): void {
        const timing = this.dependencies.publicationTiming;
        if (timing === undefined) {
            return;
        }
        const { command, read, computed } = attempt;
        recordRallarTiming({
            sink: timing.sink,
            event: {
                component: 'group-topology-publication',
                operation: 'promote',
                serviceId: timing.serviceId,
                requestId: command.requestId ?? undefined,
                applicationId: command.aggregateRef.applicationId,
                workspaceId: command.aggregateRef.workspaceId,
                groupId: command.aggregateRef.groupId,
                details: {
                    expected: toLayoutIdentityLabel(command.input.expectedLayout),
                    planned: read.plannedLayoutRow === null
                        ? 'none'
                        : toLayoutIdentityLabel(toGroupLayoutIdentity(read.plannedLayoutRow.snapshot)),
                    outcome: toPlannedLayoutPromotionOutcome(computed),
                    rejection: computed.outcome === 'rejected' ? computed.receipt.rejection ?? undefined : undefined
                }
            },
            status: 'ok',
            durationMs: nowMs() - attempt.startedAtMs
        });
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

function toPlannedLayoutPromotionOutcome(computed: GroupMutationComputed): string {
    switch (computed.outcome) {
        case 'write':
            return computed.acceptedLayoutPromotion?.promoted === 'newer' ? 'promoted-newer' : 'promoted';
        case 'no-op':
            return 'already-applied';
        default:
            return computed.outcome;
    }
}

function toLayoutIdentityLabel(identity: GroupLayoutIdentity | null): string {
    return identity === null
        ? 'none'
        : `group=${identity.groupRevision};presence=${identity.presenceRevision};version=${identity.version};state=${identity.state}`;
}

function isPresenceOperation(operation: GroupStateMutationCommand['command']['operation']): boolean {
    return operation === 'connectPresence' || operation === 'heartbeatPresence' || operation === 'disconnectPresence';
}
