import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import type {
    AdminRoomDirectoryRequest,
    AdminRoomDirectoryResponse
} from '@shared/api/admin-rooms/admin-room-directory.ts';
import type {
    AdminRoomTopologyWorkRequest,
    AdminRoomTopologyWorkResponse
} from '@shared/api/admin-rooms/admin-room-topology-work.ts';
import {
    decodeAdminPruneEnqueueResult,
    type AdminPruneEnqueueResult
} from '@shared/api/admin-rooms/decode-admin-prune-result.ts';
import { decodeAdminRoomDirectory } from '@shared/api/admin-rooms/decode-admin-room-directory.ts';
import { decodeAdminRoomTopologyWork } from '@shared/api/admin-rooms/decode-admin-room-topology-work.ts';
import {
    decodeTopologyReconfigureInboxResult,
    type TopologyReconfigureInboxResult
} from '@shared/api/admin-rooms/decode-topology-inbox-result.ts';
import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';
import { decodeAdminGroupNarrative } from '@shared/api/admin-support/decode-admin-group-narrative.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupRef, type GroupRef } from '@shared/api/group-types.ts';

import { normalizeApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';

export interface AdminRoomHttpContext {
    readonly apiBaseUrl: string;
    readonly session: AuthSession | null;
    readonly signal: AbortSignal;
}

export interface AdminRoomDirectoryHttpInput extends AdminRoomDirectoryRequest, AdminRoomHttpContext {}

export interface AdminRoomTopologyWorkHttpInput extends AdminRoomTopologyWorkRequest, AdminRoomHttpContext {}

export interface AdminRoomExplanationHttpInput extends AdminRoomHttpContext {
    readonly roomRef: GroupRef;
}

export async function readAdminRoomDirectory(input: AdminRoomDirectoryHttpInput): Promise<AdminRoomDirectoryResponse> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.afterGroupId !== null) {
        query.set('afterGroupId', input.afterGroupId);
    }
    const response = await sendApiHttpRequest({
        baseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
        path: `/api/admin/operations/rooms/apps/${encodeURIComponent(input.scope.applicationId)}/workspaces/${
            encodeURIComponent(input.scope.workspaceId)
        }?${query}`,
        method: 'GET',
        body: undefined,
        options: { authSession: input.session, signal: input.signal }
    });
    return decodeAdminRoomDirectory(response, input);
}

export async function readAdminRoomExplanation(
    input: AdminRoomExplanationHttpInput
): Promise<AdminSupportNarrativeResponse> {
    const response = await sendApiHttpRequest({
        baseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
        path: '/api/admin/support/explain/group',
        method: 'POST',
        body: { groupRef: toCanonicalGroupRef(input.roomRef), limitRecentEvents: 20 },
        options: { authSession: input.session, signal: input.signal }
    });
    return decodeAdminGroupNarrative(response, input.roomRef);
}

export async function readAdminRoomTopologyWork(
    input: AdminRoomTopologyWorkHttpInput
): Promise<AdminRoomTopologyWorkResponse> {
    const room = input.roomRef;
    const response = await sendApiHttpRequest({
        baseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
        path: `/api/admin/operations/rooms/apps/${encodeURIComponent(room.applicationId)}/workspaces/${
            encodeURIComponent(room.workspaceId)
        }/groups/${encodeURIComponent(room.groupId)}/topology-work/${encodeURIComponent(input.outboxId)}`,
        method: 'GET',
        body: undefined,
        options: { authSession: input.session, signal: input.signal }
    });
    return decodeAdminRoomTopologyWork(response, input);
}

export interface AdminRoomRecomputeHttpInput extends AdminRoomExplanationHttpInput {
    readonly requestId: string;
}

export interface AdminPruneHttpInput extends AdminRoomHttpContext {
    readonly requestId: string;
    readonly categories: readonly Exclude<AdminPruneExpiredCategory, 'app-data'>[];
    readonly dryRun: boolean;
}

export async function recomputeAdminRoomTopology(
    input: AdminRoomRecomputeHttpInput
): Promise<TopologyReconfigureInboxResult> {
    const response = await sendApiHttpRequest({
        baseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
        path: `/api/admin/operations/topology/recompute/requests/${encodeURIComponent(input.requestId)}`,
        method: 'POST',
        body: { groupRef: toCanonicalGroupRef(input.roomRef), publish: true },
        options: { authSession: input.session, signal: input.signal }
    });
    const result = decodeTopologyReconfigureInboxResult(response);
    if (!isSameGroupRef(result.groupRef, input.roomRef) || result.requestId !== input.requestId) {
        throw new TypeError('Topology receipt belongs to another room or command');
    }
    return result;
}

export async function pruneAdminExpiredRecords(input: AdminPruneHttpInput): Promise<AdminPruneEnqueueResult> {
    const response = await sendApiHttpRequest({
        baseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
        path: `/api/admin/operations/maintenance/prune-expired/requests/${encodeURIComponent(input.requestId)}`,
        method: 'POST',
        body: { categories: input.categories, dryRun: input.dryRun },
        options: { authSession: input.session, signal: input.signal }
    });
    const result = decodeAdminPruneEnqueueResult(response);
    if (
        result.status !== (input.dryRun ? 'dry-run' : 'completed') ||
        result.results.length !== input.categories.length ||
        result.results.some((entry, index) => entry.category !== input.categories[index])
    ) {
        throw new TypeError('Result differs from the explicit maintenance intent');
    }
    return result;
}
