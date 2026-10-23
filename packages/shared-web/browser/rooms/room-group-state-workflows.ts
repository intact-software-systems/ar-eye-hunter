import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import {
    requireStateWorkflowResult,
    toApiMutationWorkflowRequestId,
    tolerateStateWorkflowNotFound
} from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { QuickJoinGroupRequest, QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { Command } from '@shared/cache/Command.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RallarRoomJoinPartialFailureError } from './rallar-room-contracts.ts';

import {
    toConnectRoomPresenceGroupStateRequest,
    toCreateGroupStateRequest,
    toDisconnectRoomPresenceGroupStateRequest,
    toJoinGroupStateRequest,
    toLeaveRoomMemberGroupStateRequest,
    toRoomPresenceLeaseExpiresAtEpochMs,
    type GroupSnapshot,
    type RoomCreateGroupStateFields,
    type RoomJoinGroupStateFields,
    type StateScope
} from './room-group-state-translation.ts';

export type StateGroupWorkflowValue = GroupSnapshot | undefined;

type GroupWorkflowKey = 'created' | 'member' | 'joined' | 'disconnected' | 'left';

export interface CreateAndJoinStateGroupInput {
    readonly displayName: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
    readonly requestedGroupId?: string;
    readonly options?: Omit<RoomCreateGroupStateFields, 'displayName'>;
}

export interface ConnectStateGroupPresenceInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
    readonly authSession?: AuthSession;
    /** Fences each transport attempt against a replaced session or cancelled destination. */
    readonly assertCurrent?: () => void;
}

export interface JoinStateGroupInput extends ConnectStateGroupPresenceInput {
    readonly intent?: RoomJoinGroupStateFields;
}

export interface QuickJoinStateGroupInput {
    readonly request: Omit<QuickJoinGroupRequest, 'requestId'>;
    readonly scope: StateScope | undefined;
    readonly authSession: AuthSession;
    readonly policies: CommandsOrchestratorPolicies<QuickJoinGroupResult>;
}

export interface LeaveStateGroupInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
    readonly authSession?: AuthSession;
    readonly assertCurrent?: () => void;
}

export async function createAndJoinStateGroup(
    input: CreateAndJoinStateGroupInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const groupId = input.requestedGroupId?.trim() || crypto.randomUUID();
    const requestId = toApiMutationWorkflowRequestId();
    const presence = createStateGroupPresenceCommand({ ...input, groupId, scope });
    const request = toCreateGroupStateRequest({
        groupId,
        room: { displayName: input.displayName, ...input.options },
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    await new Command<StateGroupWorkflowValue>(
        (signal) => roomGroupStateHttpApi.createGroup({ request, options: { requestId, signal }, scope }),
        input.policies?.command
    ).run();
    return requireConnectedPresence(await presence.run());
}

export async function joinStateGroup(input: JoinStateGroupInput): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const requestId = toApiMutationWorkflowRequestId();
    const presence = createStateGroupPresenceCommand({ ...input, scope });
    const request = toJoinGroupStateRequest({
        room: input.intent ?? {},
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    const joinedRoom = await new Command<StateGroupWorkflowValue>(
        (signal) => {
            input.assertCurrent?.();
            return roomGroupStateHttpApi.joinGroup({
                groupId: input.groupId,
                request,
                options: { requestId, signal, authSession: input.authSession },
                scope
            });
        },
        input.policies?.command
    ).run();
    if (!joinedRoom) {
        throw new Error('Room admission did not produce a snapshot.');
    }
    try {
        input.assertCurrent?.();
        const snapshot = requireConnectedPresence(await presence.run());
        input.assertCurrent?.();
        return snapshot;
    }
    catch (cause) {
        throw createRoomJoinPartialFailureError(joinedRoom, toError(cause));
    }
}

export function createRoomJoinPartialFailureError(
    joinedRoom: GroupSnapshot,
    cause: Error
): RallarRoomJoinPartialFailureError {
    return Object.assign(
        new Error(`Joined room ${joinedRoom.group.groupId}, but entering it failed.`, { cause }),
        { name: 'RallarRoomJoinPartialFailureError' as const, joinedRoom }
    );
}

/** A command owns one presence request identity and captured lease across HTTP retries. */
export function createStateGroupPresenceCommand(
    input: ConnectStateGroupPresenceInput
): Command<StateGroupWorkflowValue> {
    const requestId = toApiMutationWorkflowRequestId();
    const request = toConnectRoomPresenceGroupStateRequest({
        principalId: input.principalId,
        generationId: input.generationId,
        connectionGenerationId: input.connectionGenerationId,
        expiresAtEpochMs: toRoomPresenceLeaseExpiresAtEpochMs(Date.now()),
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    return new Command<StateGroupWorkflowValue>(
        (signal) => {
            input.assertCurrent?.();
            return roomGroupStateHttpApi.connectPresence({
                groupId: input.groupId,
                sessionId: input.sessionId,
                request,
                options: { requestId, signal, authSession: input.authSession },
                scope: input.scope
            });
        },
        input.policies?.command
    );
}

export async function quickJoinStateGroup(input: QuickJoinStateGroupInput): Promise<QuickJoinGroupResult> {
    const requestId = toApiMutationWorkflowRequestId();
    return await new Command<QuickJoinGroupResult>(
        (signal) =>
            roomGroupStateHttpApi.quickJoin({
                request: input.request,
                options: { requestId, signal, authSession: input.authSession },
                scope: input.scope
            }),
        input.policies.command
    ).run();
}

function requireConnectedPresence(snapshot: StateGroupWorkflowValue): GroupSnapshot {
    if (!snapshot) {
        throw new Error('Room presence did not produce a snapshot.');
    }
    return snapshot;
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
                (signal) => {
                    input.assertCurrent?.();
                    return roomGroupStateHttpApi.disconnectPresence({
                        groupId: input.groupId,
                        sessionId: input.sessionId,
                        request: disconnectRequest,
                        options: { requestId: disconnectRequestId, signal, authSession: input.authSession },
                        scope
                    });
                },
                {
                    errorOnNull: false,
                    fallback: (error) => tolerateStateWorkflowNotFound(error, undefined)
                }
            ),
            flow.commandStep('left', (signal) => {
                input.assertCurrent?.();
                return roomGroupStateHttpApi.upsertMember({
                    groupId: input.groupId,
                    principalId: input.principalId,
                    request: memberRequest,
                    options: { requestId: memberRequestId, signal, authSession: input.authSession },
                    scope
                });
            })
        )
        .run();

    return requireStateWorkflowResult(results, 'left');
}
