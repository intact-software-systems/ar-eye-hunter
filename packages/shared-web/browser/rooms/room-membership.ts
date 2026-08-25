import type {
    RallarRoomGovernanceOptions,
    RallarRoomInviteOptions,
    RallarRoomTargetInput
} from './rallar-room-contracts.ts';
import type { GroupRef, GroupRole, GroupSnapshot } from './room-group-state-translation.ts';
import {
    acceptStateGroupInvite,
    banStateGroupMember,
    createStateGroupInvite,
    removeStateGroupMember,
    setStateGroupMemberRole,
    transferStateGroupOwnership,
    unbanStateGroupMember
} from './room-membership-group-state-workflows.ts';
import { runRoomTargetMutation, type RunRoomTargetMutationInput } from './update-room.ts';

type RoomMembershipInput = Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'> & {
    readonly room: string | GroupRef | RallarRoomTargetInput;
};

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
        execute: async ({ roomId, session, scope, policies }) =>
            await createStateGroupInvite({
                groupId: roomId,
                targetPrincipalId: input.principalId,
                request,
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies
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
        execute: async ({ roomId, session, scope, policies, generationId }) =>
            await acceptStateGroupInvite({
                groupId: roomId,
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                generationId,
                scope,
                policies
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
        execute: async ({ roomId, session, scope, policies }) =>
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
                policies
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
        execute: async ({ roomId, session, scope, policies }) =>
            await transferStateGroupOwnership({
                groupId: roomId,
                request: {
                    newOwnerPrincipalId: input.principalId,
                    ...(options.reason === undefined ? {} : { reason: options.reason })
                },
                actorPrincipalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies
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
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies }) => {
            switch (input.action) {
                case 'remove':
                    return await removeStateGroupMember({
                        groupId: roomId,
                        targetPrincipalId: input.principalId,
                        request,
                        actorPrincipalId: session.clientId,
                        sessionId: session.sessionId,
                        scope,
                        policies
                    });
                case 'ban':
                    return await banStateGroupMember({
                        groupId: roomId,
                        targetPrincipalId: input.principalId,
                        request,
                        actorPrincipalId: session.clientId,
                        sessionId: session.sessionId,
                        scope,
                        policies
                    });
                case 'unban':
                    return await unbanStateGroupMember({
                        groupId: roomId,
                        targetPrincipalId: input.principalId,
                        request,
                        actorPrincipalId: session.clientId,
                        sessionId: session.sessionId,
                        scope,
                        policies
                    });
            }
        }
    });
}
