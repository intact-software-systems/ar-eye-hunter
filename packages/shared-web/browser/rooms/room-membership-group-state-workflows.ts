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

interface StateGroupActorWorkflowInput {
  readonly groupId: string;
  readonly actorPrincipalId: string;
  readonly sessionId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}
interface TargetStateGroupActorWorkflowInput extends StateGroupActorWorkflowInput {
  readonly targetPrincipalId: string;
}
interface TargetStateGroupRequestWorkflowInput<
  TRequest,
> extends TargetStateGroupActorWorkflowInput {
  readonly request: TRequest;
}
interface AcceptStateGroupInviteInput extends StateGroupActorWorkflowInput {
  readonly generationId: string;
}
interface TransferStateGroupOwnershipInput extends StateGroupActorWorkflowInput {
  readonly request: TransferGroupOwnershipRequest;
}

export async function createStateGroupInvite(
  groupId: string,
  targetPrincipalId: string,
  request: CreateGroupInviteRequest,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  return await createStateGroupInviteWithInput({
    groupId,
    targetPrincipalId,
    request,
    actorPrincipalId: principalId,
    sessionId,
    scope,
    policies,
  });
}

async function createStateGroupInviteWithInput(
  input: TargetStateGroupRequestWorkflowInput<CreateGroupInviteRequest>,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-invite-create', input.groupId, input.targetPrincipalId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const inviteRequest = toCreateRoomInviteGroupStateRequest({
    request: input.request,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      createStateGroupInviteApi(
        input.groupId,
        input.targetPrincipalId,
        inviteRequest,
        input.scope,
        { signal },
      ),
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
  return await acceptStateGroupInviteWithInput({
    groupId,
    actorPrincipalId: principalId,
    sessionId,
    generationId,
    scope,
    policies,
  });
}

async function acceptStateGroupInviteWithInput(
  input: AcceptStateGroupInviteInput,
): Promise<GroupSnapshot> {
  const acceptRequestId = toStateWorkflowRequestId(
    'group-invite-accept',
    input.groupId,
    input.actorPrincipalId,
  );
  const presenceRequestId = toStateWorkflowRequestId(
    'group-presence-connect',
    input.groupId,
    input.sessionId,
  );
  const acceptRequest = toAcceptRoomInviteGroupStateRequest({
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId: acceptRequestId,
  });
  const presenceRequest = toConnectRoomPresenceGroupStateRequest({
    principalId: input.actorPrincipalId,
    generationId: input.generationId,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId: presenceRequestId,
  });
  const flow = CommandsOrchestrator.withPolicies<InviteWorkflowKey, StateGroupWorkflowValue>(
    input.policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep('accepted', (signal) =>
        acceptStateGroupInviteApi(input.groupId, acceptRequest, input.scope, { signal }),
      ),
      flow.commandStep('joined', (signal) =>
        connectStateGroupPresenceSession(
          input.groupId,
          input.sessionId,
          presenceRequest,
          input.scope,
          { signal },
        ),
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
  return await removeStateGroupMemberWithInput({
    groupId,
    targetPrincipalId,
    request,
    actorPrincipalId,
    sessionId,
    scope,
    policies,
  });
}

async function removeStateGroupMemberWithInput(
  input: TargetStateGroupRequestWorkflowInput<RemoveGroupMemberRequest>,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-member-remove', input.groupId, input.targetPrincipalId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const removeRequest = toRemoveRoomMemberGroupStateRequest({
    request: input.request,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      removeStateGroupMemberApi(
        input.groupId,
        input.targetPrincipalId,
        removeRequest,
        input.scope,
        { signal },
      ),
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
  return await banStateGroupMemberWithInput({
    groupId,
    targetPrincipalId,
    request,
    actorPrincipalId,
    sessionId,
    scope,
    policies,
  });
}

async function banStateGroupMemberWithInput(
  input: TargetStateGroupRequestWorkflowInput<BanGroupMemberRequest>,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-member-ban', input.groupId, input.targetPrincipalId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const banRequest = toBanRoomMemberGroupStateRequest({
    request: input.request,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      banStateGroupMemberApi(input.groupId, input.targetPrincipalId, banRequest, input.scope, {
        signal,
      }),
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
  return await unbanStateGroupMemberWithInput({
    groupId,
    targetPrincipalId,
    request,
    actorPrincipalId,
    sessionId,
    scope,
    policies,
  });
}

async function unbanStateGroupMemberWithInput(
  input: TargetStateGroupRequestWorkflowInput<UnbanGroupMemberRequest>,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-member-unban', input.groupId, input.targetPrincipalId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const unbanRequest = toUnbanRoomMemberGroupStateRequest({
    request: input.request,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      unbanStateGroupMemberApi(input.groupId, input.targetPrincipalId, unbanRequest, input.scope, {
        signal,
      }),
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
  return await setStateGroupMemberRoleWithInput({
    groupId,
    targetPrincipalId,
    request,
    actorPrincipalId,
    sessionId,
    scope,
    policies,
  });
}

async function setStateGroupMemberRoleWithInput(
  input: TargetStateGroupRequestWorkflowInput<SetGroupMemberRoleRequest>,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-member-role', input.groupId, input.targetPrincipalId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const roleRequest = toSetRoomMemberRoleGroupStateRequest({
    request: input.request,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      setStateGroupMemberRoleApi(input.groupId, input.targetPrincipalId, roleRequest, input.scope, {
        signal,
      }),
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
  return await transferStateGroupOwnershipWithInput({
    groupId,
    request,
    actorPrincipalId,
    sessionId,
    scope,
    policies,
  });
}

async function transferStateGroupOwnershipWithInput(
  input: TransferStateGroupOwnershipInput,
): Promise<GroupSnapshot> {
  const request = input.request;
  const requestId =
    request.requestId ??
    toStateWorkflowRequestId(
      'group-ownership-transfer',
      input.groupId,
      request.newOwnerPrincipalId,
    );
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const transferRequest = toTransferRoomOwnershipGroupStateRequest({
    request,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) =>
      transferStateGroupOwnershipApi(input.groupId, transferRequest, input.scope, { signal }),
    commandOptions,
  ).run();
}
