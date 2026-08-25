import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';

import { createRoomSwitchPartialFailureError } from './create-and-join-room.ts';
import { leaveRoom, type LeaveRoomInput } from './leave-room.ts';
import type { RallarJoinRoomInput, RallarJoinRoomOptions, RallarRoomSession } from './rallar-room-contracts.ts';
import type { GroupRef, GroupSnapshot, StateScope } from './room-group-state-translation.ts';
import { joinStateGroup, type StateGroupWorkflowValue } from './room-group-state-workflows.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';
import { assertValidRoomTarget, toJoinRoomTarget } from './room-target.ts';

export interface JoinRoomInput extends Omit<LeaveRoomInput, 'input'> {
    readonly room: string | GroupRef | RallarJoinRoomInput;
    readonly options?: RallarJoinRoomOptions;
    readonly createRoomSession: (roomRef: GroupRef) => RallarRoomSession;
}

interface LeavePreviousRoomAfterJoinInput {
    readonly input: JoinRoomInput;
    readonly joinedRoom: GroupSnapshot;
    readonly currentRoomRef: GroupRef | undefined;
    readonly targetRoomRef: GroupRef | undefined;
    readonly targetRoomId: string;
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
        const snapshot = await joinStateGroup(
            roomId,
            session.clientId,
            session.sessionId,
            context.middleware.heartbeat.generationId,
            scope,
            toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
            { inviteToken: joinInput.options.inviteToken, joinCode: joinInput.options.joinCode }
        );
        input.stateStore.setCurrentRoom(snapshot);
        await input.acceptSnapshots({ context, clients: [], groups: [snapshot], scope });
        await leavePreviousRoomAfterJoin({
            input,
            joinedRoom: snapshot,
            currentRoomRef,
            targetRoomRef: roomRef,
            targetRoomId: roomId,
            leaveCurrent: joinInput.options.leaveCurrent,
            operationOptions
        });
        return snapshot;
    });
}

export async function enterRoom(input: JoinRoomInput): Promise<RallarRoomSession> {
    const snapshot = await joinRoom(input);
    return input.createRoomSession(snapshot.group);
}

async function leavePreviousRoomAfterJoin(input: LeavePreviousRoomAfterJoinInput): Promise<void> {
    const { currentRoomRef } = input;
    const joinsCurrentRoom = currentRoomRef
        ? input.targetRoomRef
            ? isSameGroupRef(currentRoomRef, input.targetRoomRef)
            : currentRoomRef.groupId === input.targetRoomId
        : false;
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
            operation: 'join',
            joinedRoom: input.joinedRoom,
            previousRoomRef: currentRoomRef,
            leaveError: error
        });
    }
}
