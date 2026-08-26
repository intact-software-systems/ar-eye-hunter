import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import {
    requireStateWorkflowResult,
    toApiMutationWorkflowRequestId
} from '@shared-web/browser/state-read/state-workflow-support.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import { CommandsOrchestrator, type CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import {
    toAcceptRoomInviteGroupStateRequest,
    toBanRoomMemberGroupStateRequest,
    toConnectRoomPresenceGroupStateRequest,
    toCreateRoomInviteGroupStateRequest,
    toRemoveRoomMemberGroupStateRequest,
    toRevokeRoomInviteGroupStateRequest,
    toRotateRoomJoinCodeGroupStateRequest,
    toSetRoomMemberRoleGroupStateRequest,
    toTransferRoomOwnershipGroupStateRequest,
    toUnbanRoomMemberGroupStateRequest,
    type BanStateGroupMemberBody,
    type CreateStateGroupInviteBody,
    type GroupJoinCodeResponse,
    type GroupSnapshot,
    type RemoveStateGroupMemberBody,
    type RevokeStateGroupInviteBody,
    type RotateStateGroupJoinCodeBody,
    type SetStateGroupMemberRoleBody,
    type StateScope,
    type TransferStateGroupOwnershipBody,
    type UnbanStateGroupMemberBody
} from './room-group-state-translation.ts';

interface RoomActorWorkflowInput<TWorkflowValue = GroupSnapshot> {
    readonly groupId: string;
    readonly actorPrincipalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<TWorkflowValue>;
}

interface TargetRoomActorWorkflowInput extends RoomActorWorkflowInput {
    readonly targetPrincipalId: string;
}

export interface CreateStateGroupInviteWorkflowInput extends TargetRoomActorWorkflowInput {
    readonly request: CreateStateGroupInviteBody;
}

export interface RevokeStateGroupInviteWorkflowInput extends TargetRoomActorWorkflowInput {
    readonly request: RevokeStateGroupInviteBody;
}

export interface AcceptStateGroupInviteWorkflowInput extends RoomActorWorkflowInput {
    readonly generationId: string;
}

export interface RotateStateGroupJoinCodeWorkflowInput extends RoomActorWorkflowInput<GroupJoinCodeResponse> {
    readonly request: RotateStateGroupJoinCodeBody;
}

export interface RemoveStateGroupMemberWorkflowInput extends TargetRoomActorWorkflowInput {
    readonly request: RemoveStateGroupMemberBody;
}

export interface BanStateGroupMemberWorkflowInput extends TargetRoomActorWorkflowInput {
    readonly request: BanStateGroupMemberBody;
}

export interface UnbanStateGroupMemberWorkflowInput extends TargetRoomActorWorkflowInput {
    readonly request: UnbanStateGroupMemberBody;
}

export interface SetStateGroupMemberRoleWorkflowInput extends TargetRoomActorWorkflowInput {
    readonly request: SetStateGroupMemberRoleBody;
}

export interface TransferStateGroupOwnershipWorkflowInput extends RoomActorWorkflowInput {
    readonly request: TransferStateGroupOwnershipBody;
}

export async function createStateGroupInvite(
    input: CreateStateGroupInviteWorkflowInput
): Promise<GroupSnapshot> {
    const request = toCreateRoomInviteGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.createInvite({
            groupId: input.groupId,
            principalId: input.targetPrincipalId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

export async function revokeStateGroupInvite(
    input: RevokeStateGroupInviteWorkflowInput
): Promise<GroupSnapshot> {
    const request = toRevokeRoomInviteGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.revokeInvite({
            groupId: input.groupId,
            principalId: input.targetPrincipalId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

export async function acceptStateGroupInvite(
    input: AcceptStateGroupInviteWorkflowInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const acceptRequestId = toApiMutationWorkflowRequestId();
    const presenceRequestId = toApiMutationWorkflowRequestId();
    const flow = CommandsOrchestrator.withPolicies<'accepted' | 'joined', GroupSnapshot>(
        input.policies ?? {}
    );
    const results = await flow
        .sequential(
            flow.commandStep('accepted', (signal) =>
                roomGroupStateHttpApi.acceptInvite({
                    groupId: input.groupId,
                    request: toAcceptRoomInviteGroupStateRequest({
                        actorPrincipalId: input.actorPrincipalId,
                        actorSessionId: input.sessionId
                    }),
                    options: { requestId: acceptRequestId, signal },
                    scope
                })),
            flow.commandStep('joined', (signal) =>
                roomGroupStateHttpApi.connectPresence({
                    groupId: input.groupId,
                    sessionId: input.sessionId,
                    request: toConnectRoomPresenceGroupStateRequest({
                        principalId: input.actorPrincipalId,
                        generationId: input.generationId,
                        actorPrincipalId: input.actorPrincipalId,
                        actorSessionId: input.sessionId
                    }),
                    options: { requestId: presenceRequestId, signal },
                    scope
                }))
        )
        .run();
    return requireStateWorkflowResult(results, 'joined');
}

export async function rotateStateGroupJoinCode(
    input: RotateStateGroupJoinCodeWorkflowInput
): Promise<GroupJoinCodeResponse> {
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions: CommandOptions<GroupJoinCodeResponse> = input.policies?.command ?? {};
    const request = toRotateRoomJoinCodeGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await new Command<GroupJoinCodeResponse>(
        (signal) =>
            roomGroupStateHttpApi.rotateJoinCode({
                groupId: input.groupId,
                request,
                options: { requestId, signal },
                scope: input.scope ?? defaultStateScope()
            }),
        commandOptions
    ).run();
}

export async function removeStateGroupMember(
    input: RemoveStateGroupMemberWorkflowInput
): Promise<GroupSnapshot> {
    const request = toRemoveRoomMemberGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.removeMember({
            groupId: input.groupId,
            principalId: input.targetPrincipalId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

export async function banStateGroupMember(
    input: BanStateGroupMemberWorkflowInput
): Promise<GroupSnapshot> {
    const request = toBanRoomMemberGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.banMember({
            groupId: input.groupId,
            principalId: input.targetPrincipalId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

export async function unbanStateGroupMember(
    input: UnbanStateGroupMemberWorkflowInput
): Promise<GroupSnapshot> {
    const request = toUnbanRoomMemberGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.unbanMember({
            groupId: input.groupId,
            principalId: input.targetPrincipalId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

export async function setStateGroupMemberRole(
    input: SetStateGroupMemberRoleWorkflowInput
): Promise<GroupSnapshot> {
    const request = toSetRoomMemberRoleGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.setMemberRole({
            groupId: input.groupId,
            principalId: input.targetPrincipalId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

export async function transferStateGroupOwnership(
    input: TransferStateGroupOwnershipWorkflowInput
): Promise<GroupSnapshot> {
    const request = toTransferRoomOwnershipGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.actorPrincipalId,
        actorSessionId: input.sessionId
    });
    return await runGroupSnapshotCommand(input, (requestId, signal) =>
        roomGroupStateHttpApi.transferOwnership({
            groupId: input.groupId,
            request,
            options: { requestId, signal },
            scope: input.scope ?? defaultStateScope()
        }));
}

async function runGroupSnapshotCommand(
    input: RoomActorWorkflowInput,
    operation: (requestId: string, signal?: AbortSignal) => Promise<GroupSnapshot>
): Promise<GroupSnapshot> {
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions: CommandOptions<GroupSnapshot> = input.policies?.command ?? {};
    return await new Command<GroupSnapshot>(
        (signal) => operation(requestId, signal),
        commandOptions
    ).run();
}
