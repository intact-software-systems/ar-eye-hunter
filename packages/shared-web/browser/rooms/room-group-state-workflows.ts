import {
  connectStateGroupPresenceSession,
  createStateGroup,
  defaultStateScope,
  disconnectStateGroupPresenceSession,
  joinStateGroup as joinStateGroupApi,
  upsertStateGroupMember,
} from '@shared-web/browser/api-integration.ts';
import {
  requireStateWorkflowResult,
  tolerateStateWorkflowNotFound,
  toApiMutationWorkflowRequestId,
} from '@shared-web/browser/state-workflow-support.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import {
  toConnectRoomPresenceGroupStateRequest,
  toCreateGroupStateRequest,
  toDisconnectRoomPresenceGroupStateRequest,
  toJoinGroupStateRequest,
  toLeaveRoomMemberGroupStateRequest,
  type GroupSnapshot,
  type RoomCreateGroupStateFields,
  type RoomJoinGroupStateFields,
  type StateScope,
} from './room-group-state-translation.ts';

export type StateGroupWorkflowValue = GroupSnapshot | undefined;
export type JoinStateGroupIntent = RoomJoinGroupStateFields;
export type CreateAndJoinStateGroupOptions = Omit<RoomCreateGroupStateFields, 'displayName'>;

type GroupWorkflowKey = 'created' | 'member' | 'joined' | 'disconnected' | 'left';

interface CreateAndJoinStateGroupInput {
  readonly displayName: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
  readonly requestedGroupId?: string;
  readonly options: CreateAndJoinStateGroupOptions;
}

interface JoinStateGroupInput {
  readonly groupId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
  readonly intent: JoinStateGroupIntent;
}

interface LeaveStateGroupInput {
  readonly groupId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly scope: StateScope;
  readonly policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export async function createAndJoinStateGroup(
  displayName: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
  requestedGroupId?: string,
  options: CreateAndJoinStateGroupOptions = {},
): Promise<GroupSnapshot> {
  return await createAndJoinStateGroupWithInput({
    displayName,
    principalId,
    sessionId,
    generationId,
    scope,
    policies,
    requestedGroupId,
    options,
  });
}

async function createAndJoinStateGroupWithInput(
  input: CreateAndJoinStateGroupInput,
): Promise<GroupSnapshot> {
  const groupId = input.requestedGroupId?.trim() || crypto.randomUUID();
  const createRequestId = toApiMutationWorkflowRequestId();
  const presenceRequestId = toApiMutationWorkflowRequestId();
  const createRequest = toCreateGroupStateRequest({
    groupId,
    room: { displayName: input.displayName, ...input.options },
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId: createRequestId,
  });
  const presenceRequest = toConnectRoomPresenceGroupStateRequest({
    principalId: input.principalId,
    generationId: input.generationId,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId: presenceRequestId,
  });
  const { requestId: _createRequestId, ...createBody } = createRequest;
  const { requestId: _presenceRequestId, ...presenceBody } = presenceRequest;
  const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
    input.policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep('created', (signal) =>
        createStateGroup(createBody, { requestId: createRequestId, signal }, input.scope),
      ),
      flow.commandStep('joined', (signal) =>
        connectStateGroupPresenceSession(
          groupId,
          input.sessionId,
          presenceBody,
          { requestId: presenceRequestId, signal },
          input.scope,
        ),
      ),
    )
    .run();

  return requireStateWorkflowResult(results, 'joined');
}

export async function joinStateGroup(
  groupId: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
  intent: JoinStateGroupIntent = {},
): Promise<GroupSnapshot> {
  return await joinStateGroupWithInput({
    groupId,
    principalId,
    sessionId,
    generationId,
    scope,
    policies,
    intent,
  });
}

async function joinStateGroupWithInput(input: JoinStateGroupInput): Promise<GroupSnapshot> {
  const joinRequestId = toApiMutationWorkflowRequestId();
  const presenceRequestId = toApiMutationWorkflowRequestId();
  const joinRequest = toJoinGroupStateRequest({
    room: input.intent,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId: joinRequestId,
  });
  const presenceRequest = toConnectRoomPresenceGroupStateRequest({
    principalId: input.principalId,
    generationId: input.generationId,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId: presenceRequestId,
  });
  const { requestId: _joinRequestId, ...joinBody } = joinRequest;
  const { requestId: _presenceRequestId, ...presenceBody } = presenceRequest;
  const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
    input.policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep('member', (signal) =>
        joinStateGroupApi(
          input.groupId,
          joinBody,
          { requestId: joinRequestId, signal },
          input.scope,
        ),
      ),
      flow.commandStep('joined', (signal) =>
        connectStateGroupPresenceSession(
          input.groupId,
          input.sessionId,
          presenceBody,
          { requestId: presenceRequestId, signal },
          input.scope,
        ),
      ),
    )
    .run();

  return requireStateWorkflowResult(results, 'joined');
}

export async function leaveStateGroup(
  groupId: string,
  principalId: string,
  sessionId: string,
  generationId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupSnapshot> {
  return await leaveStateGroupWithInput({
    groupId,
    principalId,
    sessionId,
    generationId,
    scope,
    policies,
  });
}

async function leaveStateGroupWithInput(input: LeaveStateGroupInput): Promise<GroupSnapshot> {
  const disconnectRequestId = toApiMutationWorkflowRequestId();
  const memberRequestId = toApiMutationWorkflowRequestId();
  const disconnectRequest = toDisconnectRoomPresenceGroupStateRequest({
    generationId: input.generationId,
    principalId: input.principalId,
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId: disconnectRequestId,
  });
  const memberRequest = toLeaveRoomMemberGroupStateRequest({
    actorPrincipalId: input.principalId,
    actorSessionId: input.sessionId,
    requestId: memberRequestId,
  });
  const { requestId: _disconnectRequestId, ...disconnectBody } = disconnectRequest;
  const { requestId: _memberRequestId, ...memberBody } = memberRequest;
  const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
    input.policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep(
        'disconnected',
        (signal) =>
          disconnectStateGroupPresenceSession(
            input.groupId,
            input.sessionId,
            disconnectBody,
            { requestId: disconnectRequestId, signal },
            input.scope,
          ),
        {
          errorOnNull: false,
          fallback: (error) => tolerateStateWorkflowNotFound(error, undefined),
        },
      ),
      flow.commandStep('left', (signal) =>
        upsertStateGroupMember(
          input.groupId,
          input.principalId,
          memberBody,
          { requestId: memberRequestId, signal },
          input.scope,
        ),
      ),
    )
    .run();

  return requireStateWorkflowResult(results, 'left');
}
