import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest, type ApiRequestOptions } from '../api/send-api-http-request.ts';
import { defaultStateScope, toStateGroupHttpPath, toStateScopeHttpPath } from '../api/state-http-path.ts';

export async function readStateWorkspaceStatsSummary(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<WorkspaceSpaStatisticsResponse> {
    return await sendApiHttpRequest<void, WorkspaceSpaStatisticsResponse>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateScopeHttpPath(scope)}/stats/summary`,
        method: 'GET',
        body: undefined,
        options
    });
}

export async function readStateGroupStats(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupSpaStatisticsResponse> {
    return await sendApiHttpRequest<void, GroupSpaStatisticsResponse>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateGroupHttpPath(scope, groupId)}/stats`,
        method: 'GET',
        body: undefined,
        options
    });
}

export async function readStateMyRealtimeStatus(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<MyRealtimeSpaStatisticsResponse> {
    return await sendApiHttpRequest<void, MyRealtimeSpaStatisticsResponse>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateScopeHttpPath(scope)}/stats/me/realtime`,
        method: 'GET',
        body: undefined,
        options
    });
}
