import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiMutationRequestOptions } from '../api/http-request.ts';
import { defaultStateScope, toStateGroupHttpPath, toStateScopeHttpPath } from '../api/state-http-path.ts';
import type {
    AcceptStateGroupInviteBody,
    AppointStateGroupDirectorBody,
    BanStateGroupMemberBody,
    ConnectStateGroupPresenceSessionBody,
    CreateStateGroupBody,
    CreateStateGroupInviteBody,
    DisconnectStateGroupPresenceSessionBody,
    HeartbeatStateGroupPresenceSessionBody,
    JoinStateGroupBody,
    RemoveStateGroupMemberBody,
    RevokeStateGroupInviteBody,
    RotateStateGroupJoinCodeBody,
    SetStateGroupMemberRoleBody,
    TransferStateGroupOwnershipBody,
    UnbanStateGroupMemberBody,
    UpdateStateGroupBody,
    UpsertStateGroupMemberBody
} from '../api/state-mutation-http-contracts.ts';
import type {
    GroupJoinCodeResponse,
    GroupSnapshot,
    RoomFormationGroupStateRequest,
    StateScope
} from './room-group-state-translation.ts';

interface RoomGroupRequestInput<TRequest> {
    readonly groupId: string;
    readonly request: TRequest;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

interface TargetRoomGroupRequestInput<TRequest> extends RoomGroupRequestInput<TRequest> {
    readonly principalId: string;
}

interface RoomPresenceRequestInput<TRequest> extends RoomGroupRequestInput<TRequest> {
    readonly sessionId: string;
}

interface RoomGroupHttpMutationInput<TRequest> {
    readonly path: string;
    readonly method: 'POST' | 'PUT';
    readonly request: TRequest;
    readonly options: ApiMutationRequestOptions;
}

export interface CreateStateGroupHttpInput {
    readonly request: CreateStateGroupBody;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

export interface UpdateStateGroupHttpInput extends RoomGroupRequestInput<UpdateStateGroupBody> {}
export interface AppointStateGroupDirectorHttpInput extends RoomGroupRequestInput<AppointStateGroupDirectorBody> {}
export interface JoinStateGroupHttpInput extends RoomGroupRequestInput<JoinStateGroupBody> {}
export interface CreateStateGroupInviteHttpInput extends TargetRoomGroupRequestInput<CreateStateGroupInviteBody> {}
export interface RevokeStateGroupInviteHttpInput extends TargetRoomGroupRequestInput<RevokeStateGroupInviteBody> {}
export interface AcceptStateGroupInviteHttpInput extends RoomGroupRequestInput<AcceptStateGroupInviteBody> {}
export interface RotateStateGroupJoinCodeHttpInput extends RoomGroupRequestInput<RotateStateGroupJoinCodeBody> {}
export interface RemoveStateGroupMemberHttpInput extends TargetRoomGroupRequestInput<RemoveStateGroupMemberBody> {}
export interface BanStateGroupMemberHttpInput extends TargetRoomGroupRequestInput<BanStateGroupMemberBody> {}
export interface UnbanStateGroupMemberHttpInput extends TargetRoomGroupRequestInput<UnbanStateGroupMemberBody> {}
export interface SetStateGroupMemberRoleHttpInput extends TargetRoomGroupRequestInput<SetStateGroupMemberRoleBody> {}
export interface TransferStateGroupOwnershipHttpInput extends RoomGroupRequestInput<TransferStateGroupOwnershipBody> {}
export interface UpsertStateGroupMemberHttpInput extends TargetRoomGroupRequestInput<UpsertStateGroupMemberBody> {}
export interface CommandStateGroupLifecycleHttpInput extends RoomGroupRequestInput<RoomFormationGroupStateRequest> {}
export interface ConnectStateGroupPresenceSessionHttpInput
    extends RoomPresenceRequestInput<ConnectStateGroupPresenceSessionBody> {}
export interface HeartbeatStateGroupPresenceSessionHttpInput
    extends RoomPresenceRequestInput<HeartbeatStateGroupPresenceSessionBody> {}
export interface DisconnectStateGroupPresenceSessionHttpInput
    extends RoomPresenceRequestInput<DisconnectStateGroupPresenceSessionBody> {}

async function createStateGroup(input: CreateStateGroupHttpInput): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    return await mutateRoomGroupState({
        path: `${toStateScopeHttpPath(scope)}/groups`,
        method: 'POST',
        request: input.request,
        options: input.options
    });
}

async function updateStateGroup(input: UpdateStateGroupHttpInput): Promise<GroupSnapshot> {
    return await mutateRoomGroupState({
        path: roomGroupPath(input),
        method: 'PUT',
        request: input.request,
        options: input.options
    });
}

async function appointStateGroupDirector(
    input: AppointStateGroupDirectorHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(input, '/director/appoint');
}

async function joinStateGroup(input: JoinStateGroupHttpInput): Promise<GroupSnapshot> {
    return await postRoomGroupState(input, '/join');
}

async function createStateGroupInvite(
    input: CreateStateGroupInviteHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/invites/${encodeURIComponent(input.principalId)}`
    );
}

async function revokeStateGroupInvite(
    input: RevokeStateGroupInviteHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/invites/${encodeURIComponent(input.principalId)}/revoke`
    );
}

async function acceptStateGroupInvite(
    input: AcceptStateGroupInviteHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(input, '/invites/accept');
}

async function rotateStateGroupJoinCode(
    input: RotateStateGroupJoinCodeHttpInput
): Promise<GroupJoinCodeResponse> {
    return await postRoomGroupState(input, '/join-code/rotate');
}

async function removeStateGroupMember(
    input: RemoveStateGroupMemberHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/members/${encodeURIComponent(input.principalId)}/remove`
    );
}

async function banStateGroupMember(
    input: BanStateGroupMemberHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/members/${encodeURIComponent(input.principalId)}/ban`
    );
}

async function unbanStateGroupMember(
    input: UnbanStateGroupMemberHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/members/${encodeURIComponent(input.principalId)}/unban`
    );
}

async function setStateGroupMemberRole(
    input: SetStateGroupMemberRoleHttpInput
): Promise<GroupSnapshot> {
    return await putRoomGroupState(
        input,
        `/members/${encodeURIComponent(input.principalId)}/role`
    );
}

async function transferStateGroupOwnership(
    input: TransferStateGroupOwnershipHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(input, '/owner/transfer');
}

async function upsertStateGroupMember(
    input: UpsertStateGroupMemberHttpInput
): Promise<GroupSnapshot> {
    return await putRoomGroupState(
        input,
        `/members/${encodeURIComponent(input.principalId)}`
    );
}

async function connectStateGroupPresenceSession(
    input: ConnectStateGroupPresenceSessionHttpInput
): Promise<GroupSnapshot> {
    return await putRoomGroupState(
        input,
        `/sessions/${encodeURIComponent(input.sessionId)}`
    );
}

async function heartbeatStateGroupPresenceSession(
    input: HeartbeatStateGroupPresenceSessionHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/sessions/${encodeURIComponent(input.sessionId)}/heartbeat`
    );
}

async function disconnectStateGroupPresenceSession(
    input: DisconnectStateGroupPresenceSessionHttpInput
): Promise<GroupSnapshot> {
    return await postRoomGroupState(
        input,
        `/sessions/${encodeURIComponent(input.sessionId)}/disconnect`
    );
}

async function commandStateGroupLifecycle(input: CommandStateGroupLifecycleHttpInput): Promise<GroupSnapshot> {
    return await postRoomGroupState({ ...input, request: input.request.body }, `/lifecycle/${input.request.command}`);
}

function postRoomGroupState<TRequest, TResponse>(
    input: RoomGroupRequestInput<TRequest>,
    suffix: string
): Promise<TResponse> {
    return mutateRoomGroupState({
        path: `${roomGroupPath(input)}${suffix}`,
        method: 'POST',
        request: input.request,
        options: input.options
    });
}

function putRoomGroupState<TRequest, TResponse>(
    input: RoomGroupRequestInput<TRequest>,
    suffix: string
): Promise<TResponse> {
    return mutateRoomGroupState({
        path: `${roomGroupPath(input)}${suffix}`,
        method: 'PUT',
        request: input.request,
        options: input.options
    });
}

async function mutateRoomGroupState<TRequest, TResponse>(
    input: RoomGroupHttpMutationInput<TRequest>
): Promise<TResponse> {
    return await executeHttpRequest<TRequest, TResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath(input.path, input.options.requestId),
        input.method,
        input.request,
        input.options
    );
}

function roomGroupPath(input: Pick<RoomGroupRequestInput<never>, 'groupId' | 'scope'>): string {
    return toStateGroupHttpPath(input.scope ?? defaultStateScope(), input.groupId);
}

export const roomGroupStateHttpApi = Object.freeze({
    createGroup: createStateGroup,
    updateGroup: updateStateGroup,
    appointDirector: appointStateGroupDirector,
    joinGroup: joinStateGroup,
    createInvite: createStateGroupInvite,
    revokeInvite: revokeStateGroupInvite,
    acceptInvite: acceptStateGroupInvite,
    rotateJoinCode: rotateStateGroupJoinCode,
    removeMember: removeStateGroupMember,
    banMember: banStateGroupMember,
    unbanMember: unbanStateGroupMember,
    setMemberRole: setStateGroupMemberRole,
    transferOwnership: transferStateGroupOwnership,
    upsertMember: upsertStateGroupMember,
    connectPresence: connectStateGroupPresenceSession,
    heartbeatPresence: heartbeatStateGroupPresenceSession,
    disconnectPresence: disconnectStateGroupPresenceSession,
    commandLifecycle: commandStateGroupLifecycle
});
