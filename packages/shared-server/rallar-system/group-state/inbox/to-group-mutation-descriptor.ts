import {
  GroupMutationAuthorizationError,
  mutationDescriptor,
} from '../group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '../group-state-service-contracts.ts';
import type { AppInboxEnqueueInput } from '../../services/AppInboxService.ts';
import { AppInboxType } from '../../services/AppInboxService.ts';
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

export function toGroupMutationDescriptor<V>(
  enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
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
