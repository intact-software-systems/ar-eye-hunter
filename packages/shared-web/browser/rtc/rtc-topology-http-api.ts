import type {
    GraphDiagnosticReadOptions,
    GraphDiagnosticReadResponse,
    GroupTopologyConfigMutationReceipt,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    QueuedGroupTopologyReconfigureResponse,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import {
    sendApiHttpRequest,
    type ApiMutationRequestOptions,
    type ApiRequestOptions
} from '../api/send-api-http-request.ts';
import { defaultStateScope, toStateGroupHttpPath, toStateScopeHttpPath } from '../api/state-http-path.ts';
import type {
    PutStateGroupTopologyConfigBody,
    PutStateGroupTopologyOverrideBody,
    ReconfigureStateGroupTopologyBody
} from '../api/state-mutation-http-contracts.ts';

export type StateGraphDiagnosticReadOptions = ApiRequestOptions & GraphDiagnosticReadOptions;

export interface PutStateGroupTopologyConfigResponse {
    readonly config: StoredGroupTopologyConfig;
    readonly receipt: GroupTopologyConfigMutationReceipt;
}

export interface PutStateGroupTopologyOverrideResponse {
    readonly override: StoredGroupTopologyOverride;
    readonly receipt: GroupTopologyConfigMutationReceipt;
}

export interface DeleteStateGroupTopologyConfigResponse {
    readonly deleted: boolean;
    readonly receipt: GroupTopologyConfigMutationReceipt;
}

export interface PutStateGroupTopologyConfigInput {
    readonly groupId: string;
    readonly request: PutStateGroupTopologyConfigBody;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

export interface DeleteStateGroupTopologyConfigInput {
    readonly groupId: string;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

export interface PutStateGroupTopologyOverrideInput {
    readonly groupId: string;
    readonly request: PutStateGroupTopologyOverrideBody;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

export interface DeleteStateGroupTopologyOverrideInput {
    readonly groupId: string;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

export interface ReconfigureStateGroupTopologyInput {
    readonly groupId: string;
    readonly request: ReconfigureStateGroupTopologyBody;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

interface TopologyMutationInput<TRequest> {
    readonly path: string;
    readonly method: 'DELETE' | 'POST' | 'PUT';
    readonly request: TRequest;
    readonly options: ApiMutationRequestOptions;
}

export async function readStateScopedGlobalGraph(
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions
): Promise<GraphDiagnosticReadResponse> {
    return await sendApiHttpRequest<void, GraphDiagnosticReadResponse>({
        baseUrl: readApiBaseUrl(),
        path: graphDiagnosticPath(`${toStateScopeHttpPath(scope)}/graphs/global`, options),
        method: 'GET',
        body: undefined,
        options
    });
}

export async function readStateGroupGraph(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions
): Promise<GraphDiagnosticReadResponse> {
    return await sendApiHttpRequest<void, GraphDiagnosticReadResponse>({
        baseUrl: readApiBaseUrl(),
        path: graphDiagnosticPath(`${toStateGroupHttpPath(scope, groupId)}/graphs/latest`, options),
        method: 'GET',
        body: undefined,
        options
    });
}

export async function readStateGroupTopology(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupTopologyManagementView> {
    return await sendApiHttpRequest<void, GroupTopologyManagementView>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateGroupHttpPath(scope, groupId)}/topology`,
        method: 'GET',
        body: undefined,
        options
    });
}

export async function readStateGroupTopologyConfig(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupTopologyConfigView> {
    return await sendApiHttpRequest<void, GroupTopologyConfigView>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateGroupHttpPath(scope, groupId)}/topology/config`,
        method: 'GET',
        body: undefined,
        options
    });
}

export async function putStateGroupTopologyConfig(
    input: PutStateGroupTopologyConfigInput
): Promise<PutStateGroupTopologyConfigResponse> {
    const scope = input.scope ?? defaultStateScope();
    return await sendTopologyMutation({
        path: `${toStateGroupHttpPath(scope, input.groupId)}/topology/config`,
        method: 'PUT',
        request: input.request,
        options: input.options
    });
}

export async function deleteStateGroupTopologyConfig(
    input: DeleteStateGroupTopologyConfigInput
): Promise<DeleteStateGroupTopologyConfigResponse> {
    const scope = input.scope ?? defaultStateScope();
    return await sendTopologyMutation({
        path: `${toStateGroupHttpPath(scope, input.groupId)}/topology/config`,
        method: 'DELETE',
        request: {},
        options: input.options
    });
}

export async function readStateGroupTopologyOverride(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<StoredGroupTopologyOverride | Record<string, never>> {
    return await sendApiHttpRequest<void, StoredGroupTopologyOverride | Record<string, never>>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateGroupHttpPath(scope, groupId)}/topology/override`,
        method: 'GET',
        body: undefined,
        options
    });
}

export async function putStateGroupTopologyOverride(
    input: PutStateGroupTopologyOverrideInput
): Promise<PutStateGroupTopologyOverrideResponse> {
    const scope = input.scope ?? defaultStateScope();
    return await sendTopologyMutation({
        path: `${toStateGroupHttpPath(scope, input.groupId)}/topology/override`,
        method: 'PUT',
        request: input.request,
        options: input.options
    });
}

export async function deleteStateGroupTopologyOverride(
    input: DeleteStateGroupTopologyOverrideInput
): Promise<DeleteStateGroupTopologyConfigResponse> {
    const scope = input.scope ?? defaultStateScope();
    return await sendTopologyMutation({
        path: `${toStateGroupHttpPath(scope, input.groupId)}/topology/override`,
        method: 'DELETE',
        request: {},
        options: input.options
    });
}

export async function reconfigureStateGroupTopology(
    input: ReconfigureStateGroupTopologyInput
): Promise<QueuedGroupTopologyReconfigureResponse> {
    const scope = input.scope ?? defaultStateScope();
    return await sendTopologyMutation({
        path: `${toStateGroupHttpPath(scope, input.groupId)}/topology/reconfigure`,
        method: 'POST',
        request: input.request,
        options: input.options
    });
}

async function sendTopologyMutation<TRequest, TResponse>(
    input: TopologyMutationInput<TRequest>
): Promise<TResponse> {
    return await sendApiHttpRequest<TRequest, TResponse>({
        baseUrl: readApiBaseUrl(),
        path: toApiMutationRequestPath(input.path, input.options.requestId),
        method: input.method,
        body: input.request,
        options: input.options
    });
}

function graphDiagnosticPath(path: string, options?: StateGraphDiagnosticReadOptions): string {
    const query = new URLSearchParams();
    if (options?.includeMeasured !== undefined) {
        query.set('includeMeasured', String(options.includeMeasured));
    }
    if (options?.refresh !== undefined) {
        query.set('refresh', options.refresh);
    }
    return query.size === 0 ? path : `${path}?${query}`;
}
