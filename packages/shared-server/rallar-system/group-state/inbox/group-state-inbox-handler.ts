import type { GroupFormationMutationOutcome } from '@shared/rtc/group-formation-metrics.ts';
import { type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/app-inbox-transaction-writer.ts';
import type { GroupFormationGroupMutationSink } from '../../observability/formation-metrics.ts';
import type { WsSessionGenerationLifecycleComputed } from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    AuthorizedGroupMutation,
    GroupMutationAuthority,
    GroupMutationPreparation,
    GroupStateMutationCommand,
    GroupStateMutationService,
    GroupStateService
} from '../group-state-service-contracts.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
import { toGroupMutationRejectionError } from '../mutation/group-mutation-result.ts';
import { createTransactionBoundGroupStateRepository } from '../persistence/group-state-repository.ts';
import { processGroupPresenceConnect, type InactiveGroupPresenceResult } from '../presence/group-presence-service.ts';
import { decodeGroupStateInboxAuthority } from './decode-group-state-inbox-authority.ts';
import { readGroupStateInboxResult, type GroupStateInboxDurableResult } from './group-state-inbox-result.ts';

export interface GroupStateInboxHandlerDependencies {
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly snapshotObserver: Pick<GroupStateService, 'observeSnapshot'>;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationGroupMutationSink;
    readonly prepareMutation: (
        descriptor: AuthorizedGroupMutation['descriptor'],
        authority: GroupMutationAuthority
    ) => Promise<GroupMutationPreparation>;
    readonly persistPreparation: (
        context: AppInboxMessageContext<GroupStateInboxDurableResult>,
        preparation: GroupMutationPreparation
    ) => Promise<void>;
}

interface CommitGroupStateMutationInput {
    readonly context: AppInboxMessageContext<GroupStateInboxDurableResult>;
    readonly command: GroupStateMutationCommand;
    readonly computed: GroupMutationComputed;
    readonly lifecycleGuard?: WsSessionGenerationLifecycleComputed;
}

export class GroupStateInboxHandler {
    private readonly dependencies: GroupStateInboxHandlerDependencies;

    constructor(dependencies: GroupStateInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async processGroupStateMutation(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>
    ): Promise<GroupStateInboxDurableResult | InactiveGroupPresenceResult> {
        const prepared = await this.readOrPrepareGroupMutation(context);
        const command: GroupStateMutationCommand = {
            authorityProof: prepared.authorityProof,
            descriptor: prepared.descriptor,
            command: prepared.command,
            facts: {
                ...prepared.facts,
                attemptCount: context.entry.dequeueAudit.attempts
            }
        };
        if (command.command.operation === 'connectPresence') {
            const outcome = await processGroupPresenceConnect({
                command,
                mutationService: this.dependencies.mutationService,
                sessionGenerationLifecycle: this.dependencies.sessionGenerationLifecycle
            });
            if (outcome.status === 'inactive') {
                const durableResult = await this.dependencies.transactionWriter.writeMutation(
                    context,
                    () => Promise.resolve(outcome)
                );
                this.recordGroupMutation(command, 'rejected');
                return durableResult;
            }
            return await this.commitMutation({
                context,
                command,
                computed: outcome.computed,
                lifecycleGuard: outcome.lifecycleGuard
            });
        }
        const read = await this.dependencies.mutationService.read(command);
        const computed = this.dependencies.mutationService.compute(command, read);
        this.dependencies.mutationService.validate(command, read, computed);
        return await this.commitMutation({ context, command, computed });
    }

    private async readOrPrepareGroupMutation(
        context: AppInboxMessageContext<GroupStateInboxDurableResult>
    ): Promise<GroupMutationPreparation> {
        const authority = decodeGroupStateInboxAuthority(context.enqueue.authority);
        if (authority.kind === 'prepared') {
            return authority.mutation;
        }
        const materialized = await this.dependencies.prepareMutation(
            authority.mutation.descriptor,
            authority.mutation.authorityProof
        );
        await this.dependencies.persistPreparation(context, materialized);
        return materialized;
    }

    private async commitMutation(
        input: CommitGroupStateMutationInput
    ): Promise<GroupStateInboxDurableResult> {
        if (input.computed.outcome === 'rejected') {
            throw toGroupMutationRejectionError(input.computed);
        }
        const { durableResult, afterCommitResult } = await this.dependencies.transactionWriter
            .writeMutationWithAfterCommitResult(
                input.context,
                async (transaction) => {
                    if (input.lifecycleGuard) {
                        await this.dependencies.sessionGenerationLifecycle.write(
                            transaction,
                            input.lifecycleGuard
                        );
                    }
                    if (input.computed.outcome === 'idempotency-conflict') {
                        throw new TypeError('Validated group idempotency conflict is unreachable');
                    }
                    if (input.computed.outcome === 'write') {
                        await this.dependencies.mutationService.write(transaction, input.computed);
                    }
                    const inboxResult = await readGroupStateInboxResult({
                        repository: createTransactionBoundGroupStateRepository(transaction),
                        command: input.command,
                        receipt: input.computed.receipt
                    });
                    return {
                        durableResult: inboxResult.durableResult,
                        afterCommitResult: { committedSnapshot: inboxResult.committedSnapshot }
                    };
                }
            );
        const { committedSnapshot } = afterCommitResult;
        if (committedSnapshot) {
            await this.dependencies.snapshotObserver.observeSnapshot(committedSnapshot);
        }
        this.dependencies.wakeQueue?.();
        this.recordGroupMutation(
            input.command,
            input.computed.outcome === 'write'
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
