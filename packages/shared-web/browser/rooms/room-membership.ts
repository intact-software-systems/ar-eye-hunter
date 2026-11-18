import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';

import type {
    RallarRoomGovernanceOptions,
    RallarRoomInviteOptions,
    RallarRoomJoinCodeOptions,
    RallarRoomTargetInput
} from './rallar-room-contracts.ts';
import { requireOwnWsConnectionGenerationId } from './require-own-ws-connection-generation-id.ts';
import type { GroupJoinCodeResponse, GroupRef, GroupRole, GroupSnapshot } from './room-group-state-translation.ts';
import {
    acceptStateGroupInvite,
    banStateGroupMember,
    createStateGroupInvite,
    removeStateGroupMember,
    revokeStateGroupInvite,
    rotateStateGroupJoinCode,
    setStateGroupMemberRole,
    transferStateGroupOwnership,
    unbanStateGroupMember
} from './room-membership-group-state-workflows.ts';
import { runRoomTargetMutation, type RunRoomTargetMutationInput } from './update-room.ts';

interface RoomMembershipInput extends Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'> {
    readonly room: string | GroupRef | RallarRoomTargetInput;
}

interface RoomMemberGovernanceInput extends RoomMembershipInput {
    readonly principalId: string;
    readonly options?: RallarRoomGovernanceOptions;
}

interface RotateRoomJoinCodeInput extends RoomMembershipInput {
    readonly options?: RallarRoomJoinCodeOptions;
}

interface CreateRoomInviteInput extends RoomMembershipInput {
    readonly principalId: string;
    readonly options?: RallarRoomInviteOptions;
}

interface AcceptRoomInviteInput extends RoomMembershipInput {
    readonly nowMs: () => number;
    readonly options?: RallarRoomGovernanceOptions;
    readonly readPublicationKey: () => Promise<GroupPresencePublicationKey | null>;
}

interface SetRoomMemberRoleInput extends RoomMemberGovernanceInput {
    readonly role: GroupRole;
}

interface GovernRoomMemberInput extends RoomMemberGovernanceInput {
    readonly action: 'remove' | 'ban' | 'unban';
}

export async function revokeRoomInvite(
    input: RoomMemberGovernanceInput
): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) =>
            await revokeStateGroupInvite({
                groupId: roomId,
                targetPrincipalId: input.principalId,
                request: options.reason === undefined ? {} : { reason: options.reason },
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies,
                assertCurrent
            })
    });
}

export async function rotateRoomJoinCode(
    input: RotateRoomJoinCodeInput
): Promise<GroupJoinCodeResponse> {
    const options = input.options ?? {};
    return await runRoomTargetMutation<GroupJoinCodeResponse>({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) =>
            await rotateStateGroupJoinCode({
                groupId: roomId,
                request: {
                    ...(options.joinCode === undefined ? {} : { joinCode: options.joinCode }),
                    ...(options.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: options.expiresAtEpochMs }),
                    ...(options.reason === undefined ? {} : { reason: options.reason })
                },
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies,
                assertCurrent
            })
    });
}

export async function createRoomInvite(
    input: CreateRoomInviteInput
): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    const request = {
        ...(options.invitationExpiresAtEpochMs === undefined
            ? {}
            : { invitationExpiresAtEpochMs: options.invitationExpiresAtEpochMs }),
        ...(options.reason === undefined ? {} : { reason: options.reason })
    };
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) =>
            await createStateGroupInvite({
                groupId: roomId,
                targetPrincipalId: input.principalId,
                request,
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies,
                assertCurrent
            })
    });
}

export async function acceptRoomInvite(
    input: AcceptRoomInviteInput
): Promise<GroupSnapshot> {
    return await runRoomTargetMutation({
        ...input,
        options: input.options ?? {},
        execute: async ({ roomId, session, scope, policies, generationId, context, signal, assertCurrent }) =>
            await acceptStateGroupInvite({
                nowMs: input.nowMs,
                groupPresence: context.middleware.heartbeat.groupPresence,
                groupId: roomId,
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                generationId,
                connectionGenerationId: await requireOwnWsConnectionGenerationId(context, signal),
                publicationKey: await input.readPublicationKey(),
                scope,
                policies,
                assertCurrent
            })
    });
}

export async function removeRoomMember(
    input: RoomMemberGovernanceInput
): Promise<GroupSnapshot> {
    return await governRoomMember({ ...input, action: 'remove' });
}

export async function banRoomMember(
    input: RoomMemberGovernanceInput
): Promise<GroupSnapshot> {
    return await governRoomMember({ ...input, action: 'ban' });
}

export async function unbanRoomMember(
    input: RoomMemberGovernanceInput
): Promise<GroupSnapshot> {
    return await governRoomMember({ ...input, action: 'unban' });
}

export async function setRoomMemberRole(
    input: SetRoomMemberRoleInput
): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) =>
            await setStateGroupMemberRole({
                groupId: roomId,
                targetPrincipalId: input.principalId,
                request: {
                    role: input.role,
                    ...(options.reason === undefined ? {} : { reason: options.reason })
                },
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies,
                assertCurrent
            })
    });
}

export async function transferRoomOwnership(
    input: RoomMemberGovernanceInput
): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) =>
            await transferStateGroupOwnership({
                groupId: roomId,
                request: {
                    newOwnerPrincipalId: input.principalId,
                    ...(options.reason === undefined ? {} : { reason: options.reason })
                },
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies,
                assertCurrent
            })
    });
}

async function governRoomMember(
    input: GovernRoomMemberInput
): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    const request = options.reason === undefined ? {} : { reason: options.reason };
    const changeMembership = input.action === 'remove'
        ? removeStateGroupMember
        : input.action === 'ban'
        ? banStateGroupMember
        : unbanStateGroupMember;
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) =>
            await changeMembership({
                groupId: roomId,
                targetPrincipalId: input.principalId,
                request,
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies,
                assertCurrent
            })
    });
}
