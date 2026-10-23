import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupDirectoryPage, GroupDirectoryRequest } from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';
import { defaultStateScope, toStateGroupHttpPath, toStateScopeHttpPath } from '../api/state-http-path.ts';
import { readStateGroupSnapshot } from './point-read.ts';

export async function listStateClients(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<ClientSnapshot[]> {
    return await executeHttpRequest<void, ClientSnapshot[]>(
        readApiBaseUrl(),
        `${toStateScopeHttpPath(scope)}/clients`,
        'GET',
        undefined,
        options
    );
}

export async function listStateGroups(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupSnapshot[]> {
    return await executeHttpRequest<void, GroupSnapshot[]>(
        readApiBaseUrl(),
        `${toStateScopeHttpPath(scope)}/groups`,
        'GET',
        undefined,
        options
    );
}

export async function listStateGroupDirectory(
    scope: StateScope = defaultStateScope(),
    request: GroupDirectoryRequest = {},
    options?: ApiRequestOptions
): Promise<GroupDirectoryPage> {
    return await executeHttpRequest<void, GroupDirectoryPage>(
        readApiBaseUrl(),
        `${toStateScopeHttpPath(scope)}/group-directory${toGroupDirectoryQueryString(request)}`,
        'GET',
        undefined,
        options
    );
}

function toGroupDirectoryQueryString(request: GroupDirectoryRequest): string {
    const query = new URLSearchParams();
    if (request.kind !== undefined) {
        query.set('kind', request.kind);
    }
    if (request.q !== undefined) {
        query.set('q', request.q);
    }
    if (request.limit !== undefined) {
        query.set('limit', String(request.limit));
    }
    if (request.cursor !== undefined) {
        query.set('cursor', request.cursor);
    }
    if (request.includeEmpty !== undefined) {
        query.set('includeEmpty', String(request.includeEmpty));
    }
    if (request.order !== undefined) {
        query.set('order', request.order);
    }
    const serialized = query.toString();
    return serialized.length > 0 ? `?${serialized}` : '';
}

export async function findStateGroup(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupSnapshot> {
    return (await readStateGroupSnapshot(groupId, scope, options)).snapshot;
}

export async function readStateGroupFormationView(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupFormationView> {
    return await executeHttpRequest<void, GroupFormationView>(
        readApiBaseUrl(),
        `${toStateGroupHttpPath(scope, groupId)}/formation`,
        'GET',
        undefined,
        options
    );
}
