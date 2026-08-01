import type { GroupSnapshot } from '@shared/api/group-types.ts';

import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
// prettier-ignore
import { createTransactionBoundGroupStateRepository } from
  '../persistence/group-state-repository.ts';
import {
  type InactiveGroupPresenceResult,
  processGroupPresenceConnect,
} from '../presence/group-presence-service.ts';
import type {
  AppInboxEnqueueInput,
  AppInboxMessageContext,
} from '../../services/AppInboxService.ts';
import { AppInboxType } from '../../services/AppInboxService.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
// prettier-ignore
import type { WsSessionGenerationLifecycleComputed } from
  '../../services/ws-session-generation-lifecycle.ts';
import {
  GroupMutationAuthorizationError,
  mutationDescriptor,
} from '../group-mutation-authority.ts';
import type {
  GroupMutationDescriptor,
  GroupMutationPreparation,
  GroupStateMutationCommand,
  GroupStateService,
} from '../group-state-service-contracts.ts';
import {
  type GroupCreateAppInboxPayload,
  type GroupDirectorAppointAppInboxPayload,
  type GroupInviteAcceptAppInboxPayload,
  type GroupInviteCreateAppInboxPayload,
  type GroupInviteRevokeAppInboxPayload,
  type GroupJoinAppInboxPayload,
  type GroupJoinCodeRotateAppInboxPayload,
  type GroupMemberRemoveAppInboxPayload,
  type GroupMemberRoleSetAppInboxPayload,
  type GroupMemberUpsertAppInboxPayload,
  type GroupOwnershipTransferAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
  type GroupPresenceDisconnectAppInboxPayload,
  type GroupPresenceHeartbeatAppInboxPayload,
  type GroupUpdateAppInboxPayload,
} from './group-state-inbox-contracts.ts';
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

  async processMutation(
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

  toMutationDescriptor<V>(enqueue: AppInboxEnqueueInput<V>): GroupMutationDescriptor {
    return toGroupMutationDescriptor(enqueue);
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

function toGroupMutationDescriptor<V>(enqueue: AppInboxEnqueueInput<V>): GroupMutationDescriptor {
  switch (enqueue.type) {
    case AppInboxType.GROUP_CREATE:
    case AppInboxType.GROUP_UPDATE:
    case AppInboxType.GROUP_DIRECTOR_APPOINT:
    case AppInboxType.GROUP_JOIN_CODE_ROTATE:
      return toAggregateMutationDescriptor(enqueue);
    case AppInboxType.GROUP_JOIN:
    case AppInboxType.GROUP_INVITE_CREATE:
    case AppInboxType.GROUP_INVITE_REVOKE:
    case AppInboxType.GROUP_INVITE_ACCEPT:
      return toAdmissionMutationDescriptor(enqueue);
    case AppInboxType.GROUP_MEMBER_REMOVE:
    case AppInboxType.GROUP_MEMBER_BAN:
    case AppInboxType.GROUP_MEMBER_UNBAN:
    case AppInboxType.GROUP_MEMBER_ROLE_SET:
    case AppInboxType.GROUP_OWNERSHIP_TRANSFER:
    case AppInboxType.GROUP_MEMBER_UPSERT:
      return toGovernanceMutationDescriptor(enqueue);
    case AppInboxType.GROUP_PRESENCE_CONNECT:
    case AppInboxType.GROUP_PRESENCE_HEARTBEAT:
    case AppInboxType.GROUP_PRESENCE_DISCONNECT:
      return toPresenceMutationDescriptor(enqueue);
    default:
      throw new GroupMutationAuthorizationError(
        'App inbox type is not an authenticated group mutation.',
      );
  }
}

function toAggregateMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
  switch (enqueue.type) {
    case AppInboxType.GROUP_CREATE: {
      const payload = enqueue.data as GroupCreateAppInboxPayload;
      return mutationDescriptor(
        'createGroup',
        payload.scope,
        payload.request.groupId,
        payload.request,
      );
    }
    case AppInboxType.GROUP_UPDATE: {
      const payload = enqueue.data as GroupUpdateAppInboxPayload;
      return mutationDescriptor('updateGroup', payload.scope, payload.groupId, payload.request);
    }
    case AppInboxType.GROUP_DIRECTOR_APPOINT: {
      const payload = enqueue.data as GroupDirectorAppointAppInboxPayload;
      return mutationDescriptor('appointDirector', payload.scope, payload.groupId, payload.request);
    }
    case AppInboxType.GROUP_JOIN_CODE_ROTATE: {
      const payload = enqueue.data as GroupJoinCodeRotateAppInboxPayload;
      return mutationDescriptor(
        'rotateGroupJoinCode',
        payload.scope,
        payload.groupId,
        payload.request,
      );
    }
    default:
      throw new TypeError(`Unsupported aggregate AppInbox type: ${enqueue.type}`);
  }
}

function toAdmissionMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
  switch (enqueue.type) {
    case AppInboxType.GROUP_JOIN: {
      const payload = enqueue.data as GroupJoinAppInboxPayload;
      return mutationDescriptor('joinGroup', payload.scope, payload.groupId, payload.request);
    }
    case AppInboxType.GROUP_INVITE_CREATE: {
      const payload = enqueue.data as GroupInviteCreateAppInboxPayload;
      return mutationDescriptor(
        'createGroupInvite',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.principalId,
      );
    }
    case AppInboxType.GROUP_INVITE_REVOKE: {
      const payload = enqueue.data as GroupInviteRevokeAppInboxPayload;
      return mutationDescriptor(
        'revokeGroupInvite',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.principalId,
      );
    }
    case AppInboxType.GROUP_INVITE_ACCEPT: {
      const payload = enqueue.data as GroupInviteAcceptAppInboxPayload;
      return mutationDescriptor(
        'acceptGroupInvite',
        payload.scope,
        payload.groupId,
        payload.request,
      );
    }
    default:
      throw new TypeError(`Unsupported admission AppInbox type: ${enqueue.type}`);
  }
}

function toGovernanceMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
  if (
    enqueue.type === AppInboxType.GROUP_MEMBER_REMOVE ||
    enqueue.type === AppInboxType.GROUP_MEMBER_BAN ||
    enqueue.type === AppInboxType.GROUP_MEMBER_UNBAN
  ) {
    const payload = enqueue.data as GroupMemberRemoveAppInboxPayload;
    const operation =
      enqueue.type === AppInboxType.GROUP_MEMBER_REMOVE
        ? 'removeGroupMember'
        : enqueue.type === AppInboxType.GROUP_MEMBER_BAN
          ? 'banGroupMember'
          : 'unbanGroupMember';
    return mutationDescriptor(
      operation,
      payload.scope,
      payload.groupId,
      payload.request,
      payload.principalId,
    );
  }
  return toGovernanceSpecialMutationDescriptor(enqueue);
}

function toGovernanceSpecialMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
  switch (enqueue.type) {
    case AppInboxType.GROUP_MEMBER_ROLE_SET: {
      const payload = enqueue.data as GroupMemberRoleSetAppInboxPayload;
      return mutationDescriptor(
        'setGroupMemberRole',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.principalId,
      );
    }
    case AppInboxType.GROUP_OWNERSHIP_TRANSFER: {
      const payload = enqueue.data as GroupOwnershipTransferAppInboxPayload;
      return mutationDescriptor(
        'transferGroupOwnership',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.request.newOwnerPrincipalId,
      );
    }
    case AppInboxType.GROUP_MEMBER_UPSERT: {
      const payload = enqueue.data as GroupMemberUpsertAppInboxPayload;
      return mutationDescriptor(
        'upsertMember',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.principalId,
      );
    }
    default:
      throw new TypeError(`Unsupported governance AppInbox type: ${enqueue.type}`);
  }
}

function toPresenceMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
  switch (enqueue.type) {
    case AppInboxType.GROUP_PRESENCE_CONNECT: {
      const payload = enqueue.data as GroupPresenceConnectAppInboxPayload;
      return mutationDescriptor(
        'connectPresence',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.request.principalId,
        payload.sessionId,
      );
    }
    case AppInboxType.GROUP_PRESENCE_HEARTBEAT: {
      const payload = enqueue.data as GroupPresenceHeartbeatAppInboxPayload;
      return mutationDescriptor(
        'heartbeatPresence',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.request.principalId ?? null,
        payload.sessionId,
      );
    }
    case AppInboxType.GROUP_PRESENCE_DISCONNECT: {
      const payload = enqueue.data as GroupPresenceDisconnectAppInboxPayload;
      return mutationDescriptor(
        'disconnectPresence',
        payload.scope,
        payload.groupId,
        payload.request,
        payload.request.principalId ?? null,
        payload.sessionId,
      );
    }
    default:
      throw new TypeError(`Unsupported presence AppInbox type: ${enqueue.type}`);
  }
}
