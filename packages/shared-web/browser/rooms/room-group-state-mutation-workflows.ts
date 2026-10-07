import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import {
    toRoomLifecycleGroupStateRequest,
    toRoomMetadataGroupStateRequest,
    toUpdateGroupStateRequest,
    type GroupSnapshot,
    type StateScope,
    type UpdateStateGroupBody
} from './room-group-state-translation.ts';

interface UpdateStateGroupLifecycleInput extends RoomLifecycleWorkflowInput {
    readonly status: 'archived' | 'deleted';
}

export interface RoomLifecycleWorkflowInput {
    readonly groupId: string;
    readonly request: Omit<UpdateStateGroupBody, 'status'>;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<GroupSnapshot>;
}

export interface UpdateStateGroupMetadataInput {
    readonly groupId: string;
    readonly patch: ApiJsonObject;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<GroupSnapshot>;
}

/** A metadata patch written over the metadata of a room read just before. */
export interface WriteStateGroupMetadataInput extends UpdateStateGroupMetadataInput {
    readonly current: GroupSnapshot;
}

export interface UpdateStateGroupDetailsInput {
    readonly groupId: string;
    readonly request: UpdateStateGroupBody;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<GroupSnapshot>;
}

export async function updateStateGroupMetadata(
    input: UpdateStateGroupMetadataInput
): Promise<GroupSnapshot> {
    const current = await readCurrentStateGroup(input);
    return await writeStateGroupMetadata({ ...input, current });
}

/** The room as the server holds it now, which a metadata write builds on. */
export async function readCurrentStateGroup(
    input: Pick<UpdateStateGroupMetadataInput, 'groupId' | 'scope' | 'policies'>
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    return await new Command<GroupSnapshot>(
        (signal) => findStateGroup(input.groupId, scope, { signal }),
        input.policies?.command ?? {}
    ).run();
}

/** Writes the patch over the current metadata; a `null` patch value removes its key. */
export async function writeStateGroupMetadata(input: WriteStateGroupMetadataInput): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions: CommandOptions<GroupSnapshot> = input.policies?.command ?? {};
    const request = toRoomMetadataGroupStateRequest({
        currentMetadata: input.current.group.metadata,
        patch: input.patch,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });

    return await new Command<GroupSnapshot>(
        (signal) =>
            roomGroupStateHttpApi.updateGroup({
                groupId: input.groupId,
                request,
                options: { requestId, signal },
                scope
            }),
        commandOptions
    ).run();
}

export async function updateStateGroupDetails(
    input: UpdateStateGroupDetailsInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions: CommandOptions<GroupSnapshot> = input.policies?.command ?? {};
    const updateRequest = toUpdateGroupStateRequest({
        request: input.request,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });

    return await new Command<GroupSnapshot>(
        (signal) =>
            roomGroupStateHttpApi.updateGroup({
                groupId: input.groupId,
                request: updateRequest,
                options: { requestId, signal },
                scope
            }),
        commandOptions
    ).run();
}

export async function archiveStateGroup(
    input: RoomLifecycleWorkflowInput
): Promise<GroupSnapshot> {
    return await updateStateGroupLifecycle({
        ...input,
        status: 'archived'
    });
}

export async function deleteStateGroup(
    input: RoomLifecycleWorkflowInput
): Promise<GroupSnapshot> {
    return await updateStateGroupLifecycle({
        ...input,
        status: 'deleted'
    });
}

async function updateStateGroupLifecycle(
    input: UpdateStateGroupLifecycleInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions: CommandOptions<GroupSnapshot> = input.policies?.command ?? {};
    const lifecycleRequest = toRoomLifecycleGroupStateRequest({
        request: input.request,
        status: input.status,
        actorPrincipalId: input.principalId,
        actorSessionId: input.sessionId
    });

    return await new Command<GroupSnapshot>(
        (signal) =>
            roomGroupStateHttpApi.updateGroup({
                groupId: input.groupId,
                request: lifecycleRequest,
                options: { requestId, signal },
                scope
            }),
        commandOptions
    ).run();
}
