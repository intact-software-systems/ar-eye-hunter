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
  toStateWorkflowRequestId,
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
  const groupId = requestedGroupId?.trim() || crypto.randomUUID();
  const createRequestId = toStateWorkflowRequestId('group-create', groupId);
  const presenceRequestId = toStateWorkflowRequestId('group-presence-connect', groupId, sessionId);
  const createRequest = toCreateGroupStateRequest({
    groupId,
    fields: { displayName, ...options },
    createdByPrincipalId: principalId,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: createRequestId,
  });
  const presenceRequest = toConnectRoomPresenceGroupStateRequest({
    principalId,
    generationId,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: presenceRequestId,
  });
  const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
    policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep('created', (signal) => createStateGroup(createRequest, scope, { signal })),
      flow.commandStep('joined', (signal) =>
        connectStateGroupPresenceSession(groupId, sessionId, presenceRequest, scope, { signal }),
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
  const joinRequestId = toStateWorkflowRequestId('group-join', groupId, principalId);
  const presenceRequestId = toStateWorkflowRequestId('group-presence-connect', groupId, sessionId);
  const joinRequest = toJoinGroupStateRequest({
    fields: intent,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: joinRequestId,
  });
  const presenceRequest = toConnectRoomPresenceGroupStateRequest({
    principalId,
    generationId,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: presenceRequestId,
  });
  const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
    policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep('member', (signal) =>
        joinStateGroupApi(groupId, joinRequest, scope, { signal }),
      ),
      flow.commandStep('joined', (signal) =>
        connectStateGroupPresenceSession(groupId, sessionId, presenceRequest, scope, { signal }),
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
  const disconnectRequestId = toStateWorkflowRequestId(
    'group-presence-disconnect',
    groupId,
    sessionId,
  );
  const memberRequestId = toStateWorkflowRequestId('group-member-upsert', groupId, principalId);
  const disconnectRequest = toDisconnectRoomPresenceGroupStateRequest({
    generationId,
    principalId,
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: disconnectRequestId,
  });
  const memberRequest = toLeaveRoomMemberGroupStateRequest({
    actorPrincipalId: principalId,
    actorSessionId: sessionId,
    requestId: memberRequestId,
  });
  const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
    policies,
  );

  const results = await flow
    .sequential(
      flow.commandStep(
        'disconnected',
        (signal) =>
          disconnectStateGroupPresenceSession(groupId, sessionId, disconnectRequest, scope, {
            signal,
          }),
        {
          errorOnNull: false,
          fallback: (error) => tolerateStateWorkflowNotFound(error, undefined),
        },
      ),
      flow.commandStep('left', (signal) =>
        upsertStateGroupMember(groupId, principalId, memberRequest, scope, { signal }),
      ),
    )
    .run();

  return requireStateWorkflowResult(results, 'left');
}
