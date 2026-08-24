import { type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/app-inbox-transaction-writer.ts';
import type {
    GroupFormationGroupMutationSink,
    GroupFormationMutationOutcome
} from '../../observability/formation-metrics.ts';
import type { WsSessionGenerationLifecycleComputed } from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
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
        const prepared = readGroupMutationPreparation(context.enqueue.authority);
        if (prepared) {
            return prepared;
        }
        const authorized = readAuthorizedGroupMutation(context.enqueue.authority);
        const materialized = await this.dependencies.prepareMutation(
            authorized.descriptor,
            authorized.authorityProof
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

function readGroupMutationPreparation(value: unknown): GroupMutationPreparation | undefined {
    const expectedKeys = [
        'authorityProof',
        'descriptor',
        'command',
        'facts',
        'causalToken',
        'queueResourceId'
    ].toSorted();
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expectedKeys) ||
        !('authorityProof' in value) ||
        !isAuthorityProofOrNull(value.authorityProof) ||
        !('descriptor' in value) ||
        !isRecordOrNull(value.descriptor) ||
        !('command' in value) ||
        !value.command ||
        typeof value.command !== 'object' ||
        !('facts' in value) ||
        !value.facts ||
        typeof value.facts !== 'object' ||
        !('causalToken' in value) ||
        typeof value.causalToken !== 'string' ||
        !('queueResourceId' in value) ||
        typeof value.queueResourceId !== 'string'
    ) {
        return undefined;
    }
    return value as GroupMutationPreparation;
}

function readAuthorizedGroupMutation<Value>(value: Value): AuthorizedGroupMutation {
    const expectedKeys = ['authorityProof', 'descriptor'].toSorted();
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expectedKeys) ||
        !('authorityProof' in value) ||
        !isAuthorityProofOrNull(value.authorityProof) ||
        value.authorityProof === null ||
        !('descriptor' in value) ||
        !isRecordOrNull(value.descriptor) ||
        value.descriptor === null
    ) {
        throw new GroupMutationAuthorizationError(
            'App inbox authenticated group mutation intent is malformed.'
        );
    }
    return value as AuthorizedGroupMutation;
}

function isAuthorityProofOrNull(value: unknown): boolean {
    if (value === null) {
        return true;
    }
    const expectedKeys = [
        'commandMac',
        'principalId',
        'sessionExpiresAtEpochMs',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'version'
    ];
    return (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(expectedKeys) &&
        'version' in value &&
        value.version === 1 &&
        'principalId' in value &&
        typeof value.principalId === 'string' &&
        'sessionId' in value &&
        typeof value.sessionId === 'string' &&
        'sessionIssuedAtEpochMs' in value &&
        typeof value.sessionIssuedAtEpochMs === 'number' &&
        'sessionExpiresAtEpochMs' in value &&
        typeof value.sessionExpiresAtEpochMs === 'number' &&
        'commandMac' in value &&
        typeof value.commandMac === 'string'
    );
}

function isRecordOrNull(value: unknown): boolean {
    return value === null || (typeof value === 'object' && !Array.isArray(value) && value !== null);
}
