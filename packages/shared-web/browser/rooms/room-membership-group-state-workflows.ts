import {
  acceptStateGroupInvite as acceptStateGroupInviteApi,
  banStateGroupMember as banStateGroupMemberApi,
  connectStateGroupPresenceSession,
  createStateGroupInvite as createStateGroupInviteApi,
  defaultStateScope,
  removeStateGroupMember as removeStateGroupMemberApi,
  setStateGroupMemberRole as setStateGroupMemberRoleApi,
  transferStateGroupOwnership as transferStateGroupOwnershipApi,
  unbanStateGroupMember as unbanStateGroupMemberApi,
} from '@shared-web/browser/api-integration.ts';
import {
  requireStateWorkflowResult,
  toStateWorkflowRequestId,
} from '@shared-web/browser/state-workflow-support.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import {
  toAcceptRoomInviteGroupStateRequest,
  toBanRoomMemberGroupStateRequest,
  toConnectRoomPresenceGroupStateRequest,
  toCreateRoomInviteGroupStateRequest,
  toRemoveRoomMemberGroupStateRequest,
  toSetRoomMemberRoleGroupStateRequest,
  toTransferRoomOwnershipGroupStateRequest,
  toUnbanRoomMemberGroupStateRequest,
  type BanGroupMemberRequest,
  type CreateGroupInviteRequest,
  type GroupSnapshot,
  type RemoveGroupMemberRequest,
  type SetGroupMemberRoleRequest,
  type StateScope,
  type TransferGroupOwnershipRequest,
  type UnbanGroupMemberRequest,
} from './room-group-state-translation.ts';
import type { StateGroupWorkflowValue } from './room-group-state-workflows.ts';

type InviteWorkflowKey = 'accepted' | 'joined';

export async function createStateGroupInvite(
  groupId: string,
  targetPrincipalId: string,
  request: CreateGroupInviteRequest,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const requestId =
    request.requestId ??
    toStateWorkflowRequestId('group-invite-create', groupId, targetPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const inviteRequest = toCreateRoomInviteGroupStateRequest({
    request,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      createStateGroupInviteApi(groupId, targetPrincipalId, inviteRequest, scope, {
        signal,
      }),
    commandOptions,
  ).run();
}

export async function acceptStateGroupInvite(
  groupId: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const acceptRequestId = toStateWorkflowRequestId('group-invite-accept', groupId, principalId);
  const presenceRequestId = toStateWorkflowRequestId('group-presence-connect', groupId, sessionId);
  const acceptRequest = toAcceptRoomInviteGroupStateRequest({
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: acceptRequestId,
  });
  const presenceRequest = toConnectRoomPresenceGroupStateRequest({
    principalId,
    generationId,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: presenceRequestId,
  });
  const flow = CommandsOrchestrator.withPolicies<InviteWorkflowKey, StateGroupWorkflowValue>(
    policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep('accepted', (signal) =>
        acceptStateGroupInviteApi(groupId, acceptRequest, scope, { signal }),
      ),
      flow.commandStep('joined', (signal) =>
        connectStateGroupPresenceSession(groupId, sessionId, presenceRequest, scope, {
          signal,
        }),
      ),
    )
    .run();

  return requireStateWorkflowResult(results, 'joined');
}

export async function removeStateGroupMember(
  groupId: string,
  targetPrincipalId: string,
  request: RemoveGroupMemberRequest,
  actorPrincipalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const requestId =
    request.requestId ??
    toStateWorkflowRequestId('group-member-remove', groupId, targetPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const removeRequest = toRemoveRoomMemberGroupStateRequest({
    request,
    actorPrincipalId,
    actorSessionId: sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      removeStateGroupMemberApi(groupId, targetPrincipalId, removeRequest, scope, { signal }),
    commandOptions,
  ).run();
}

export async function banStateGroupMember(
  groupId: string,
  targetPrincipalId: string,
  request: BanGroupMemberRequest,
  actorPrincipalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const requestId =
    request.requestId ?? toStateWorkflowRequestId('group-member-ban', groupId, targetPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const banRequest = toBanRoomMemberGroupStateRequest({
    request,
    actorPrincipalId,
    actorSessionId: sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) => banStateGroupMemberApi(groupId, targetPrincipalId, banRequest, scope, { signal }),
    commandOptions,
  ).run();
}

export async function unbanStateGroupMember(
  groupId: string,
  targetPrincipalId: string,
  request: UnbanGroupMemberRequest,
  actorPrincipalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const requestId =
    request.requestId ?? toStateWorkflowRequestId('group-member-unban', groupId, targetPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const unbanRequest = toUnbanRoomMemberGroupStateRequest({
    request,
    actorPrincipalId,
    actorSessionId: sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      unbanStateGroupMemberApi(groupId, targetPrincipalId, unbanRequest, scope, { signal }),
    commandOptions,
  ).run();
}

export async function setStateGroupMemberRole(
  groupId: string,
  targetPrincipalId: string,
  request: SetGroupMemberRoleRequest,
  actorPrincipalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const requestId =
    request.requestId ?? toStateWorkflowRequestId('group-member-role', groupId, targetPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const roleRequest = toSetRoomMemberRoleGroupStateRequest({
    request,
    actorPrincipalId,
    actorSessionId: sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      setStateGroupMemberRoleApi(groupId, targetPrincipalId, roleRequest, scope, { signal }),
    commandOptions,
  ).run();
}

export async function transferStateGroupOwnership(
  groupId: string,
  request: TransferGroupOwnershipRequest,
  actorPrincipalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  const requestId =
    request.requestId ??
    toStateWorkflowRequestId('group-ownership-transfer', groupId, request.newOwnerPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const transferRequest = toTransferRoomOwnershipGroupStateRequest({
    request,
    actorPrincipalId,
    actorSessionId: sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) => transferStateGroupOwnershipApi(groupId, transferRequest, scope, { signal }),
    commandOptions,
  ).run();
}
