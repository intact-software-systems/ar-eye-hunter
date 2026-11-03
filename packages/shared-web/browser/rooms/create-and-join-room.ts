import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    toRallarOperationOptions,
    toRallarWorkflowPolicies,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { adoptJoinedRoom } from './adopt-joined-room.ts';
import { leaveRoom } from './leave-room.ts';
import type { RallarCreateRoomInput, RallarRoomSwitchPartialFailureError } from './rallar-room-contracts.ts';
import { requireOwnWsConnectionGenerationId } from './require-own-ws-connection-generation-id.ts';
import type { GroupRef, GroupSnapshot, StateScope } from './room-group-state-translation.ts';
import {
    createAndJoinStateGroup,
    createRoomJoinPartialFailureError,
    type StateGroupWorkflowValue
} from './room-group-state-workflows.ts';
import { captureRoomSession, type RoomSessionFence } from './room-session-fence.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';

export interface CreateAndJoinRoomInput {
    readonly room: string | RallarCreateRoomInput;
    readonly sessionFence?: RoomSessionFence;
    readonly stateStore: RallarRoomStateStorePort;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (input: RallarStateSnapshotAcceptanceInput) => Promise<void>;
}

export async function createAndJoinRoom(input: CreateAndJoinRoomInput): Promise<GroupSnapshot> {
    return await input.runAuthAwareOperation(() => createAuthenticatedRoom(input));
}

async function createAuthenticatedRoom(input: CreateAndJoinRoomInput): Promise<GroupSnapshot> {
    const createInput = typeof input.room === 'string' ? { displayName: input.room } : input.room;
    const operationOptions = input.resolveOperationOptions(createInput);
    const fence = input.sessionFence ?? captureRoomSession(input.requireSession, operationOptions.signal);
    fence.assertCurrent();
    const context = await input.connect(operationOptions);
    fence.assertCurrent(context);
    const session = fence.session;
    const scope = input.resolveOperationScope(createInput.scope);
    const snapshot = await createAndJoinStateGroup({
        displayName: createInput.displayName,
        principalId: session.clientId,
        sessionId: session.sessionId,
        generationId: context.middleware.heartbeat.generationId,
        connectionGenerationId: await requireOwnWsConnectionGenerationId(context, operationOptions.signal),
        scope,
        policies: toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
        requestedGroupId: createInput.groupId,
        options: toCreateOptions(createInput),
        authSession: session,
        assertCurrent: () => fence.assertCurrent(context)
    });
    try {
        return await adoptJoinedRoom({
            dependencies: input,
            context,
            snapshot,
            options: operationOptions,
            assertCurrent: fence.assertCurrent
        });
    }
    catch (cause) {
        throw createRoomJoinPartialFailureError(snapshot, toError(cause));
    }
}

export interface CreateAndSwitchRoomInput extends CreateAndJoinRoomInput {
    readonly leaveRoom: (
        input: Parameters<typeof leaveRoom>[0]
    ) => Promise<GroupSnapshot | undefined>;
    readonly resolveDefaultRoomRef: () => GroupRef | undefined;
}

interface CreateRoomSwitchPartialFailureErrorInput {
    readonly operation: RallarRoomSwitchPartialFailureError['operation'];
    readonly joinedRoom: GroupSnapshot;
    readonly previousRoomRef: GroupRef;
    readonly leaveError: RallarRoomSwitchPartialFailureError['leaveError'];
}

export async function createAndSwitchRoom(input: CreateAndSwitchRoomInput): Promise<GroupSnapshot> {
    return await input.runAuthAwareOperation(() => createAndSwitchAuthenticatedRoom(input));
}

async function createAndSwitchAuthenticatedRoom(input: CreateAndSwitchRoomInput): Promise<GroupSnapshot> {
    const createInput = typeof input.room === 'string' ? { displayName: input.room } : input.room;
    const previousRoomRef = input.stateStore.resolveCurrentRoomRef();
    const leaveOptions = toRallarOperationOptions(input.resolveOperationOptions(createInput));
    const sessionFence = captureRoomSession(input.requireSession, leaveOptions.signal);
    const snapshot = await createAndJoinRoom({ ...input, sessionFence });
    if (previousRoomRef && !isSameGroupRef(previousRoomRef, snapshot.group)) {
        try {
            await input.leaveRoom({
                ...input,
                sessionFence,
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
                leaveError: toError(error)
            });
        }
    }
    return snapshot;
}

export function createRoomSwitchPartialFailureError(
    input: CreateRoomSwitchPartialFailureErrorInput
): RallarRoomSwitchPartialFailureError {
    const message = input.leaveError.message;
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
        ...(input.directoryListing === undefined ? {} : { directoryListing: input.directoryListing }),
        ...(input.retention === undefined ? {} : { retention: input.retention }),
        ...(input.maxMembers === undefined ? {} : { maxMembers: input.maxMembers }),
        ...(input.maxSpectators === undefined ? {} : { maxSpectators: input.maxSpectators }),
        ...(input.maxSessionsPerMember === undefined
            ? {}
            : { maxSessionsPerMember: input.maxSessionsPerMember }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: input.expiresAtEpochMs }),
        ...(input.purgeAfterEpochMs === undefined
            ? {}
            : { purgeAfterEpochMs: input.purgeAfterEpochMs }),
        ...(input.lifecyclePolicy === undefined ? {} : { lifecyclePolicy: input.lifecyclePolicy })
    };
    return Object.keys(options).length > 0 ? options : undefined;
}
