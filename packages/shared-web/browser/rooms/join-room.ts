import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    toRallarCommandOptions,
    toRallarWorkflowPolicies,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';
import { decodeGroupMove } from '@shared/api/mutation/decode-group-move.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import type { QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { Command } from '@shared/cache/Command.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { toApiMutationWorkflowRequestId, tolerateStateWorkflowNotFound } from '../state-read/state-workflow-support.ts';
import { adoptJoinedRoom } from './adopt-joined-room.ts';
import { createRoomSwitchPartialFailureError } from './create-and-join-room.ts';
import { leaveRoom, type LeaveRoomInput } from './leave-room.ts';
import type {
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarQuickJoinPartialFailureError,
    RallarQuickJoinRoomInput,
    RallarRoomSession,
    RallarRoomSwitchOperation
} from './rallar-room-contracts.ts';
import { readRoomSessionPresence } from './read-room-session-presence.ts';
import { requireOwnWsConnectionGenerationId } from './require-own-ws-connection-generation-id.ts';
import { roomGroupStateHttpApi } from './room-group-state-http-api.ts';
import {
    toDisconnectRoomPresenceGroupStateRequest,
    type GroupRef,
    type GroupSnapshot
} from './room-group-state-translation.ts';
import {
    createRoomJoinPartialFailureError,
    createStateGroupPresenceCommand,
    joinStateGroup,
    quickJoinStateGroup,
    type StateGroupWorkflowValue
} from './room-group-state-workflows.ts';
import { captureRoomSession, type RoomSessionFence } from './room-session-fence.ts';
import { assertValidRoomTarget, toJoinRoomTarget } from './room-target.ts';

export interface JoinRoomInput extends Omit<LeaveRoomInput, 'input'> {
    readonly room: string | GroupRef | RallarJoinRoomInput;
    readonly options?: RallarJoinRoomOptions;
    readonly readPublicationKey: () => Promise<GroupPresencePublicationKey | null>;
    readonly createRoomSession: (roomRef: GroupRef) => RallarRoomSession;
}

interface LeavePreviousRoomAfterJoinInput {
    readonly input: Omit<LeaveRoomInput, 'input'>;
    readonly operation: RallarRoomSwitchOperation;
    readonly joinedRoom: GroupSnapshot;
    readonly currentRoomRef: GroupRef | undefined;
    readonly leaveCurrent: boolean | undefined;
    readonly operationOptions: RallarOperationOptions;
}

export async function joinRoom(input: JoinRoomInput): Promise<GroupSnapshot> {
    return await input.runAuthAwareOperation(() => joinAuthenticatedRoom(input));
}

async function joinAuthenticatedRoom(input: JoinRoomInput): Promise<GroupSnapshot> {
    const target = toJoinRoomTarget(input.room, input.options ?? {});
    assertValidRoomTarget(target);
    const roomId = target.roomId ?? target.roomRef?.groupId;
    if (!roomId) {
        throw new Error('Validated room target has no room identity.');
    }
    const scope = target.options.scope ??
        (target.roomRef ? toStateScope(target.roomRef) : input.resolveOperationScope(target.options.scope));
    const options = input.resolveOperationOptions(target.options);
    const sessionFence = captureRoomSession(input.requireSession, options.signal);
    sessionFence.assertCurrent();
    const context = await input.connect(options);
    sessionFence.assertCurrent(context);
    const session = sessionFence.session;
    const currentRoomRef = input.stateStore.resolveCurrentRoomRef();
    const generationId = crypto.randomUUID();
    const snapshot = await joinStateGroup({
        groupId: roomId,
        principalId: session.clientId,
        sessionId: session.sessionId,
        generationId,
        connectionGenerationId: await requireOwnWsConnectionGenerationId(context, options.signal),
        publicationKey: await input.readPublicationKey(),
        scope,
        authSession: session,
        assertCurrent: sessionFence.assertCurrent,
        policies: toRallarWorkflowPolicies<StateGroupWorkflowValue>(options),
        intent: {
            inviteToken: target.options.inviteToken,
            joinCode: target.options.joinCode,
            participation: target.options.participation
        }
    });
    const arrived = await readRoomSessionPresence({
        snapshot,
        sessionId: session.sessionId,
        generationId,
        present: true,
        fence: sessionFence,
        context,
        options,
        minPresenceRevision: 0
    }).catch((cause) => {
        throw createRoomJoinPartialFailureError(snapshot, toError(cause));
    });
    input.enteredRooms.rememberEnteredRoom(arrived.group);
    return await completeRoomJoin({
        input,
        context,
        snapshot: arrived,
        currentRoomRef,
        fence: sessionFence,
        options,
        leaveCurrent: target.options.leaveCurrent ?? true,
        preserveCurrentMembership: target.options.preserveCurrentMembership ?? false
    });
}

interface RoomJoinCompletion {
    readonly input: JoinRoomInput;
    readonly context: ApiMiddleware;
    readonly snapshot: GroupSnapshot;
    readonly currentRoomRef: GroupRef | undefined;
    readonly fence: RoomSessionFence;
    readonly options: RallarOperationOptions;
    readonly leaveCurrent: boolean;
    readonly preserveCurrentMembership: boolean;
}

/** Admission is committed. Keep the source selected until a presence-only departure can be confirmed. */
async function completeRoomJoin(completion: RoomJoinCompletion): Promise<GroupSnapshot> {
    const { input, context, snapshot, currentRoomRef, fence, options, leaveCurrent, preserveCurrentMembership } =
        completion;
    let adopted: GroupSnapshot;
    try {
        let departedRoom: GroupSnapshot | undefined;
        if (
            leaveCurrent && preserveCurrentMembership && currentRoomRef &&
            !isSameGroupRef(currentRoomRef, snapshot.group)
        ) {
            departedRoom = await disconnectRoomSession({
                input,
                roomRef: currentRoomRef,
                context,
                fence,
                options,
                generationId: context.middleware.heartbeat.generationId
            });
        }
        adopted = await adoptRoomAfterDeparture({
            dependencies: input,
            context,
            snapshot,
            options,
            fence,
            departedRoom
        });
    }
    catch (cause) {
        throw createRoomJoinPartialFailureError(snapshot, toError(cause));
    }
    await leavePreviousRoomAfterJoin({
        input: { ...input, sessionFence: fence },
        joinedRoom: adopted,
        currentRoomRef,
        operation: 'join',
        leaveCurrent: preserveCurrentMembership ? false : leaveCurrent,
        operationOptions: options
    });
    fence.assertCurrent(context);
    return adopted;
}

export interface ActivateGroupMoveInput extends Omit<LeaveRoomInput, 'input'> {
    readonly move: GroupMove;
    readonly options: RallarOperationOptions;
    readonly readPublicationKey: () => Promise<GroupPresencePublicationKey | null>;
}

/** Membership was admitted atomically by the move; activation changes this session's presence only. */
export async function activateGroupMove(input: ActivateGroupMoveInput): Promise<GroupSnapshot> {
    return await input.runAuthAwareOperation(() => activateAuthenticatedGroupMove(input));
}

async function activateAuthenticatedGroupMove(input: ActivateGroupMoveInput): Promise<GroupSnapshot> {
    const move = decodeGroupMove(input.move);
    const options = input.resolveOperationOptions(input.options);
    const fence = captureRoomSession(input.requireSession, options.signal);
    if (
        move.status !== 'committed' ||
        !move.participants.some((participant) => participant.principalId === fence.session.clientId)
    ) {
        throw new Error('Only an admitted participant can enter a committed move.');
    }
    const current = input.stateStore.resolveCurrentRoomRef();
    if (current && !isSameGroupRef(current, move.source) && !isSameGroupRef(current, move.destination)) {
        throw new Error(`Return to source room ${move.source.groupId} before retrying this move.`);
    }
    const context = await input.connect(options);
    fence.assertCurrent(context);
    const snapshot = await connectMovedSession({ input, move, context, fence, options });
    const departedRoom = await disconnectRoomSession({
        input,
        context,
        fence,
        options,
        roomRef: move.source,
        generationId: move.participants.find((participant) =>
            participant.sessionId === fence.session.sessionId
        )?.generationId ??
            context.middleware.heartbeat.generationId
    });
    return await adoptRoomAfterDeparture({
        dependencies: input,
        context,
        snapshot,
        options,
        fence,
        departedRoom
    });
}

interface RoomPresenceHandoff {
    readonly dependencies: Pick<LeaveRoomInput, 'stateStore' | 'acceptSnapshots'>;
    readonly context: ApiMiddleware;
    readonly snapshot: GroupSnapshot;
    readonly departedRoom: GroupSnapshot | undefined;
    readonly options: RallarOperationOptions;
    readonly fence: RoomSessionFence;
}

/** Publish the destination before its departed source, avoiding an empty selection from this handoff. */
async function adoptRoomAfterDeparture(handoff: RoomPresenceHandoff): Promise<GroupSnapshot> {
    const adopted = await adoptJoinedRoom({
        dependencies: handoff.dependencies,
        context: handoff.context,
        snapshot: handoff.snapshot,
        options: handoff.options,
        assertCurrent: handoff.fence.assertCurrent
    });
    if (handoff.departedRoom) {
        await handoff.dependencies.acceptSnapshots({
            context: handoff.context,
            clients: [],
            groups: [handoff.departedRoom],
            scope: toStateScope(handoff.departedRoom.group),
            assertCurrent: () => handoff.fence.assertCurrent(handoff.context)
        });
        handoff.fence.assertCurrent(handoff.context);
    }
    return adopted;
}

interface GroupMoveActivation {
    readonly input: ActivateGroupMoveInput;
    readonly move: GroupMove;
    readonly context: ApiMiddleware;
    readonly fence: RoomSessionFence;
    readonly options: RallarOperationOptions;
}

async function connectMovedSession(
    { input, move, context, fence, options }: GroupMoveActivation
): Promise<GroupSnapshot> {
    const generationId = crypto.randomUUID();
    const connected = await createStateGroupPresenceCommand({
        groupId: move.destination.groupId,
        principalId: fence.session.clientId,
        sessionId: fence.session.sessionId,
        generationId,
        connectionGenerationId: await requireOwnWsConnectionGenerationId(context, options.signal),
        publicationKey: await input.readPublicationKey(),
        scope: toStateScope(move.destination),
        authSession: fence.session,
        assertCurrent: () => fence.assertCurrent(context),
        policies: toRallarWorkflowPolicies<StateGroupWorkflowValue>(options)
    }).run();
    fence.assertCurrent(context);
    if (!connected) {
        throw new Error('Destination presence did not produce a snapshot.');
    }
    const snapshot = await readRoomSessionPresence({
        snapshot: connected,
        sessionId: fence.session.sessionId,
        generationId,
        present: true,
        minPresenceRevision: 0,
        fence,
        context,
        options
    });
    input.enteredRooms.rememberEnteredRoom(move.destination);
    return snapshot;
}

interface RoomPresenceDeparture {
    readonly input: Pick<LeaveRoomInput, 'stateStore' | 'enteredRooms'>;
    readonly roomRef: GroupRef;
    readonly generationId: string;
    readonly context: ApiMiddleware;
    readonly fence: RoomSessionFence;
    readonly options: RallarOperationOptions;
}

async function disconnectRoomSession(
    { input, roomRef, generationId, context, fence, options }: RoomPresenceDeparture
): Promise<GroupSnapshot | undefined> {
    input.enteredRooms.forgetEnteredRoom(roomRef);
    const sourceBeforeDisconnect = input.stateStore.findGroupSnapshot(roomRef);
    const sourceSession = sourceBeforeDisconnect?.activeSessions.find((session) =>
        session.sessionId === fence.session.sessionId
    );
    const requestId = toApiMutationWorkflowRequestId();
    const request = toDisconnectRoomPresenceGroupStateRequest({
        generationId: sourceSession?.generationId ?? generationId,
        principalId: fence.session.clientId,
        actorPrincipalId: fence.session.clientId,
        actorSessionId: fence.session.sessionId
    });
    const source = await new Command<GroupSnapshot | undefined>(async (signal) => {
        fence.assertCurrent(context);
        try {
            return await roomGroupStateHttpApi.disconnectPresence({
                groupId: roomRef.groupId,
                sessionId: fence.session.sessionId,
                request,
                options: { requestId, signal, authSession: fence.session },
                scope: toStateScope(roomRef)
            });
        }
        catch (error) {
            return tolerateStateWorkflowNotFound(error, undefined);
        }
    }, toRallarCommandOptions(options)).run();
    fence.assertCurrent(context);
    if (source) {
        return await readRoomSessionPresence({
            snapshot: source,
            sessionId: fence.session.sessionId,
            generationId: request.generationId,
            present: false,
            fence,
            context,
            options,
            minPresenceRevision: sourceBeforeDisconnect && sourceSession
                ? sourceBeforeDisconnect.causalRevision.presenceRevision + 1
                : 0
        });
    }
    return undefined;
}

export interface QuickJoinRoomInput extends Omit<LeaveRoomInput, 'input'> {
    readonly options: RallarQuickJoinRoomInput;
    readonly readPublicationKey: () => Promise<GroupPresencePublicationKey | null>;
}

interface ConnectQuickJoinedRoomInput {
    readonly dependencies: QuickJoinRoomInput;
    readonly context: ApiMiddleware;
    readonly session: AuthSession;
    readonly options: RallarOperationOptions;
    readonly joinedRoom: GroupSnapshot;
    readonly assertCurrent: () => void;
}

export async function quickJoinRoom(input: QuickJoinRoomInput): Promise<QuickJoinGroupResult> {
    return await input.runAuthAwareOperation(() => quickJoinAuthenticatedRoom(input));
}

async function quickJoinAuthenticatedRoom(input: QuickJoinRoomInput): Promise<QuickJoinGroupResult> {
    const options = input.resolveOperationOptions(input.options);
    const sessionFence = captureRoomSession(input.requireSession, options.signal);
    const session = sessionFence.session;
    const context = await input.connect(options);
    const currentRoomRef = input.stateStore.resolveCurrentRoomRef();
    const scope = input.resolveOperationScope(input.options.scope);
    const assertCurrent = () => sessionFence.assertCurrent(context);
    assertCurrent();
    const result = await quickJoinStateGroup({
        request: { kind: input.options.kind, q: input.options.q, includeEmpty: input.options.includeEmpty },
        scope,
        authSession: session,
        policies: toRallarWorkflowPolicies<QuickJoinGroupResult>(options)
    });
    if (result.status === 'unavailable') {
        assertCurrent();
        return result;
    }
    const snapshot = await connectQuickJoinedRoom({
        dependencies: input,
        context,
        session,
        options,
        joinedRoom: result.snapshot,
        assertCurrent
    });
    await leavePreviousRoomAfterJoin({
        input: { ...input, sessionFence: { session, assertCurrent } },
        operation: 'quick-join',
        joinedRoom: snapshot,
        currentRoomRef,
        leaveCurrent: input.options.leaveCurrent,
        operationOptions: options
    });
    assertCurrent();
    return { status: 'joined', snapshot };
}

async function connectQuickJoinedRoom(input: ConnectQuickJoinedRoomInput): Promise<GroupSnapshot> {
    try {
        return await input.dependencies.runAuthAwareOperation(() => connectAuthenticatedQuickJoinedRoom(input));
    }
    catch (cause) {
        const error: RallarQuickJoinPartialFailureError = Object.assign(
            new Error(`Joined room ${input.joinedRoom.group.groupId}, but entering it failed.`, { cause }),
            { name: 'RallarQuickJoinPartialFailureError' as const, joinedRoom: input.joinedRoom }
        );
        throw error;
    }
}

async function connectAuthenticatedQuickJoinedRoom(input: ConnectQuickJoinedRoomInput): Promise<GroupSnapshot> {
    input.assertCurrent();
    const scope = toStateScope(input.joinedRoom.group);
    const connectionGenerationId = await requireOwnWsConnectionGenerationId(
        input.context,
        input.options.signal
    );
    input.assertCurrent();
    const generationId = crypto.randomUUID();
    const snapshot = await createStateGroupPresenceCommand({
        groupId: input.joinedRoom.group.groupId,
        principalId: input.session.clientId,
        sessionId: input.session.sessionId,
        generationId,
        connectionGenerationId,
        publicationKey: await input.dependencies.readPublicationKey(),
        scope,
        authSession: input.session,
        policies: toRallarWorkflowPolicies<StateGroupWorkflowValue>(input.options)
    }).run();
    input.assertCurrent();
    if (!snapshot) {
        throw new Error('Quick Join presence did not produce a snapshot.');
    }
    const arrived = await readRoomSessionPresence({
        snapshot,
        sessionId: input.session.sessionId,
        generationId,
        present: true,
        fence: { session: input.session, assertCurrent: input.assertCurrent },
        context: input.context,
        options: input.options,
        minPresenceRevision: 0
    });
    input.dependencies.enteredRooms.rememberEnteredRoom(arrived.group);
    return await adoptJoinedRoom({
        dependencies: input.dependencies,
        context: input.context,
        snapshot: arrived,
        options: input.options,
        assertCurrent: input.assertCurrent
    });
}

export async function enterRoom(input: JoinRoomInput): Promise<RallarRoomSession> {
    const snapshot = await joinRoom(input);
    return input.createRoomSession(snapshot.group);
}

async function leavePreviousRoomAfterJoin(input: LeavePreviousRoomAfterJoinInput): Promise<void> {
    const { currentRoomRef } = input;
    const joinsCurrentRoom = currentRoomRef && isSameGroupRef(currentRoomRef, input.joinedRoom.group);
    if (!(input.leaveCurrent ?? true) || !currentRoomRef || joinsCurrentRoom) {
        return;
    }
    try {
        await leaveRoom({
            ...input.input,
            input: {
                roomId: currentRoomRef.groupId,
                roomRef: currentRoomRef,
                clearCurrent: false,
                scope: toStateScope(currentRoomRef),
                signal: input.operationOptions.signal,
                timeoutMs: input.operationOptions.timeoutMs
            }
        });
    }
    catch (error) {
        throw createRoomSwitchPartialFailureError({
            operation: input.operation,
            joinedRoom: input.joinedRoom,
            previousRoomRef: currentRoomRef,
            leaveError: toError(error)
        });
    }
}
