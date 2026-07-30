import {
  defaultStateScope,
  findStateGroup,
  updateStateGroup,
} from '@shared-web/browser/api-integration.ts';
import { toStateWorkflowRequestId } from '@shared-web/browser/state-workflow-support.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import {
  toRoomLifecycleGroupStateRequest,
  toRoomMetadataGroupStateRequest,
  toUpdateGroupStateRequest,
  type GroupSnapshot,
  type StateScope,
  type UpdateGroupRequest,
} from './room-group-state-translation.ts';
import type { StateGroupWorkflowValue } from './room-group-state-workflows.ts';

interface UpdateStateGroupLifecycleInput {
  readonly groupId: string;
  readonly request: Omit<UpdateGroupRequest, 'status'>;
  readonly status: 'archived' | 'deleted';
  readonly principalId: string;
  readonly sessionId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

interface UpdateStateGroupMetadataInput {
  readonly groupId: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly principalId: string;
  readonly sessionId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

interface UpdateStateGroupDetailsInput {
  readonly groupId: string;
  readonly request: UpdateGroupRequest;
  readonly principalId: string;
  readonly sessionId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export async function updateStateGroupMetadata(
  groupId: string,
  patch: Readonly<Record<string, unknown>>,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  return await updateStateGroupMetadataWithInput({
    groupId,
    patch,
    principalId,
    sessionId,
    scope,
    policies,
  });
}

async function updateStateGroupMetadataWithInput(
  input: UpdateStateGroupMetadataInput,
): Promise<GroupSnapshot> {
  const requestId = toStateWorkflowRequestId(
    'group-metadata-update',
    input.groupId,
    input.sessionId,
  );
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const current = await new Command<GroupSnapshot>(
    (signal) => findStateGroup(input.groupId, input.scope, { signal }),
    commandOptions,
  ).run();
  const request = toRoomMetadataGroupStateRequest({
    currentMetadata: current.group.metadata,
    patch: input.patch,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) => updateStateGroup(input.groupId, request, input.scope, { signal }),
    commandOptions,
  ).run();
}

export async function updateStateGroupDetails(
  groupId: string,
  request: UpdateGroupRequest,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  return await updateStateGroupDetailsWithInput({
    groupId,
    request,
    principalId,
    sessionId,
    scope,
    policies,
  });
}

async function updateStateGroupDetailsWithInput(
  input: UpdateStateGroupDetailsInput,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-update', input.groupId, input.sessionId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const updateRequest = toUpdateGroupStateRequest({
    request: input.request,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) => updateStateGroup(input.groupId, updateRequest, input.scope, { signal }),
    commandOptions,
  ).run();
}

export async function archiveStateGroup(
  groupId: string,
  request: Omit<UpdateGroupRequest, 'status'>,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  return await updateStateGroupLifecycle({
    groupId,
    request,
    status: 'archived',
    principalId,
    sessionId,
    scope,
    policies,
  });
}

export async function deleteStateGroup(
  groupId: string,
  request: Omit<UpdateGroupRequest, 'status'>,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  return await updateStateGroupLifecycle({
    groupId,
    request,
    status: 'deleted',
    principalId,
    sessionId,
    scope,
    policies,
  });
}

async function updateStateGroupLifecycle(
  input: UpdateStateGroupLifecycleInput,
): Promise<GroupSnapshot> {
  const requestId =
    input.request.requestId ??
    toStateWorkflowRequestId('group-update', input.groupId, input.sessionId);
  const commandOptions = (input.policies.command ?? {}) as CommandOptions<GroupSnapshot>;
  const lifecycleRequest = toRoomLifecycleGroupStateRequest({
    request: input.request,
    status: input.status,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId,
  });

  return await new Command<GroupSnapshot>(
    (signal) => updateStateGroup(input.groupId, lifecycleRequest, input.scope, { signal }),
    commandOptions,
  ).run();
}
