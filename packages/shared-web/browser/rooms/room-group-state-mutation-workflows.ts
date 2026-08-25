import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-workflow-support.ts';
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
import type { StateGroupWorkflowValue } from './room-group-state-workflows.ts';

interface UpdateStateGroupLifecycleInput extends RoomLifecycleWorkflowInput {
    readonly status: 'archived' | 'deleted';
}

export interface RoomLifecycleWorkflowInput {
    readonly groupId: string;
    readonly request: Omit<UpdateStateGroupBody, 'status'>;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export interface UpdateStateGroupMetadataInput {
    readonly groupId: string;
    readonly patch: Readonly<Record<string, unknown>>;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export interface UpdateStateGroupDetailsInput {
    readonly groupId: string;
    readonly request: UpdateStateGroupBody;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly policies?: CommandsOrchestratorPolicies<StateGroupWorkflowValue>;
}

export async function updateStateGroupMetadata(
    input: UpdateStateGroupMetadataInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const requestId = toApiMutationWorkflowRequestId();
    const commandOptions = (input.policies?.command ?? {}) as CommandOptions<GroupSnapshot>;
    const current = await new Command<GroupSnapshot>(
        (signal) => findStateGroup(input.groupId, scope, { signal }),
        commandOptions
    ).run();
    const request = toRoomMetadataGroupStateRequest({
        currentMetadata: current.group.metadata,
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
    const commandOptions = (input.policies?.command ?? {}) as CommandOptions<GroupSnapshot>;
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
    const commandOptions = (input.policies?.command ?? {}) as CommandOptions<GroupSnapshot>;
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
