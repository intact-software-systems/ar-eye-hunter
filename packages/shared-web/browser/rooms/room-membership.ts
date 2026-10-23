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

type RoomMembershipInput = Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'> & {
    readonly room: string | GroupRef | RallarRoomTargetInput;
};

export async function revokeRoomInvite(
    input: RoomMembershipInput & { readonly principalId: string; readonly options?: RallarRoomGovernanceOptions; }
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
    input: RoomMembershipInput & { readonly options?: RallarRoomJoinCodeOptions; }
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
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly options?: RallarRoomInviteOptions;
    }
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
    input: RoomMembershipInput & {
        readonly options?: RallarRoomGovernanceOptions;
    }
): Promise<GroupSnapshot> {
    return await runRoomTargetMutation({
        ...input,
        options: input.options ?? {},
        execute: async ({ roomId, session, scope, policies, generationId, context, signal, assertCurrent }) =>
            await acceptStateGroupInvite({
                groupId: roomId,
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                generationId,
                connectionGenerationId: await requireOwnWsConnectionGenerationId(context, signal),
                scope,
                policies,
                assertCurrent
            })
    });
}

export async function removeRoomMember(
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly options?: RallarRoomGovernanceOptions;
    }
): Promise<GroupSnapshot> {
    return await governRoomMember({ ...input, action: 'remove' });
}

export async function banRoomMember(
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly options?: RallarRoomGovernanceOptions;
    }
): Promise<GroupSnapshot> {
    return await governRoomMember({ ...input, action: 'ban' });
}

export async function unbanRoomMember(
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly options?: RallarRoomGovernanceOptions;
    }
): Promise<GroupSnapshot> {
    return await governRoomMember({ ...input, action: 'unban' });
}

export async function setRoomMemberRole(
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly role: GroupRole;
        readonly options?: RallarRoomGovernanceOptions;
    }
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
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly options?: RallarRoomGovernanceOptions;
    }
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
    input: RoomMembershipInput & {
        readonly principalId: string;
        readonly options?: RallarRoomGovernanceOptions;
        readonly action: 'remove' | 'ban' | 'unban';
    }
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
