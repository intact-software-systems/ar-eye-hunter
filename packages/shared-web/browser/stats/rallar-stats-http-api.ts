import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';
import { defaultStateScope, toStateGroupHttpPath, toStateScopeHttpPath } from '../api/state-http-path.ts';

export async function readStateWorkspaceStatsSummary(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<WorkspaceSpaStatisticsResponse> {
    return await executeHttpRequest<void, WorkspaceSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopeHttpPath(scope)}/stats/summary`,
        'GET',
        undefined,
        options
    );
}

export async function readStateGroupStats(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupSpaStatisticsResponse> {
    return await executeHttpRequest<void, GroupSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateGroupHttpPath(scope, groupId)}/stats`,
        'GET',
        undefined,
        options
    );
}

export async function readStateMyRealtimeStatus(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<MyRealtimeSpaStatisticsResponse> {
    return await executeHttpRequest<void, MyRealtimeSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopeHttpPath(scope)}/stats/me/realtime`,
        'GET',
        undefined,
        options
    );
}
