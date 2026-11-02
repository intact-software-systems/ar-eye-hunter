import type {
    AdminRoomDirectoryRequest,
    AdminRoomDirectoryResponse
} from '@shared/api/admin-rooms/admin-room-directory.ts';
import { decodeAdminRoomDirectory } from '@shared/api/admin-rooms/decode-admin-room-directory.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { normalizeApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';

export interface AdminRoomDirectoryHttpInput extends AdminRoomDirectoryRequest {
    readonly apiBaseUrl: string;
    readonly session: AuthSession | null;
    readonly signal: AbortSignal;
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
