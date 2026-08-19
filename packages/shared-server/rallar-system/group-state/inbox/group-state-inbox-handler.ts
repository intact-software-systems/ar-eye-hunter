import { createTransactionBoundGroupStateRepository } from '../persistence/group-state-repository.ts';
import {
  type InactiveGroupPresenceResult,
  processGroupPresenceConnect,
} from '../presence/group-presence-service.ts';
import type { AppInboxMessageContext } from '../../services/AppInboxService.ts';
import type { AppInboxMutationTransactionWriter } from '../../services/app-inbox-transaction-writer.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
import type {
  WsSessionGenerationLifecycleComputed,
  WsSessionGenerationLifecycleService,
} from '../../services/ws-session-generation-lifecycle.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
import type {
  GroupMutationPreparation,
  GroupStateMutationCommand,
  GroupStateMutationService,
  GroupStateService,
} from '../group-state-service-contracts.ts';
import type {
  GroupFormationGroupMutationSink,
  GroupFormationMutationOutcome,
} from '../../formation-metrics.ts';
import {
  readGroupStateInboxResult,
  type GroupStateInboxDurableResult,
} from './group-state-inbox-result.ts';

export interface GroupStateInboxHandlerDependencies {
  readonly mutationService: GroupStateMutationService;
  readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
  readonly snapshotObserver: Pick<GroupStateService, 'observeSnapshot'>;
  readonly transactionWriter: AppInboxMutationTransactionWriter;
  readonly wakeQueue?: () => void;
  readonly formationMetrics?: GroupFormationGroupMutationSink;
}

interface CommitGroupStateMutationInput {
  readonly context: AppInboxMessageContext;
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
    context: AppInboxMessageContext,
  ): Promise<GroupStateInboxDurableResult | InactiveGroupPresenceResult> {
    const prepared = readGroupMutationPreparation(context.enqueue.authority);
    const command: GroupStateMutationCommand = {
      authorityProof: prepared.authorityProof,
      descriptor: prepared.descriptor,
      command: prepared.command,
      facts: {
        ...prepared.facts,
        attemptCount: context.entry.dequeueAudit.attempts,
      },
    };
    if (command.command.operation === 'connectPresence') {
      const outcome = await processGroupPresenceConnect({
        command,
        mutationService: this.dependencies.mutationService,
        sessionGenerationLifecycle: this.dependencies.sessionGenerationLifecycle,
      });
      if (outcome.status === 'inactive') {
        const durableResult = await this.dependencies.transactionWriter.writeMutation(context, () =>
          Promise.resolve(outcome),
        );
        this.recordGroupMutation(command, 'rejected');
        return durableResult;
      }
      return await this.commitMutation({
        context,
        command,
        computed: outcome.computed,
        lifecycleGuard: outcome.lifecycleGuard,
      });
    }
    const read = await this.dependencies.mutationService.read(command);
    const computed = this.dependencies.mutationService.compute(command, read);
    this.dependencies.mutationService.validate(command, read, computed);
    return await this.commitMutation({ context, command, computed });
  }

  private async commitMutation(
    input: CommitGroupStateMutationInput,
  ): Promise<GroupStateInboxDurableResult> {
    const { durableResult, afterCommitResult } =
      await this.dependencies.transactionWriter.writeMutationWithAfterCommitResult(
        input.context,
        async (transaction) => {
          if (input.lifecycleGuard) {
            await this.dependencies.sessionGenerationLifecycle.write(
              transaction,
              input.lifecycleGuard,
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
            receipt: input.computed.receipt,
          });
          return {
            durableResult: inboxResult.durableResult,
            afterCommitResult: { committedSnapshot: inboxResult.committedSnapshot },
          };
        },
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
        : input.computed.outcome === 'rejected'
          ? 'rejected'
          : 'noOp',
    );
    return durableResult;
  }

  private recordGroupMutation(
    command: GroupStateMutationCommand,
    outcome: GroupFormationMutationOutcome,
  ): void {
    try {
      this.dependencies.formationMetrics?.({
        operation: command.command.operation,
        outcome,
      });
    } catch {
      // Recording must never affect group mutation behavior.
    }
  }
}

function readGroupMutationPreparation(value: unknown): GroupMutationPreparation {
  const expectedKeys = [
    'authorityProof',
    'descriptor',
    'command',
    'facts',
    'causalToken',
    'queueResourceId',
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
    throw new GroupMutationAuthorizationError(
      'App inbox durable group mutation facts are malformed.',
    );
  }
  return value as GroupMutationPreparation;
}

function isAuthorityProofOrNull(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      value !== null &&
      'version' in value &&
      value.version === 1)
  );
}

function isRecordOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'object' && !Array.isArray(value) && value !== null);
}
