import { readApiBaseUrl } from './api-client-config.ts';
import {
  type ApiMutationRequestOptions,
  type ApiRequestOptions,
  executeHttpRequest,
} from './api/http-request.ts';
import { readStateGroupSnapshot } from './state-read/point-read.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
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

export type StateEventListRequestOptions<TEventType extends string> = ApiRequestOptions &
  Readonly<{
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
    options,
  );
}

export async function readIceCandidates(options?: ApiRequestOptions): Promise<IceConfig> {
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
    withGraphDiagnosticQuery(`${toStateScopePath(scope)}/graphs/global`, options),
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
    withGraphDiagnosticQuery(`${toStateGroupPath(scope, groupId)}/graphs/latest`, options),
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
  request: Omit<PutGroupTopologyConfigRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<PutStateGroupTopologyConfigResponse> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/topology/config`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<PutGroupTopologyConfigRequest, 'requestId'>,
    PutStateGroupTopologyConfigResponse
  >(readApiBaseUrl(), path, 'PUT', request, options);
}

export async function deleteStateGroupTopologyConfig(
  groupId: string,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<DeleteStateGroupTopologyConfigResponse> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/topology/config`,
    options.requestId,
  );
  return await executeHttpRequest<Record<string, never>, DeleteStateGroupTopologyConfigResponse>(
    readApiBaseUrl(),
    path,
    'DELETE',
    {},
    options,
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
  request: Omit<PutGroupTopologyOverrideRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<PutStateGroupTopologyOverrideResponse> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/topology/override`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<PutGroupTopologyOverrideRequest, 'requestId'>,
    PutStateGroupTopologyOverrideResponse
  >(readApiBaseUrl(), path, 'PUT', request, options);
}

export async function deleteStateGroupTopologyOverride(
  groupId: string,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<DeleteStateGroupTopologyConfigResponse> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/topology/override`,
    options.requestId,
  );
  return await executeHttpRequest<Record<string, never>, DeleteStateGroupTopologyConfigResponse>(
    readApiBaseUrl(),
    path,
    'DELETE',
    {},
    options,
  );
}

export async function reconfigureStateGroupTopology(
  groupId: string,
  request: Omit<ReconfigureGroupTopologyRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<QueuedGroupTopologyReconfigureResponse> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/topology/reconfigure`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<ReconfigureGroupTopologyRequest, 'requestId'>,
    QueuedGroupTopologyReconfigureResponse
  >(readApiBaseUrl(), path, 'POST', request, options);
}

export async function createStateGroup(
  request: Omit<CreateGroupRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(`${toStateScopePath(scope)}/groups`, options.requestId);
  return await executeHttpRequest<Omit<CreateGroupRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function updateStateGroup(
  groupId: string,
  request: Omit<UpdateGroupRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(toStateGroupPath(scope, groupId), options.requestId);
  return await executeHttpRequest<Omit<UpdateGroupRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'PUT',
    request,
    options,
  );
}

export async function appointStateGroupDirector(
  groupId: string,
  request: Omit<AppointGroupDirectorRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/director/appoint`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<AppointGroupDirectorRequest, 'requestId'>,
    GroupStateSnapshot
  >(readApiBaseUrl(), path, 'POST', request, options);
}

export async function joinStateGroup(
  groupId: string,
  request: Omit<JoinGroupRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/join`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<JoinGroupRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function createStateGroupInvite(
  groupId: string,
  principalId: string,
  request: Omit<CreateGroupInviteRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/invites/${encodeURIComponent(principalId)}`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<CreateGroupInviteRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function revokeStateGroupInvite(
  groupId: string,
  principalId: string,
  request: Omit<RevokeGroupInviteRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/invites/${encodeURIComponent(principalId)}/revoke`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<RevokeGroupInviteRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function acceptStateGroupInvite(
  groupId: string,
  request: Omit<AcceptGroupInviteRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/invites/accept`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<AcceptGroupInviteRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function rotateStateGroupJoinCode(
  groupId: string,
  request: Omit<RotateGroupJoinCodeRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupJoinCodeResponse> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/join-code/rotate`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<RotateGroupJoinCodeRequest, 'requestId'>,
    GroupJoinCodeResponse
  >(readApiBaseUrl(), path, 'POST', request, options);
}

export async function removeStateGroupMember(
  groupId: string,
  principalId: string,
  request: Omit<RemoveGroupMemberRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/remove`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<RemoveGroupMemberRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function banStateGroupMember(
  groupId: string,
  principalId: string,
  request: Omit<BanGroupMemberRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/ban`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<BanGroupMemberRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function unbanStateGroupMember(
  groupId: string,
  principalId: string,
  request: Omit<UnbanGroupMemberRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/unban`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<UnbanGroupMemberRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'POST',
    request,
    options,
  );
}

export async function setStateGroupMemberRole(
  groupId: string,
  principalId: string,
  request: Omit<SetGroupMemberRoleRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}/role`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<SetGroupMemberRoleRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'PUT',
    request,
    options,
  );
}

export async function transferStateGroupOwnership(
  groupId: string,
  request: Omit<TransferGroupOwnershipRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/owner/transfer`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<TransferGroupOwnershipRequest, 'requestId'>,
    GroupStateSnapshot
  >(readApiBaseUrl(), path, 'POST', request, options);
}

export async function upsertStateGroupMember(
  groupId: string,
  principalId: string,
  request: Omit<UpsertGroupMemberRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/members/${encodeURIComponent(principalId)}`,
    options.requestId,
  );
  return await executeHttpRequest<Omit<UpsertGroupMemberRequest, 'requestId'>, GroupStateSnapshot>(
    readApiBaseUrl(),
    path,
    'PUT',
    request,
    options,
  );
}

export async function connectStateGroupPresenceSession(
  groupId: string,
  sessionId: string,
  request: Omit<ConnectGroupPresenceSessionRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/sessions/${encodeURIComponent(sessionId)}`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<ConnectGroupPresenceSessionRequest, 'requestId'>,
    GroupStateSnapshot
  >(readApiBaseUrl(), path, 'PUT', request, options);
}

export async function connectStateClientSession(
  principalId: string,
  clientInstanceId: string,
  sessionId: string,
  request: Omit<ConnectClientSessionRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<ClientStateSnapshot> {
  const clientPath = `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}`;
  const instancePath = `${clientPath}/instances/${encodeURIComponent(clientInstanceId)}`;
  const path = toApiMutationRequestPath(
    `${instancePath}/sessions/${encodeURIComponent(sessionId)}`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<ConnectClientSessionRequest, 'requestId'>,
    ClientStateSnapshot
  >(readApiBaseUrl(), path, 'PUT', request, options);
}

export async function heartbeatStateClientSession(
  principalId: string,
  clientInstanceId: string,
  sessionId: string,
  request: Omit<HeartbeatClientSessionRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<ClientStateSnapshot> {
  const clientPath = `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}`;
  const instancePath = `${clientPath}/instances/${encodeURIComponent(clientInstanceId)}`;
  const path = toApiMutationRequestPath(
    `${instancePath}/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<HeartbeatClientSessionRequest, 'requestId'>,
    ClientStateSnapshot
  >(readApiBaseUrl(), path, 'POST', request, options);
}

export async function heartbeatStateGroupPresenceSession(
  groupId: string,
  sessionId: string,
  request: Omit<HeartbeatGroupPresenceSessionRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<HeartbeatGroupPresenceSessionRequest, 'requestId'>,
    GroupStateSnapshot
  >(readApiBaseUrl(), path, 'POST', request, options);
}

export async function disconnectStateGroupPresenceSession(
  groupId: string,
  sessionId: string,
  request: Omit<DisconnectGroupPresenceSessionRequest, 'requestId'>,
  options: ApiMutationRequestOptions,
  scope: StateScope = defaultStateScope(),
): Promise<GroupStateSnapshot> {
  const path = toApiMutationRequestPath(
    `${toStateGroupPath(scope, groupId)}/sessions/${encodeURIComponent(sessionId)}/disconnect`,
    options.requestId,
  );
  return await executeHttpRequest<
    Omit<DisconnectGroupPresenceSessionRequest, 'requestId'>,
    GroupStateSnapshot
  >(readApiBaseUrl(), path, 'POST', request, options);
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
