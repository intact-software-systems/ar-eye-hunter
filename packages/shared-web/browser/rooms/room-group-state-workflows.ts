import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import {
    requireStateWorkflowResult,
    toApiMutationWorkflowRequestId,
    tolerateStateWorkflowNotFound
} from '@shared-web/browser/state-read/state-workflow-support.ts';
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
    type StateScope
} from './room-group-state-translation.ts';

export type StateGroupWorkflowValue = GroupSnapshot | undefined;
export type CreateAndJoinStateGroupOptions = Omit<RoomCreateGroupStateFields, 'displayName'>;

type GroupWorkflowKey = 'created' | 'member' | 'joined' | 'disconnected' | 'left';

export interface CreateAndJoinStateGroupInput {
    readonly displayName: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
    readonly requestedGroupId?: string;
    readonly options?: CreateAndJoinStateGroupOptions;
}

export interface JoinStateGroupInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
    readonly intent?: RoomJoinGroupStateFields;
}

export interface LeaveStateGroupInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export async function createAndJoinStateGroup(
    input: CreateAndJoinStateGroupInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const groupId = input.requestedGroupId?.trim() || crypto.randomUUID();
    const createRequestId = toApiMutationWorkflowRequestId();
    const presenceRequestId = toApiMutationWorkflowRequestId();
    const createRequest = toCreateGroupStateRequest({
        groupId,
        room: { displayName: input.displayName, ...input.options },
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const presenceRequest = toConnectRoomPresenceGroupStateRequest({
        principalId: input.principalId,
        generationId: input.generationId,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
        input.policies ?? {}
    );

    const results = await flow
        .sequential(
            flow.commandStep(
                'created',
                (signal) =>
                    roomGroupStateHttpApi.createGroup({
                        request: createRequest,
                        options: { requestId: createRequestId, signal },
                        scope
                    })
            ),
            flow.commandStep('joined', (signal) =>
                roomGroupStateHttpApi.connectPresence({
                    groupId,
                    sessionId: input.sessionId,
                    request: presenceRequest,
                    options: { requestId: presenceRequestId, signal },
                    scope
                }))
        )
        .run();

    return requireStateWorkflowResult(results, 'joined');
}

export async function joinStateGroup(
    input: JoinStateGroupInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const joinRequestId = toApiMutationWorkflowRequestId();
    const presenceRequestId = toApiMutationWorkflowRequestId();
    const joinRequest = toJoinGroupStateRequest({
        room: input.intent ?? {},
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const presenceRequest = toConnectRoomPresenceGroupStateRequest({
        principalId: input.principalId,
        generationId: input.generationId,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
        input.policies ?? {}
    );

    const results = await flow
        .sequential(
            flow.commandStep('member', (signal) =>
                roomGroupStateHttpApi.joinGroup({
                    groupId: input.groupId,
                    request: joinRequest,
                    options: { requestId: joinRequestId, signal },
                    scope
                })),
            flow.commandStep('joined', (signal) =>
                roomGroupStateHttpApi.connectPresence({
                    groupId: input.groupId,
                    sessionId: input.sessionId,
                    request: presenceRequest,
                    options: { requestId: presenceRequestId, signal },
                    scope
                }))
        )
        .run();

    return requireStateWorkflowResult(results, 'joined');
}

export async function leaveStateGroup(
    input: LeaveStateGroupInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const disconnectRequestId = toApiMutationWorkflowRequestId();
    const memberRequestId = toApiMutationWorkflowRequestId();
    const disconnectRequest = toDisconnectRoomPresenceGroupStateRequest({
        generationId: input.generationId,
        principalId: input.principalId,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const memberRequest = toLeaveRoomMemberGroupStateRequest({
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const flow = CommandsOrchestrator.withPolicies<GroupWorkflowKey, StateGroupWorkflowValue>(
        input.policies ?? {}
    );

    const results = await flow
        .sequential(
            flow.commandStep(
                'disconnected',
                (signal) =>
                    roomGroupStateHttpApi.disconnectPresence({
                        groupId: input.groupId,
                        sessionId: input.sessionId,
                        request: disconnectRequest,
                        options: { requestId: disconnectRequestId, signal },
                        scope
                    }),
                {
                    errorOnNull: false,
                    fallback: (error) => tolerateStateWorkflowNotFound(error, undefined)
                }
            ),
            flow.commandStep('left', (signal) =>
                roomGroupStateHttpApi.upsertMember({
                    groupId: input.groupId,
                    principalId: input.principalId,
                    request: memberRequest,
                    options: { requestId: memberRequestId, signal },
                    scope
                }))
        )
        .run();

    return requireStateWorkflowResult(results, 'left');
}
