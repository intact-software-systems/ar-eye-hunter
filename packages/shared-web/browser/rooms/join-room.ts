import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import type { QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { toError } from '@shared/resilience/to-error.ts';

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
import { requireOwnWsConnectionGenerationId } from './require-own-ws-connection-generation-id.ts';
import type { GroupRef, GroupSnapshot, StateScope } from './room-group-state-translation.ts';
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
    const snapshot = await joinStateGroup({
        groupId: roomId,
        principalId: session.clientId,
        sessionId: session.sessionId,
        generationId: context.middleware.heartbeat.generationId,
        connectionGenerationId: await requireOwnWsConnectionGenerationId(context, options.signal),
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
    try {
        await adoptJoinedRoom({
            dependencies: input,
            context,
            snapshot,
            scope,
            assertCurrent: sessionFence.assertCurrent
        });
    }
    catch (cause) {
        throw createRoomJoinPartialFailureError(snapshot, toError(cause));
    }
    await leavePreviousRoomAfterJoin({
        input: { ...input, sessionFence },
        joinedRoom: snapshot,
        currentRoomRef,
        operation: 'join',
        leaveCurrent: target.options.leaveCurrent,
        operationOptions: options
    });
    sessionFence.assertCurrent(context);
    return snapshot;
}

export interface QuickJoinRoomInput extends Omit<LeaveRoomInput, 'input'> {
    readonly options: RallarQuickJoinRoomInput;
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
    const snapshot = await createStateGroupPresenceCommand({
        groupId: input.joinedRoom.group.groupId,
        principalId: input.session.clientId,
        sessionId: input.session.sessionId,
        generationId: input.context.middleware.heartbeat.generationId,
        connectionGenerationId,
        scope,
        authSession: input.session,
        policies: toRallarWorkflowPolicies<StateGroupWorkflowValue>(input.options)
    }).run();
    input.assertCurrent();
    if (!snapshot) {
        throw new Error('Quick Join presence did not produce a snapshot.');
    }
    await adoptJoinedRoom({
        dependencies: input.dependencies,
        context: input.context,
        snapshot,
        scope,
        assertCurrent: input.assertCurrent
    });
    return snapshot;
}

interface AdoptJoinedRoomInput {
    readonly dependencies: Pick<LeaveRoomInput, 'stateStore' | 'acceptSnapshots'>;
    readonly context: ApiMiddleware;
    readonly snapshot: GroupSnapshot;
    readonly scope: StateScope | undefined;
    readonly assertCurrent: RoomSessionFence['assertCurrent'];
}

async function adoptJoinedRoom(input: AdoptJoinedRoomInput): Promise<void> {
    input.assertCurrent(input.context);
    input.dependencies.stateStore.setCurrentRoom(input.snapshot);
    await input.dependencies.acceptSnapshots({
        context: input.context,
        clients: [],
        groups: [input.snapshot],
        scope: input.scope
    });
    input.assertCurrent(input.context);
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
