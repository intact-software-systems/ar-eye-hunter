import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import {
    toRallarOperationOptions,
    toRallarWorkflowPolicies,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';

import { leaveRoom } from './leave-room.ts';
import type { RallarCreateRoomInput, RallarRoomSwitchPartialFailureError } from './rallar-room-contracts.ts';
import type { GroupRef, GroupSnapshot, StateScope } from './room-group-state-translation.ts';
import { createAndJoinStateGroup, type StateGroupWorkflowValue } from './room-group-state-workflows.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';

export interface CreateAndJoinRoomInput {
    readonly room: string | RallarCreateRoomInput;
    readonly stateStore: RallarRoomStateStorePort;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (
        context: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope
    ) => Promise<void>;
}

export async function createAndJoinRoom(input: CreateAndJoinRoomInput): Promise<GroupSnapshot> {
    return await input.runAuthAwareOperation(async () => {
        const createInput = typeof input.room === 'string' ? { displayName: input.room } : input.room;
        const operationOptions = input.resolveOperationOptions(createInput);
        const context = await input.connect(operationOptions);
        const session = input.requireSession();
        const scope = input.resolveOperationScope(createInput.scope);
        const options = toCreateOptions(createInput);
        const snapshot = options
            ? await createAndJoinStateGroup(
                createInput.displayName,
                session.clientId,
                session.sessionId,
                context.middleware.heartbeat.generationId,
                scope,
                toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
                createInput.groupId,
                options
            )
            : await createAndJoinStateGroup(
                createInput.displayName,
                session.clientId,
                session.sessionId,
                context.middleware.heartbeat.generationId,
                scope,
                toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
                createInput.groupId
            );
        input.stateStore.setCurrentRoom(snapshot);
        await input.acceptSnapshots(context, [], [snapshot], scope);
        return snapshot;
    });
}

export interface CreateAndSwitchRoomInput extends CreateAndJoinRoomInput {
    readonly leaveRoom: (
        input: Parameters<typeof leaveRoom>[0]
    ) => Promise<GroupSnapshot | undefined>;
    readonly resolveDefaultRoomRef: () => GroupRef | undefined;
}

interface CreateRoomSwitchPartialFailureErrorInput {
    readonly operation: 'create-and-switch' | 'join';
    readonly joinedRoom: GroupSnapshot;
    readonly previousRoomRef: GroupRef;
    readonly leaveError: unknown;
}

export async function createAndSwitchRoom(input: CreateAndSwitchRoomInput): Promise<GroupSnapshot> {
    const createInput = typeof input.room === 'string' ? { displayName: input.room } : input.room;
    const previousRoomRef = input.stateStore.resolveCurrentRoomRef();
    const leaveOptions = toRallarOperationOptions(input.resolveOperationOptions(createInput));
    const snapshot = await createAndJoinRoom(input);
    if (previousRoomRef && !isSameGroupRef(previousRoomRef, snapshot.group)) {
        try {
            await input.leaveRoom({
                ...input,
                input: {
                    ...leaveOptions,
                    roomId: previousRoomRef.groupId,
                    roomRef: previousRoomRef,
                    clearCurrent: false,
                    scope: toStateScope(previousRoomRef)
                }
            });
        }
        catch (error) {
            throw createRoomSwitchPartialFailureError({
                operation: 'create-and-switch',
                joinedRoom: snapshot,
                previousRoomRef,
                leaveError: error
            });
        }
    }
    return snapshot;
}

export function createRoomSwitchPartialFailureError(
    input: CreateRoomSwitchPartialFailureErrorInput
): RallarRoomSwitchPartialFailureError {
    const message = input.leaveError instanceof Error ? input.leaveError.message : String(input.leaveError);
    const joinedRoomId = input.joinedRoom.group.groupId;
    const previousRoomId = input.previousRoomRef.groupId;
    return Object.assign(
        new Error(
            `Room switch joined ${joinedRoomId}, but leaving ${previousRoomId} failed: ${message}`
        ),
        {
            name: 'RallarRoomSwitchPartialFailureError' as const,
            operation: input.operation,
            joinedRoom: input.joinedRoom,
            previousRoomRef: input.previousRoomRef,
            leaveError: input.leaveError
        }
    );
}

function toCreateOptions(
    input: RallarCreateRoomInput
): Omit<RallarCreateRoomInput, 'displayName' | 'groupId' | 'scope'> | undefined {
    const options = {
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.joinMode === undefined ? {} : { joinMode: input.joinMode }),
        ...(input.maxMembers === undefined ? {} : { maxMembers: input.maxMembers }),
        ...(input.maxSessionsPerMember === undefined
            ? {}
            : { maxSessionsPerMember: input.maxSessionsPerMember }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: input.expiresAtEpochMs }),
        ...(input.purgeAfterEpochMs === undefined
            ? {}
            : { purgeAfterEpochMs: input.purgeAfterEpochMs })
    };
    return Object.keys(options).length > 0 ? options : undefined;
}
