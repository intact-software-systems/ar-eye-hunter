import { ApiConfig, IceConfig } from '@shared/api/api-config.ts';
import {
    validateAuthoritativeClientEventList,
    validateAuthoritativeClientEventPage,
    validateAuthoritativeGroupEventList,
    validateAuthoritativeGroupEventPage
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent, ClientEventType, ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
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
import type { GroupEvent, GroupEventType, GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type GroupJoinCodeResponse,
    type StateScope
} from '@shared/api/state-types.ts';
import type { RallarCrdtCatchUpRequestEnvelope, RallarCrdtCatchUpResponseEnvelope } from '@shared/crdt/mod.ts';
import { readApiBaseUrl } from './api-client-config.ts';
import { executeHttpRequest, type ApiMutationRequestOptions, type ApiRequestOptions } from './api/http-request.ts';
import type {
    AcceptStateGroupInviteBody,
    AppointStateGroupDirectorBody,
    BanStateGroupMemberBody,
    ConnectStateClientSessionBody,
    ConnectStateGroupPresenceSessionBody,
    CreateStateGroupBody,
    CreateStateGroupInviteBody,
    DisconnectStateGroupPresenceSessionBody,
    HeartbeatStateClientSessionBody,
    HeartbeatStateGroupPresenceSessionBody,
    JoinStateGroupBody,
    PutStateGroupTopologyConfigBody,
    PutStateGroupTopologyOverrideBody,
    ReconfigureStateGroupTopologyBody,
    RemoveStateGroupMemberBody,
    RevokeStateGroupInviteBody,
    RotateStateGroupJoinCodeBody,
    SetStateGroupMemberRoleBody,
    TransferStateGroupOwnershipBody,
    UnbanStateGroupMemberBody,
    UpdateStateGroupBody,
    UpsertStateGroupMemberBody
} from './api/state-mutation-http-contracts.ts';
import { readStateGroupSnapshot } from './state-read/point-read.ts';
export { readStateClientSnapshot, readStateGroupSnapshot } from './state-read/point-read.ts';
export type {
    ReadStateClientSnapshotOptions,
    ReadStateGroupSnapshotOptions,
    StateClientSnapshotRead,
    StateGroupSnapshotRead
} from './state-read/point-read.ts';

export type StateEventListRequestOptions<TEventType extends string> =
    & ApiRequestOptions
    & Readonly<{
        eventTypes?: readonly TEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>;

export type StateGraphDiagnosticReadOptions = ApiRequestOptions & GraphDiagnosticReadOptions;

export type PutStateGroupTopologyConfigResponse = Readonly<{
    config: StoredGroupTopologyConfig;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type PutStateGroupTopologyOverrideResponse = Readonly<{
    override: StoredGroupTopologyOverride;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type DeleteStateGroupTopologyConfigResponse = Readonly<{
    deleted: boolean;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type GroupStateEventListRequestOptions = StateEventListRequestOptions<GroupEventType>;

export type ClientStateEventListRequestOptions = StateEventListRequestOptions<ClientEventType>;

export async function readApiConfig(options?: ApiRequestOptions): Promise<ApiConfig> {
    return await executeHttpRequest<void, ApiConfig>(
        readApiBaseUrl(),
        '/api/config',
        'GET',
        undefined,
        options
    );
}

export async function readIceCandidates(options?: ApiRequestOptions): Promise<IceConfig> {
    return await executeHttpRequest<void, IceConfig>(
        readApiBaseUrl(),
        '/api/webrtc/ice',
        'GET',
        undefined,
        options
    );
}

export async function catchUpRallarCrdtDocument(
    request: RallarCrdtCatchUpRequestEnvelope,
    options?: ApiRequestOptions
): Promise<RallarCrdtCatchUpResponseEnvelope> {
    const response = await executeHttpRequest<
        RallarCrdtCatchUpRequestEnvelope,
        ApiResultEnvelope<RallarCrdtCatchUpResponseEnvelope>
    >(readApiBaseUrl(), '/api/crdt/catch-up', 'POST', request, options);

    if (!response.ok) {
        throw new Error(response.error);
    }

    return response.result;
}

export function defaultStateScope(): StateScope {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID
    };
}

type ApiResultEnvelope<T> =
    | Readonly<{
        ok: true;
        result: T;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

export async function listStateClients(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<ClientStateSnapshot[]> {
    return await executeHttpRequest<void, ClientStateSnapshot[]>(
        readApiBaseUrl(),
        toStateScopePath(scope) + '/clients',
        'GET',
        undefined,
        options
    );
}

export async function listStateGroups(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupStateSnapshot[]> {
    return await executeHttpRequest<void, GroupStateSnapshot[]>(
        readApiBaseUrl(),
        toStateScopePath(scope) + '/groups',
        'GET',
        undefined,
        options
    );
}

export async function findStateGroup(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupStateSnapshot> {
    return (await readStateGroupSnapshot(groupId, scope, options)).snapshot;
}

export async function listStateGroupEvents(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions
): Promise<GroupEvent[]> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/events`,
            options
        ),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeGroupEventList(response, { ...scope, groupId });
    return response;
}

export async function listStateGroupEventPage(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions
): Promise<StateEventPage<GroupEvent>> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/events/page`,
            options
        ),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeGroupEventPage(response, { ...scope, groupId });
    return response;
}

export async function listStateClientEvents(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions
): Promise<ClientEvent[]> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/events`,
            options
        ),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeClientEventList(response, { ...scope, principalId });
    return response;
}

export async function listStateClientEventPage(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions
): Promise<StateEventPage<ClientEvent>> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/events/page`,
            options
        ),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeClientEventPage(response, { ...scope, principalId });
    return response;
}

export async function readStateScopedGlobalGraph(
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions
): Promise<GraphDiagnosticReadResponse> {
    return await executeHttpRequest<void, GraphDiagnosticReadResponse>(
        readApiBaseUrl(),
        withGraphDiagnosticQuery(`${toStateScopePath(scope)}/graphs/global`, options),
        'GET',
        undefined,
        options
    );
}

export async function readStateGroupGraph(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions
): Promise<GraphDiagnosticReadResponse> {
    return await executeHttpRequest<void, GraphDiagnosticReadResponse>(
        readApiBaseUrl(),
        withGraphDiagnosticQuery(`${toStateGroupPath(scope, groupId)}/graphs/latest`, options),
        'GET',
        undefined,
        options
    );
}

export async function readStateGroupTopology(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupTopologyManagementView> {
    return await executeHttpRequest<void, GroupTopologyManagementView>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology`,
        'GET',
        undefined,
        options
    );
}

export async function readStateWorkspaceStatsSummary(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<WorkspaceSpaStatisticsResponse> {
    return await executeHttpRequest<void, WorkspaceSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/stats/summary`,
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
        `${toStateGroupPath(scope, groupId)}/stats`,
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
        `${toStateScopePath(scope)}/stats/me/realtime`,
        'GET',
        undefined,
        options
    );
}

export async function readStateGroupTopologyConfig(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupTopologyConfigView> {
    return await executeHttpRequest<void, GroupTopologyConfigView>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        'GET',
        undefined,
        options
    );
}

export async function putStateGroupTopologyConfig(
    groupId: string,
    request: PutStateGroupTopologyConfigBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<PutStateGroupTopologyConfigResponse> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        options.requestId
    );
    return await executeHttpRequest<PutStateGroupTopologyConfigBody, PutStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function deleteStateGroupTopologyConfig(
    groupId: string,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<DeleteStateGroupTopologyConfigResponse> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        options.requestId
    );
    return await executeHttpRequest<Record<string, never>, DeleteStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        path,
        'DELETE',
        {},
        options
    );
}

export async function readStateGroupTopologyOverride(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<StoredGroupTopologyOverride | Record<string, never>> {
    return await executeHttpRequest<void, StoredGroupTopologyOverride | Record<string, never>>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        'GET',
        undefined,
        options
    );
}

export async function putStateGroupTopologyOverride(
    groupId: string,
    request: PutStateGroupTopologyOverrideBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<PutStateGroupTopologyOverrideResponse> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        options.requestId
    );
    return await executeHttpRequest<PutStateGroupTopologyOverrideBody, PutStateGroupTopologyOverrideResponse>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function deleteStateGroupTopologyOverride(
    groupId: string,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<DeleteStateGroupTopologyConfigResponse> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        options.requestId
    );
    return await executeHttpRequest<Record<string, never>, DeleteStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        path,
        'DELETE',
        {},
        options
    );
}

export async function reconfigureStateGroupTopology(
    groupId: string,
    request: ReconfigureStateGroupTopologyBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<QueuedGroupTopologyReconfigureResponse> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/topology/reconfigure`,
        options.requestId
    );
    return await executeHttpRequest<ReconfigureStateGroupTopologyBody, QueuedGroupTopologyReconfigureResponse>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function createStateGroup(
    request: CreateStateGroupBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(`${toStateScopePath(scope)}/groups`, options.requestId);
    return await executeHttpRequest<CreateStateGroupBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function updateStateGroup(
    groupId: string,
    request: UpdateStateGroupBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(toStateGroupPath(scope, groupId), options.requestId);
    return await executeHttpRequest<UpdateStateGroupBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function appointStateGroupDirector(
    groupId: string,
    request: AppointStateGroupDirectorBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/director/appoint`,
        options.requestId
    );
    return await executeHttpRequest<AppointStateGroupDirectorBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function joinStateGroup(
    groupId: string,
    request: JoinStateGroupBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/join`,
        options.requestId
    );
    return await executeHttpRequest<JoinStateGroupBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function createStateGroupInvite(
    groupId: string,
    principalId: string,
    request: CreateStateGroupInviteBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/invites/${encodeURIComponent(principalId)}`,
        options.requestId
    );
    return await executeHttpRequest<CreateStateGroupInviteBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function revokeStateGroupInvite(
    groupId: string,
    principalId: string,
    request: RevokeStateGroupInviteBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/invites/${encodeURIComponent(principalId)}/revoke`,
        options.requestId
    );
    return await executeHttpRequest<RevokeStateGroupInviteBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function acceptStateGroupInvite(
    groupId: string,
    request: AcceptStateGroupInviteBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/invites/accept`,
        options.requestId
    );
    return await executeHttpRequest<AcceptStateGroupInviteBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function rotateStateGroupJoinCode(
    groupId: string,
    request: RotateStateGroupJoinCodeBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupJoinCodeResponse> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/join-code/rotate`,
        options.requestId
    );
    return await executeHttpRequest<RotateStateGroupJoinCodeBody, GroupJoinCodeResponse>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function removeStateGroupMember(
    groupId: string,
    principalId: string,
    request: RemoveStateGroupMemberBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/remove`,
        options.requestId
    );
    return await executeHttpRequest<RemoveStateGroupMemberBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function banStateGroupMember(
    groupId: string,
    principalId: string,
    request: BanStateGroupMemberBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/ban`,
        options.requestId
    );
    return await executeHttpRequest<BanStateGroupMemberBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function unbanStateGroupMember(
    groupId: string,
    principalId: string,
    request: UnbanStateGroupMemberBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/unban`,
        options.requestId
    );
    return await executeHttpRequest<UnbanStateGroupMemberBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function setStateGroupMemberRole(
    groupId: string,
    principalId: string,
    request: SetStateGroupMemberRoleBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/role`,
        options.requestId
    );
    return await executeHttpRequest<SetStateGroupMemberRoleBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function transferStateGroupOwnership(
    groupId: string,
    request: TransferStateGroupOwnershipBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/owner/transfer`,
        options.requestId
    );
    return await executeHttpRequest<TransferStateGroupOwnershipBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function upsertStateGroupMember(
    groupId: string,
    principalId: string,
    request: UpsertStateGroupMemberBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}`,
        options.requestId
    );
    return await executeHttpRequest<UpsertStateGroupMemberBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function connectStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: ConnectStateGroupPresenceSessionBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/sessions/${encodeURIComponent(sessionId)}`,
        options.requestId
    );
    return await executeHttpRequest<ConnectStateGroupPresenceSessionBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function connectStateClientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectStateClientSessionBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<ClientStateSnapshot> {
    const clientPath = `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}`;
    const instancePath = `${clientPath}/instances/${encodeURIComponent(clientInstanceId)}`;
    const path = toApiMutationRequestPath(
        `${instancePath}/sessions/${encodeURIComponent(sessionId)}`,
        options.requestId
    );
    return await executeHttpRequest<ConnectStateClientSessionBody, ClientStateSnapshot>(
        readApiBaseUrl(),
        path,
        'PUT',
        request,
        options
    );
}

export async function heartbeatStateClientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatStateClientSessionBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<ClientStateSnapshot> {
    const clientPath = `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}`;
    const instancePath = `${clientPath}/instances/${encodeURIComponent(clientInstanceId)}`;
    const path = toApiMutationRequestPath(
        `${instancePath}/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        options.requestId
    );
    return await executeHttpRequest<HeartbeatStateClientSessionBody, ClientStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function heartbeatStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: HeartbeatStateGroupPresenceSessionBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        options.requestId
    );
    return await executeHttpRequest<HeartbeatStateGroupPresenceSessionBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

export async function disconnectStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: DisconnectStateGroupPresenceSessionBody,
    options: ApiMutationRequestOptions,
    scope: StateScope = defaultStateScope()
): Promise<GroupStateSnapshot> {
    const path = toApiMutationRequestPath(
        `${toStateGroupPath(scope, groupId)}/sessions/${encodeURIComponent(sessionId)}/disconnect`,
        options.requestId
    );
    return await executeHttpRequest<DisconnectStateGroupPresenceSessionBody, GroupStateSnapshot>(
        readApiBaseUrl(),
        path,
        'POST',
        request,
        options
    );
}

function toStateScopePath(scope: StateScope): string {
    const applicationId = encodeURIComponent(scope.applicationId);
    const workspaceId = encodeURIComponent(scope.workspaceId);
    return `/api/state/apps/${applicationId}/workspaces/${workspaceId}`;
}

function toStateGroupPath(scope: StateScope, groupId: string): string {
    return `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}`;
}

function withGraphDiagnosticQuery(path: string, options?: StateGraphDiagnosticReadOptions): string {
    const searchParams = new URLSearchParams();
    if (options?.includeMeasured !== undefined) {
        searchParams.set('includeMeasured', String(options.includeMeasured));
    }
    if (options?.refresh !== undefined) {
        searchParams.set('refresh', options.refresh);
    }

    return withSearchParams(path, searchParams);
}

function withStateEventListQuery<TEventType extends string>(
    path: string,
    options?: StateEventListRequestOptions<TEventType>
): string {
    const searchParams = new URLSearchParams();
    for (const eventType of options?.eventTypes ?? []) {
        searchParams.append('eventType', eventType);
    }
    if (options?.limit !== undefined) {
        searchParams.set('limit', String(options.limit));
    }
    if (options?.after) {
        searchParams.set('afterSnapshotVersion', String(options.after.snapshotVersion));
        searchParams.set('afterOccurredAtEpochMs', String(options.after.occurredAtEpochMs));
        searchParams.set('afterEventId', options.after.eventId);
    }

    return withSearchParams(path, searchParams);
}

function withSearchParams(path: string, searchParams: URLSearchParams): string {
    const query = searchParams.toString();
    return query ? `${path}?${query}` : path;
}
