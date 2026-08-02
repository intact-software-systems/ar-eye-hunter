import type { GroupSnapshot } from '@shared/api/group-types.ts';

import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
// prettier-ignore
import { createTransactionBoundGroupStateRepository } from
  '../persistence/group-state-repository.ts';
import {
  type InactiveGroupPresenceResult,
  processGroupPresenceConnect,
} from '../presence/group-presence-service.ts';
import type { AppInboxMessageContext } from '../../services/AppInboxService.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
// prettier-ignore
import type { WsSessionGenerationLifecycleComputed } from
  '../../services/ws-session-generation-lifecycle.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
import type {
  GroupMutationPreparation,
  GroupStateMutationCommand,
  GroupStateService,
} from '../group-state-service-contracts.ts';
import {
  readGroupStateInboxResult,
  type GroupStateInboxDurableResult,
} from './group-state-inbox-result.ts';

export interface GroupStateInboxHandlerDependencies {
  readonly groupStateService: GroupStateService;
  readonly writeMutation: <Result>(
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<Result>,
  ) => Promise<Result>;
  readonly wakeQueue?: () => void;
}

interface CommitGroupStateMutationInput {
  readonly context: AppInboxMessageContext;
  readonly command: GroupStateMutationCommand;
  readonly computed: GroupMutationComputed;
  readonly lifecycleGuard?: WsSessionGenerationLifecycleComputed;
}

export class GroupStateInboxHandler {
  constructor(private readonly dependencies: GroupStateInboxHandlerDependencies) {}

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
      return await processGroupPresenceConnect({
        command,
        groupStateService: this.dependencies.groupStateService,
        writeMutation: async (write) => await this.dependencies.writeMutation(context, write),
        commitMutation: async (computed, lifecycleGuard) =>
          await this.commitMutation({ context, command, computed, lifecycleGuard }),
      });
    }
    const read = await this.dependencies.groupStateService.read(command);
    const computed = this.dependencies.groupStateService.compute(command, read);
    this.dependencies.groupStateService.validate(command, read, computed);
    return await this.commitMutation({ context, command, computed });
  }

  private async commitMutation(
    input: CommitGroupStateMutationInput,
  ): Promise<GroupStateInboxDurableResult> {
    let committedSnapshot: GroupSnapshot | undefined;
    const result = await this.dependencies.writeMutation(input.context, async (transaction) => {
      if (input.lifecycleGuard) {
        await this.dependencies.groupStateService.sessionGenerationLifecycle.write(
          transaction,
          input.lifecycleGuard,
        );
      }
      if (input.computed.outcome === 'idempotency-conflict') {
        throw new TypeError('Validated group idempotency conflict is unreachable');
      }
      if (input.computed.outcome === 'write') {
        await this.dependencies.groupStateService.write(transaction, input.computed);
      }
      const inboxResult = await readGroupStateInboxResult({
        repository: createTransactionBoundGroupStateRepository(transaction),
        command: input.command,
        receipt: input.computed.receipt,
      });
      committedSnapshot = inboxResult.committedSnapshot;
      return inboxResult.durableResult;
    });
    if (committedSnapshot) {
      await this.dependencies.groupStateService.observeSnapshot(committedSnapshot);
    }
    this.dependencies.wakeQueue?.();
    return result;
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
