import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';
import type { QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { CommandCancelledError } from '@shared/cache/Command.ts';
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
import type { GroupRef, GroupSnapshot } from './room-group-state-translation.ts';
import {
    createStateGroupPresenceCommand,
    joinStateGroup,
    quickJoinStateGroup,
    type StateGroupWorkflowValue
} from './room-group-state-workflows.ts';
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
    return await input.runAuthAwareOperation(async () => {
        const joinInput = toJoinRoomTarget(input.room, input.options ?? {});
        assertValidRoomTarget(joinInput);
        const operationOptions = input.resolveOperationOptions(joinInput.options);
        const context = await input.connect(operationOptions);
        const session = input.requireSession();
        const currentRoomRef = input.stateStore.resolveCurrentRoomRef();
        const roomRef = joinInput.roomRef ??
            (joinInput.roomId
                ? toGroupRefFromScope(
                    joinInput.roomId,
                    input.resolveOperationScope(joinInput.options.scope)
                )
                : undefined);
        const roomId = joinInput.roomId ?? roomRef?.groupId;
        const scope = joinInput.options.scope ??
            (roomRef ? toStateScope(roomRef) : input.resolveOperationScope(joinInput.options.scope));
        if (!roomId) {
            throw new Error('Cannot join room: room is required.');
        }
        const snapshot = await joinStateGroup({
            groupId: roomId,
            principalId: session.clientId,
            sessionId: session.sessionId,
            generationId: context.middleware.heartbeat.generationId,
            connectionGenerationId: await requireOwnWsConnectionGenerationId(context, operationOptions.signal),
            scope,
            policies: toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
            intent: {
                inviteToken: joinInput.options.inviteToken,
                joinCode: joinInput.options.joinCode
            }
        });
        input.stateStore.setCurrentRoom(snapshot);
        await input.acceptSnapshots({ context, clients: [], groups: [snapshot], scope });
        await leavePreviousRoomAfterJoin({
            input,
            joinedRoom: snapshot,
            currentRoomRef,
            operation: 'join',
            leaveCurrent: joinInput.options.leaveCurrent,
            operationOptions
        });
        return snapshot;
    });
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
    return await input.runAuthAwareOperation(async () => {
        const options = input.resolveOperationOptions(input.options);
        const session = input.requireSession();
        const context = await input.connect(options);
        const currentRoomRef = input.stateStore.resolveCurrentRoomRef();
        const scope = input.resolveOperationScope(input.options.scope);
        const assertCurrent = (): void => {
            if (options.signal?.aborted) {
                throw new CommandCancelledError();
            }
            if (
                input.requireSession().sessionId !== session.sessionId ||
                context.session.sessionId !== session.sessionId
            ) {
                throw new DOMException('Quick Join belongs to an obsolete session', 'AbortError');
            }
        };
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
    });
}

async function connectQuickJoinedRoom(input: ConnectQuickJoinedRoomInput): Promise<GroupSnapshot> {
    try {
        return await input.dependencies.runAuthAwareOperation(async () => {
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
            input.dependencies.stateStore.setCurrentRoom(snapshot);
            await input.dependencies.acceptSnapshots({
                context: input.context,
                clients: [],
                groups: [snapshot],
                scope
            });
            input.assertCurrent();
            return snapshot;
        });
    }
    catch (cause) {
        const error: RallarQuickJoinPartialFailureError = Object.assign(
            new Error(`Joined room ${input.joinedRoom.group.groupId}, but entering it failed.`, { cause }),
            { name: 'RallarQuickJoinPartialFailureError' as const, joinedRoom: input.joinedRoom }
        );
        throw error;
    }
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
