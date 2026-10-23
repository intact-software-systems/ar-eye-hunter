import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import type {
    RallarRoomLifecycleOptions,
    RallarRoomTargetInput,
    RallarUpdateRoomInput
} from './rallar-room-contracts.ts';
import {
    archiveStateGroup,
    deleteStateGroup,
    updateStateGroupDetails,
    updateStateGroupMetadata
} from './room-group-state-mutation-workflows.ts';
import type {
    GroupJoinCodeResponse,
    GroupRef,
    GroupSnapshot,
    StateScope,
    UpdateStateGroupBody
} from './room-group-state-translation.ts';
import { captureRoomSession } from './room-session-fence.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';
import { toRoomTarget } from './room-target.ts';

export interface RunRoomTargetMutationInput<TResult extends GroupSnapshot | GroupJoinCodeResponse = GroupSnapshot> {
    readonly room: string | GroupRef | RallarRoomTargetInput;
    readonly options: RallarScopedOperationOptions;
    readonly stateStore: RallarRoomStateStorePort;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (input: RallarStateSnapshotAcceptanceInput) => Promise<void>;
    readonly execute: (input: RunRoomTargetMutationExecutionInput<TResult>) => Promise<TResult>;
}

interface RunRoomTargetMutationExecutionInput<TResult> {
    readonly roomId: string;
    readonly session: AuthSession;
    readonly scope: StateScope;
    readonly policies: CommandsOrchestratorPolicies<TResult>;
    readonly generationId: string;
    readonly context: ApiMiddleware;
    readonly signal: AbortSignal | undefined;
    readonly assertCurrent: () => void;
}

interface UpdateRoomOperationInput extends Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'> {
    readonly input: RallarUpdateRoomInput;
}

interface RoomLifecycleOperationInput extends Omit<RunRoomTargetMutationInput, 'options' | 'execute'> {
    readonly options?: RallarRoomLifecycleOptions;
}

interface UpdateRoomMetadataOperationInput extends Omit<RunRoomTargetMutationInput, 'execute'> {
    readonly room: string | GroupRef;
    readonly patch: ApiJsonObject;
}

interface ChangeRoomLifecycleInput extends RoomLifecycleOperationInput {
    readonly status: 'archived' | 'deleted';
}

export async function runRoomTargetMutation<TResult extends GroupSnapshot | GroupJoinCodeResponse>(
    input: RunRoomTargetMutationInput<TResult>
): Promise<TResult> {
    return await input.runAuthAwareOperation(() => runAuthenticatedRoomTargetMutation(input));
}

async function runAuthenticatedRoomTargetMutation<TResult extends GroupSnapshot | GroupJoinCodeResponse>(
    input: RunRoomTargetMutationInput<TResult>
): Promise<TResult> {
    const target = toRoomTarget(input.room, input.options);
    const operationOptions = input.resolveOperationOptions(target.options);
    const fence = captureRoomSession(input.requireSession, operationOptions.signal);
    fence.assertCurrent();
    const context = await input.connect(operationOptions);
    fence.assertCurrent(context);
    const scope = target.options.scope ??
        (target.roomRef
            ? toStateScope(target.roomRef)
            : (input.resolveOperationScope(target.options.scope) ?? defaultStateScope()));
    const result = await input.execute({
        roomId: target.roomId,
        session: fence.session,
        scope,
        policies: toRallarWorkflowPolicies<TResult>(operationOptions),
        generationId: context.middleware.heartbeat.generationId,
        context,
        signal: operationOptions.signal,
        assertCurrent: () => fence.assertCurrent(context)
    });
    fence.assertCurrent(context);
    const response: GroupSnapshot | GroupJoinCodeResponse = result;
    const snapshot = 'snapshot' in response ? response.snapshot : response;
    await input.acceptSnapshots({ context, clients: [], groups: [snapshot], scope });
    fence.assertCurrent(context);
    return result;
}

export async function updateRoom(
    input: UpdateRoomOperationInput
): Promise<GroupSnapshot> {
    const request = toUpdateRoomRequest(input.input);
    return await runRoomTargetMutation({
        ...input,
        room: input.input,
        options: input.input,
        execute: async ({ roomId, session, scope, policies }) =>
            await updateStateGroupDetails({
                groupId: roomId,
                request,
                principalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies
            })
    });
}

export async function archiveRoom(
    input: RoomLifecycleOperationInput
): Promise<GroupSnapshot> {
    return await changeRoomLifecycle({ ...input, status: 'archived' });
}

export async function deleteRoom(
    input: RoomLifecycleOperationInput
): Promise<GroupSnapshot> {
    return await changeRoomLifecycle({ ...input, status: 'deleted' });
}

export async function updateRoomMetadata(
    input: UpdateRoomMetadataOperationInput
): Promise<GroupSnapshot> {
    return await input.runAuthAwareOperation(() => updateAuthenticatedRoomMetadata(input));
}

async function updateAuthenticatedRoomMetadata(input: UpdateRoomMetadataOperationInput): Promise<GroupSnapshot> {
    const operationOptions = input.resolveOperationOptions(input.options);
    const context = await input.connect(operationOptions);
    const session = input.requireSession();
    const roomRef = typeof input.room === 'string'
        ? (toGroupRefFromScope(input.room, input.resolveOperationScope()) ??
            input.stateStore.findGroupSnapshot(input.room)?.group)
        : input.room;
    const roomId = typeof input.room === 'string' ? input.room : input.room.groupId;
    const scope = input.options.scope ?? (roomRef ? toStateScope(roomRef) : input.resolveOperationScope());
    if (!roomId) {
        throw new Error('Cannot update room metadata: room is required.');
    }
    const snapshot = await updateStateGroupMetadata({
        groupId: roomId,
        patch: input.patch,
        principalId: session.clientId,
        sessionId: session.sessionId,
        scope,
        policies: toRallarWorkflowPolicies(operationOptions)
    });
    await input.acceptSnapshots({ context, clients: [], groups: [snapshot], scope });
    return snapshot;
}

async function changeRoomLifecycle(
    input: ChangeRoomLifecycleInput
): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    const request = options.reason === undefined ? {} : { reason: options.reason };
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies }) =>
            input.status === 'archived'
                ? await archiveStateGroup({
                    groupId: roomId,
                    request,
                    principalId: session.clientId,
                    sessionId: session.sessionId,
                    scope,
                    policies
                })
                : await deleteStateGroup({
                    groupId: roomId,
                    request,
                    principalId: session.clientId,
                    sessionId: session.sessionId,
                    scope,
                    policies
                })
    });
}

function toUpdateRoomRequest(input: RallarUpdateRoomInput): UpdateStateGroupBody {
    return {
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.joinMode === undefined ? {} : { joinMode: input.joinMode }),
        ...(input.directoryListing === undefined ? {} : { directoryListing: input.directoryListing }),
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
}
