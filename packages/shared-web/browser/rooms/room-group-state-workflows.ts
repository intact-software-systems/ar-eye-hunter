import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import {
    toApiMutationWorkflowRequestId,
    tolerateStateWorkflowNotFound
} from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';
import type { QuickJoinGroupRequest, QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { Command } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { ApiHttpError } from '../api/http-error.ts';
import type { RallarGroupPresencePolicy } from '../session/group-presence-policy.ts';
import type { RallarRoomJoinPartialFailureError } from './rallar-room-contracts.ts';
import { readRoomMembershipRevocation } from './read-room-membership-revocation.ts';

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
    readonly newGroupId: () => string;
    readonly displayName: string;
    readonly requestedGroupId?: string;
    readonly options?: Omit<RoomCreateGroupStateFields, 'displayName'>;
}

export interface ConnectStateGroupPresenceInput {
    readonly nowMs: () => number;
    readonly groupPresence?: RallarGroupPresencePolicy;
    /** A recovery attempt can retain this exact lease until its request outcome is resolved. */
    readonly expiresAtEpochMs?: number;
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly publicationKey: GroupPresencePublicationKey | null;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
    readonly authSession?: AuthSession;
    /** Fences each transport attempt against a replaced session or cancelled destination. */
    readonly assertCurrent?: () => void;
}

export interface JoinStateGroupInput extends ConnectStateGroupPresenceInput {
    readonly presenceOnly?: boolean;
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
    const groupId = input.requestedGroupId?.trim() || input.newGroupId();
    const requestId = toApiMutationWorkflowRequestId();
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
    return await connectAdmittedRoomPresence(createdRoom, { ...input, groupId, scope });
}

export async function joinStateGroup(input: JoinStateGroupInput): Promise<GroupSnapshot> {
    if (input.presenceOnly) {
        if (input.intent?.participation || input.intent?.inviteToken || input.intent?.joinCode) {
            throw new TypeError('Resuming room presence requires an existing seat and cannot change its admission.');
        }
        input.assertCurrent?.();
        const result = requireConnectedPresence(await createStateGroupPresenceCommand(input).run());
        input.assertCurrent?.();
        return result;
    }
    const scope = input.scope ?? defaultStateScope();
    const requestId = toApiMutationWorkflowRequestId();
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
    return await connectAdmittedRoomPresence(joinedRoom, { ...input, scope });
}

async function connectAdmittedRoomPresence(
    joinedRoom: StateGroupWorkflowValue,
    input: ConnectStateGroupPresenceInput
): Promise<GroupSnapshot> {
    if (!joinedRoom) {
        throw new Error('Room admission did not produce a snapshot.');
    }
    try {
        input.assertCurrent?.();
        const presence = createStateGroupPresenceCommand(input);
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
        publicationKey: input.publicationKey,
        expiresAtEpochMs: input.expiresAtEpochMs ??
            toRoomPresenceLeaseExpiresAtEpochMs(input.nowMs(), input.groupPresence?.leaseMs),
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
                readRoomMembershipRevocation(error) !== undefined ||
                (error instanceof ApiHttpError && isEndedGuestSeat(input.authSession, error))
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
            return (error instanceof ApiHttpError && isEndedGuestSeat(input.authSession, error))
                ? undefined
                : tolerateStateWorkflowNotFound(error, undefined);
        }
    }, { ...input.policies?.command, errorOnNull: false });
}

/** A guest can address only its own seat, so a refusal there means the seat ended: a retried leave is complete. */
function isEndedGuestSeat(authSession: AuthSession | undefined, refusal: ApiHttpError): boolean {
    return authSession?.guestRoom !== undefined && refusal.status === 403;
}
