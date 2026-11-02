import type {
    AdminRoomDirectoryRequest,
    AdminRoomDirectoryResponse
} from '@shared/api/admin-rooms/admin-room-directory.ts';
import { decodeAdminRoomDirectory } from '@shared/api/admin-rooms/decode-admin-room-directory.ts';
import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';
import { decodeAdminGroupNarrative } from '@shared/api/admin-support/decode-admin-group-narrative.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toCanonicalGroupRef, type GroupRef } from '@shared/api/group-types.ts';

import { normalizeApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';

export interface AdminRoomHttpContext {
    readonly apiBaseUrl: string;
    readonly session: AuthSession | null;
    readonly signal: AbortSignal;
}

export interface AdminRoomDirectoryHttpInput extends AdminRoomDirectoryRequest, AdminRoomHttpContext {}

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
