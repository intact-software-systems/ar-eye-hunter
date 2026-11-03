import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import {
    toApiMutationWorkflowRequestId,
    tolerateStateWorkflowNotFound
} from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { QuickJoinGroupRequest, QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { Command } from '@shared/cache/Command.ts';
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

export interface CreateAndJoinStateGroupInput extends Omit<ConnectStateGroupPresenceInput, 'groupId'> {
    readonly displayName: string;
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
    const createdRoom = await new Command<StateGroupWorkflowValue>(
        (signal) => {
            input.assertCurrent?.();
            return roomGroupStateHttpApi.createGroup({
                request,
                options: { requestId, signal, authSession: input.authSession },
                scope
            });
        },
        input.policies?.command
    ).run();
    return await connectAdmittedRoomPresence(createdRoom, presence, input.assertCurrent);
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
    return await connectAdmittedRoomPresence(joinedRoom, presence, input.assertCurrent);
}

async function connectAdmittedRoomPresence(
    joinedRoom: StateGroupWorkflowValue,
    presence: Command<StateGroupWorkflowValue>,
    assertCurrent: (() => void) | undefined
): Promise<GroupSnapshot> {
    if (!joinedRoom) {
        throw new Error('Room admission did not produce a snapshot.');
    }
    try {
        assertCurrent?.();
        const snapshot = requireConnectedPresence(await presence.run());
        assertCurrent?.();
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

/** A revoked membership stays revoked; local departure succeeds without a new snapshot. */
export async function leaveStateGroup(input: LeaveStateGroupInput): Promise<GroupSnapshot | undefined> {
    const disconnectRequestId = toApiMutationWorkflowRequestId();
    const memberRequestId = toApiMutationWorkflowRequestId();
    const disconnect = createLeavingPresenceCommand(input, disconnectRequestId);
    const leave = createLeavingMembershipCommand(input, memberRequestId);
    await disconnect.run();
    return await leave.run();
}

function createLeavingMembershipCommand(
    input: LeaveStateGroupInput,
    requestId: string
): Command<StateGroupWorkflowValue> {
    const request = toLeaveRoomMemberGroupStateRequest({
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    return new Command<StateGroupWorkflowValue>(async (signal) => {
        input.assertCurrent?.();
        try {
            return await roomGroupStateHttpApi.upsertMember({
                groupId: input.groupId,
                principalId: input.principalId,
                request,
                options: { requestId, signal, authSession: input.authSession },
                scope: input.scope ?? defaultStateScope()
            });
        }
        catch (error) {
            if (
                error instanceof ApiHttpError && error.status === 403 &&
                (error.policyError?.code === 'member-banned' || error.policyError?.code === 'member-removed')
            ) {
                return undefined;
            }
            throw error;
        }
    }, { ...input.policies?.command, errorOnNull: false });
}

function createLeavingPresenceCommand(
    input: LeaveStateGroupInput,
    requestId: string
): Command<StateGroupWorkflowValue> {
    const request = toDisconnectRoomPresenceGroupStateRequest({
        generationId: input.generationId,
        principalId: input.principalId,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });
    return new Command<StateGroupWorkflowValue>(async (signal) => {
        input.assertCurrent?.();
        try {
            return await roomGroupStateHttpApi.disconnectPresence({
                groupId: input.groupId,
                sessionId: input.sessionId,
                request,
                options: { requestId, signal, authSession: input.authSession },
                scope: input.scope ?? defaultStateScope()
            });
        }
        catch (error) {
            return tolerateStateWorkflowNotFound(error, undefined);
        }
    }, { ...input.policies?.command, errorOnNull: false });
}
