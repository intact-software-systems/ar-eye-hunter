import { readApiBaseUrl } from './api-client-config.ts';
import { type ApiRequestOptions, executeHttpRequest } from './api/http-request.ts';
import { readStateGroupSnapshot } from './state-read/point-read.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation.ts';
import {
    validateAuthoritativeClientEventList,
    validateAuthoritativeClientEventPage,
    validateAuthoritativeGroupEventList,
    validateAuthoritativeGroupEventPage,
} from '@shared/api/authoritative-state-validation.ts';
import { ApiConfig, IceConfig } from '@shared/api/api-config.ts';
import type {
    ClientEvent,
    ClientEventType,
    ClientSnapshot as ClientStateSnapshot,
} from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupEventType,
    GroupSnapshot as GroupStateSnapshot,
} from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse,
} from '@shared/api/spa-statistics-types.ts';
import type {
    GraphDiagnosticReadOptions,
    GraphDiagnosticReadResponse,
    GroupTopologyConfigMutationReceipt,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
    QueuedGroupTopologyReconfigureResponse,
    ReconfigureGroupTopologyRequest,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import {
    type AcceptGroupInviteRequest,
    type AppointGroupDirectorRequest,
    type BanGroupMemberRequest,
    type ConnectClientSessionRequest,
    type ConnectGroupPresenceSessionRequest,
    type CreateGroupInviteRequest,
    type CreateGroupRequest,
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type DisconnectGroupPresenceSessionRequest,
    type GroupJoinCodeResponse,
    type HeartbeatClientSessionRequest,
    type HeartbeatGroupPresenceSessionRequest,
    type JoinGroupRequest,
    type RemoveGroupMemberRequest,
    type RevokeGroupInviteRequest,
    type RotateGroupJoinCodeRequest,
    type SetGroupMemberRoleRequest,
    type StateScope,
    type TransferGroupOwnershipRequest,
    type UnbanGroupMemberRequest,
    type UpdateGroupRequest,
    type UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';
import type {
    RallarCrdtCatchUpRequestEnvelope,
    RallarCrdtCatchUpResponseEnvelope,
} from '@shared/crdt/mod.ts';
export { readStateClientSnapshot, readStateGroupSnapshot } from './state-read/point-read.ts';
export type {
    ReadStateClientSnapshotOptions,
    ReadStateGroupSnapshotOptions,
    StateClientSnapshotRead,
    StateGroupSnapshotRead,
} from './state-read/point-read.ts';

export type StateEventListRequestOptions<TEventType extends string> =
    & ApiRequestOptions
    & Readonly<{
        eventTypes?: readonly TEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>;

export type StateGraphDiagnosticReadOptions =
    & ApiRequestOptions
    & GraphDiagnosticReadOptions;

export type StateGroupTopologyDeleteOptions =
    & ApiRequestOptions
    & Readonly<{
        requestId: string;
    }>;

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

export async function readApiConfig(
    options?: ApiRequestOptions,
): Promise<ApiConfig> {
    return await executeHttpRequest<void, ApiConfig>(
        readApiBaseUrl(),
        '/api/config',
        'GET',
        undefined,
        options,
    );
}

export async function readIceCandidates(
    options?: ApiRequestOptions,
): Promise<IceConfig> {
    return await executeHttpRequest<void, IceConfig>(
        readApiBaseUrl(),
        '/api/webrtc/ice',
        'GET',
        undefined,
        options,
    );
}

export async function catchUpRallarCrdtDocument(
    request: RallarCrdtCatchUpRequestEnvelope,
    options?: ApiRequestOptions,
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
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
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
    options?: ApiRequestOptions,
): Promise<ClientStateSnapshot[]> {
    return await executeHttpRequest<void, ClientStateSnapshot[]>(
        readApiBaseUrl(),
        toStateScopePath(scope) + '/clients',
        'GET',
        undefined,
        options,
    );
}

export async function listStateGroups(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot[]> {
    return await executeHttpRequest<void, GroupStateSnapshot[]>(
        readApiBaseUrl(),
        toStateScopePath(scope) + '/groups',
        'GET',
        undefined,
        options,
    );
}

export async function findStateGroup(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return (await readStateGroupSnapshot(groupId, scope, options)).snapshot;
}

export async function listStateGroupEvents(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions,
): Promise<GroupEvent[]> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/events`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
    validateAuthoritativeGroupEventList(response, { ...scope, groupId });
    return response;
}

export async function listStateGroupEventPage(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions,
): Promise<StateEventPage<GroupEvent>> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/events/page`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
    validateAuthoritativeGroupEventPage(response, { ...scope, groupId });
    return response;
}

export async function listStateClientEvents(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions,
): Promise<ClientEvent[]> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/events`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
    validateAuthoritativeClientEventList(response, { ...scope, principalId });
    return response;
}

export async function listStateClientEventPage(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions,
): Promise<StateEventPage<ClientEvent>> {
    const response: unknown = await executeHttpRequest<void, unknown>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/events/page`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
    validateAuthoritativeClientEventPage(response, { ...scope, principalId });
    return response;
}

export async function readStateScopedGlobalGraph(
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions,
): Promise<GraphDiagnosticReadResponse> {
    return await executeHttpRequest<void, GraphDiagnosticReadResponse>(
        readApiBaseUrl(),
        withGraphDiagnosticQuery(
            `${toStateScopePath(scope)}/graphs/global`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupGraph(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions,
): Promise<GraphDiagnosticReadResponse> {
    return await executeHttpRequest<void, GraphDiagnosticReadResponse>(
        readApiBaseUrl(),
        withGraphDiagnosticQuery(
            `${toStateGroupPath(scope, groupId)}/graphs/latest`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupTopology(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupTopologyManagementView> {
    return await executeHttpRequest<void, GroupTopologyManagementView>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateWorkspaceStatsSummary(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<WorkspaceSpaStatisticsResponse> {
    return await executeHttpRequest<void, WorkspaceSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/stats/summary`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupStats(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupSpaStatisticsResponse> {
    return await executeHttpRequest<void, GroupSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/stats`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateMyRealtimeStatus(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<MyRealtimeSpaStatisticsResponse> {
    return await executeHttpRequest<void, MyRealtimeSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/stats/me/realtime`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupTopologyConfig(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupTopologyConfigView> {
    return await executeHttpRequest<void, GroupTopologyConfigView>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        'GET',
        undefined,
        options,
    );
}

export async function putStateGroupTopologyConfig(
    groupId: string,
    request: PutGroupTopologyConfigRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<PutStateGroupTopologyConfigResponse> {
    const requestId = requireTopologyMutationRequestId(request.requestId);
    return await executeHttpRequest<
        PutGroupTopologyConfigRequest,
        PutStateGroupTopologyConfigResponse
    >(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        'PUT',
        { ...request, requestId },
        options,
        topologyMutationHeaders(requestId),
    );
}

export async function deleteStateGroupTopologyConfig(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options: StateGroupTopologyDeleteOptions,
): Promise<DeleteStateGroupTopologyConfigResponse> {
    return await executeHttpRequest<void, DeleteStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        'DELETE',
        undefined,
        options,
        topologyMutationHeaders(options.requestId),
    );
}

export async function readStateGroupTopologyOverride(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<StoredGroupTopologyOverride | Record<string, never>> {
    return await executeHttpRequest<void, StoredGroupTopologyOverride | Record<string, never>>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        'GET',
        undefined,
        options,
    );
}

export async function putStateGroupTopologyOverride(
    groupId: string,
    request: PutGroupTopologyOverrideRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<PutStateGroupTopologyOverrideResponse> {
    const requestId = requireTopologyMutationRequestId(request.requestId);
    return await executeHttpRequest<
        PutGroupTopologyOverrideRequest,
        PutStateGroupTopologyOverrideResponse
    >(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        'PUT',
        { ...request, requestId },
        options,
        topologyMutationHeaders(requestId),
    );
}

export async function deleteStateGroupTopologyOverride(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options: StateGroupTopologyDeleteOptions,
): Promise<DeleteStateGroupTopologyConfigResponse> {
    return await executeHttpRequest<void, DeleteStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        'DELETE',
        undefined,
        options,
        topologyMutationHeaders(options.requestId),
    );
}

function topologyMutationHeaders(
    requestId: string,
): Readonly<Record<string, string>> {
    return { 'Idempotency-Key': requireTopologyMutationRequestId(requestId) };
}

function requireTopologyMutationRequestId(requestId: string): string {
    const canonical = requestId.trim();
    if (canonical.length === 0) {
        throw new TypeError('Topology mutation requestId must be non-empty');
    }
    return canonical;
}

export async function reconfigureStateGroupTopology(
    groupId: string,
    request: ReconfigureGroupTopologyRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<QueuedGroupTopologyReconfigureResponse> {
    const requestId = requireTopologyMutationRequestId(request.requestId);
    return await executeHttpRequest<
        ReconfigureGroupTopologyRequest,
        QueuedGroupTopologyReconfigureResponse
    >(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/reconfigure`,
        'POST',
        { ...request, requestId },
        options,
        topologyMutationHeaders(requestId),
    );
}

export async function createStateGroup(
    request: CreateGroupRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<CreateGroupRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups`,
        'POST',
        request,
        options,
    );
}

export async function updateStateGroup(
    groupId: string,
    request: UpdateGroupRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<UpdateGroupRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}`,
        'PUT',
        request,
        options,
    );
}

export async function appointStateGroupDirector(
    groupId: string,
    request: AppointGroupDirectorRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<AppointGroupDirectorRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/director/appoint`,
        'POST',
        request,
        options,
    );
}

export async function joinStateGroup(
    groupId: string,
    request: JoinGroupRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<JoinGroupRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/join`,
        'POST',
        request,
        options,
    );
}

export async function createStateGroupInvite(
    groupId: string,
    principalId: string,
    request: CreateGroupInviteRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<CreateGroupInviteRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/invites/${
            encodeURIComponent(principalId)
        }`,
        'POST',
        request,
        options,
    );
}

export async function revokeStateGroupInvite(
    groupId: string,
    principalId: string,
    request: RevokeGroupInviteRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<RevokeGroupInviteRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/invites/${
            encodeURIComponent(principalId)
        }/revoke`,
        'POST',
        request,
        options,
    );
}

export async function acceptStateGroupInvite(
    groupId: string,
    request: AcceptGroupInviteRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<AcceptGroupInviteRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/invites/accept`,
        'POST',
        request,
        options,
    );
}

export async function rotateStateGroupJoinCode(
    groupId: string,
    request: RotateGroupJoinCodeRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupJoinCodeResponse> {
    return await executeHttpRequest<RotateGroupJoinCodeRequest, GroupJoinCodeResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/join-code/rotate`,
        'POST',
        request,
        options,
    );
}

export async function removeStateGroupMember(
    groupId: string,
    principalId: string,
    request: RemoveGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<RemoveGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/remove`,
        'POST',
        request,
        options,
    );
}

export async function banStateGroupMember(
    groupId: string,
    principalId: string,
    request: BanGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<BanGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/ban`,
        'POST',
        request,
        options,
    );
}

export async function unbanStateGroupMember(
    groupId: string,
    principalId: string,
    request: UnbanGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<UnbanGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/unban`,
        'POST',
        request,
        options,
    );
}

export async function setStateGroupMemberRole(
    groupId: string,
    principalId: string,
    request: SetGroupMemberRoleRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<SetGroupMemberRoleRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/role`,
        'PUT',
        request,
        options,
    );
}

export async function transferStateGroupOwnership(
    groupId: string,
    request: TransferGroupOwnershipRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<TransferGroupOwnershipRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/owner/transfer`,
        'POST',
        request,
        options,
    );
}

export async function upsertStateGroupMember(
    groupId: string,
    principalId: string,
    request: UpsertGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<UpsertGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }`,
        'PUT',
        request,
        options,
    );
}

export async function connectStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: ConnectGroupPresenceSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<
        ConnectGroupPresenceSessionRequest,
        GroupStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/sessions/${
            encodeURIComponent(sessionId)
        }`,
        'PUT',
        request,
        options,
    );
}

export async function connectStateClientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectClientSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<ClientStateSnapshot> {
    const mutation = toApiMutationRequest(
        `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/instances/${
            encodeURIComponent(clientInstanceId)
        }/sessions/${encodeURIComponent(sessionId)}`,
        request,
    );
    return await executeHttpRequest<
        Omit<ConnectClientSessionRequest, 'requestId'>,
        ClientStateSnapshot
    >(
        readApiBaseUrl(),
        mutation.path,
        'PUT',
        mutation.body,
        options,
    );
}

export async function heartbeatStateClientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatClientSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<ClientStateSnapshot> {
    const mutation = toApiMutationRequest(
        `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/instances/${
            encodeURIComponent(clientInstanceId)
        }/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        request,
    );
    return await executeHttpRequest<
        Omit<HeartbeatClientSessionRequest, 'requestId'>,
        ClientStateSnapshot
    >(
        readApiBaseUrl(),
        mutation.path,
        'POST',
        mutation.body,
        options,
    );
}

export async function heartbeatStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: HeartbeatGroupPresenceSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<
        HeartbeatGroupPresenceSessionRequest,
        GroupStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/sessions/${
            encodeURIComponent(sessionId)
        }/heartbeat`,
        'POST',
        request,
        options,
    );
}

export async function disconnectStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: DisconnectGroupPresenceSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<
        DisconnectGroupPresenceSessionRequest,
        GroupStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/sessions/${
            encodeURIComponent(sessionId)
        }/disconnect`,
        'POST',
        request,
        options,
    );
}

function toStateScopePath(scope: StateScope): string {
    return `/api/state/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
        encodeURIComponent(scope.workspaceId)
    }`;
}

function toApiMutationRequest<Request extends Readonly<{ requestId?: string }>>(
    path: string,
    request: Request,
): Readonly<{
    path: string;
    body: Omit<Request, 'requestId'>;
}> {
    const { requestId: candidate, ...body } = request;
    const requestId = candidate ?? crypto.randomUUID();
    return {
        path: toApiMutationRequestPath(path, requestId),
        body,
    };
}

function toStateGroupPath(scope: StateScope, groupId: string): string {
    return `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}`;
}

function withGraphDiagnosticQuery(
    path: string,
    options?: StateGraphDiagnosticReadOptions,
): string {
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
    options?: StateEventListRequestOptions<TEventType>,
): string {
    const searchParams = new URLSearchParams();
    for (const eventType of options?.eventTypes ?? []) {
        searchParams.append('eventType', eventType);
    }
    if (options?.limit !== undefined) {
        searchParams.set('limit', String(options.limit));
    }
    if (options?.after) {
        searchParams.set(
            'afterSnapshotVersion',
            String(options.after.snapshotVersion),
        );
        searchParams.set(
            'afterOccurredAtEpochMs',
            String(options.after.occurredAtEpochMs),
        );
        searchParams.set('afterEventId', options.after.eventId);
    }

    return withSearchParams(path, searchParams);
}

function withSearchParams(path: string, searchParams: URLSearchParams): string {
    const query = searchParams.toString();
    return query ? `${path}?${query}` : path;
}
