import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import {
  validateAuthoritativeClientSnapshot,
  validateAuthoritativeClientSnapshotList,
  validateAuthoritativeGroupSnapshot,
  validateAuthoritativeGroupSnapshotList,
} from '@shared/api/authoritative-state-validation.ts';
import type {
  RevokeGroupInviteRequest,
  RotateGroupJoinCodeRequest,
  AppointGroupDirectorRequest,
  GroupJoinCodeResponse,
  StateScope,
} from '@shared/api/state-types.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import {
  CommandsOrchestrator,
  type CommandsOrchestratorPolicies,
  type OrchestratorResults,
} from '@shared/cache/CommandsOrchestrator.ts';
import {
  appointStateGroupDirector as appointStateGroupDirectorApi,
  connectStateClientSession,
  connectStateGroupPresenceSession,
  defaultStateScope,
  findStateGroup,
  heartbeatStateClientSession,
  heartbeatStateGroupPresenceSession,
  listStateClients,
  listStateGroups,
  revokeStateGroupInvite as revokeStateGroupInviteApi,
  rotateStateGroupJoinCode as rotateStateGroupJoinCodeApi,
  updateStateGroup,
} from '@shared-web/browser/api-integration.ts';
import {
  isStateWorkflowNotFoundError,
  requireStateWorkflowResult,
  tolerateStateWorkflowNotFound,
  toStateWorkflowRequestId,
} from '@shared-web/browser/state-workflow-support.ts';
import type { StateGroupWorkflowValue } from '@shared-web/browser/rooms/room-group-state-workflows.ts';

export {
  createAndJoinStateGroup,
  joinStateGroup,
  leaveStateGroup,
} from '@shared-web/browser/rooms/room-group-state-workflows.ts';
export type {
  CreateAndJoinStateGroupOptions,
  JoinStateGroupIntent,
  StateGroupWorkflowValue,
} from '@shared-web/browser/rooms/room-group-state-workflows.ts';
export {
  archiveStateGroup,
  deleteStateGroup,
  updateStateGroupDetails,
  updateStateGroupMetadata,
} from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
export {
  acceptStateGroupInvite,
  banStateGroupMember,
  createStateGroupInvite,
  removeStateGroupMember,
  setStateGroupMemberRole,
  transferStateGroupOwnership,
  unbanStateGroupMember,
} from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';

export const DEFAULT_STATE_HEARTBEAT_TTL_MSECS = 120000;

export type StateSnapshots = Readonly<{
  clients: ClientStateSnapshot[];
  groups: GroupStateSnapshot[];
}>;

export type StateSnapshotsWorkflowValue = ClientStateSnapshot[] | GroupStateSnapshot[];

export type StateHeartbeatWorkflowValue = ClientStateSnapshot | GroupStateSnapshot | undefined;

export type RefreshStateHeartbeatOptions = Readonly<{
  generationId: string;
  scope?: StateScope;
  authSession?: AuthSession;
  heartbeatAtEpochMs?: number;
  ttlMs?: number;
  policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
}>;

export type RefreshStateHeartbeatResult = Readonly<{
  client: ClientStateSnapshot;
  groups: GroupStateSnapshot[];
  missingGroups: GroupStateSnapshot[];
  heartbeatAtEpochMs: number;
  expiresAtEpochMs: number;
}>;

type StateSnapshotsKey = 'clients' | 'groups';

type StateHeartbeatKey = 'client' | `group:${string}`;

export async function refreshStateSnapshots(
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateSnapshotsWorkflowValue> = {},
): Promise<StateSnapshots> {
  const flow = CommandsOrchestrator.withPolicies<StateSnapshotsKey, StateSnapshotsWorkflowValue>(
    policies,
  );

  const results = await flow
    .parallel(
      flow.commandStep('clients', (signal) => listStateClients(scope, { signal })),
      flow.commandStep('groups', (signal) => listStateGroups(scope, { signal })),
    )
    .run();

  const clients: unknown = requireStateWorkflowResult(results, 'clients');
  const groups: unknown = requireStateWorkflowResult(results, 'groups');
  validateAuthoritativeClientSnapshotList(clients, scope);
  validateAuthoritativeGroupSnapshotList(groups, scope);
  return { clients, groups };
}

export async function appointStateGroupDirector(
  groupId: string,
  request: AppointGroupDirectorRequest,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
  const requestId =
    request.requestId ?? toStateWorkflowRequestId('group-director-appoint', groupId, sessionId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupStateSnapshot>;

  return await new Command<GroupStateSnapshot>(
    (signal) =>
      appointStateGroupDirectorApi(
        groupId,
        {
          ...request,
          actorPrincipalId: principalId,
          actorSessionId: sessionId,
          requestId,
        },
        scope,
        { signal },
      ),
    commandOptions,
  ).run();
}

export async function revokeStateGroupInvite(
  groupId: string,
  targetPrincipalId: string,
  request: RevokeGroupInviteRequest,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
  const requestId =
    request.requestId ??
    toStateWorkflowRequestId('group-invite-revoke', groupId, targetPrincipalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupStateSnapshot>;

  return await new Command<GroupStateSnapshot>(
    (signal) =>
      revokeStateGroupInviteApi(
        groupId,
        targetPrincipalId,
        {
          ...request,
          actorPrincipalId: principalId,
          actorSessionId: sessionId,
          requestId,
        },
        scope,
        { signal },
      ),
    commandOptions,
  ).run();
}

export async function rotateStateGroupJoinCode(
  groupId: string,
  request: RotateGroupJoinCodeRequest,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<GroupJoinCodeResponse> = {},
): Promise<GroupJoinCodeResponse> {
  const requestId =
    request.requestId ?? toStateWorkflowRequestId('group-join-code-rotate', groupId, principalId);
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupJoinCodeResponse>;

  return await new Command<GroupJoinCodeResponse>(
    (signal) =>
      rotateStateGroupJoinCodeApi(
        groupId,
        {
          ...request,
          actorPrincipalId: principalId,
          actorSessionId: sessionId,
          requestId,
        },
        scope,
        { signal },
      ),
    commandOptions,
  ).run();
}

export async function refreshStateHeartbeat(
  clientData: ClientInfo,
  joinedGroups: readonly GroupStateSnapshot[],
  options: RefreshStateHeartbeatOptions,
): Promise<RefreshStateHeartbeatResult> {
  const scope = options.scope ?? defaultStateScope();
  const heartbeatAtEpochMs = options.heartbeatAtEpochMs ?? Date.now();
  const expiresAtEpochMs =
    heartbeatAtEpochMs + (options.ttlMs ?? DEFAULT_STATE_HEARTBEAT_TTL_MSECS);
  const clientHeartbeatRequestId = toStateWorkflowRequestId(
    'client-session-heartbeat',
    clientData.clientId,
    clientData.sessionId,
  );
  const flow = CommandsOrchestrator.withPolicies<StateHeartbeatKey, StateHeartbeatWorkflowValue>(
    options.policies ?? {},
  );
  const commandPolicy = options.policies?.command;

  const results = await flow
    .sequential(
      flow.commandStep(
        'client',
        (signal) =>
          heartbeatStateClientSessionWithPresenceRepair(
            clientData,
            {
              generationId: options.generationId,
              actorPrincipalId: clientData.clientId,
              actorSessionId: clientData.sessionId,
              presenceState: 'online',
              lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
              expiresAtEpochMs,
              requestId: clientHeartbeatRequestId,
            },
            scope,
            {
              signal,
              authSession: options.authSession,
            },
          ),
        {
          shouldRetry: (error, attempt) =>
            !isStateWorkflowNotFoundError(error) &&
            shouldRetryHeartbeatError(error, attempt, commandPolicy),
        },
      ),
    )
    .parallel(
      ...joinedGroups.map((snapshot) => {
        const groupHeartbeatRequestId = toStateWorkflowRequestId(
          'group-presence-heartbeat',
          snapshot.group.groupId,
          clientData.sessionId,
        );
        const groupSessionGenerationId =
          snapshot.activeSessions.find((session) => session.sessionId === clientData.sessionId)
            ?.generationId ?? options.generationId;

        return flow.commandStep(
          `group:${snapshot.group.groupId}`,
          (signal) =>
            heartbeatStateGroupPresenceSession(
              snapshot.group.groupId,
              clientData.sessionId,
              {
                generationId: groupSessionGenerationId,
                principalId: clientData.clientId,
                actorPrincipalId: clientData.clientId,
                actorSessionId: clientData.sessionId,
                lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
                expiresAtEpochMs,
                requestId: groupHeartbeatRequestId,
              },
              scope,
              {
                signal,
                authSession: options.authSession,
              },
            ),
          {
            errorOnNull: false,
            shouldRetry: (error, attempt) =>
              !isStateWorkflowNotFoundError(error) &&
              shouldRetryHeartbeatError(error, attempt, commandPolicy),
            fallback: (error) => tolerateStateWorkflowNotFound(error, undefined),
          },
        );
      }),
    )
    .run();

  const client: unknown = requireStateWorkflowResult(results, 'client');
  validateAuthoritativeClientSnapshot(client, scope);
  const groups: GroupStateSnapshot[] = [];
  const missingGroups: GroupStateSnapshot[] = [];
  for (const snapshot of joinedGroups) {
    const result: unknown = results.get(`group:${snapshot.group.groupId}`);
    if (result === undefined) {
      missingGroups.push(snapshot);
      continue;
    }
    validateAuthoritativeGroupSnapshot(result, scope);
    groups.push(result);
  }
  return {
    client,
    groups,
    missingGroups,
    heartbeatAtEpochMs,
    expiresAtEpochMs,
  };
}

async function heartbeatStateClientSessionWithPresenceRepair(
  clientData: ClientInfo,
  request: Parameters<typeof heartbeatStateClientSession>[3],
  scope: StateScope,
  options: Parameters<typeof heartbeatStateClientSession>[5],
): Promise<ClientStateSnapshot> {
  try {
    return await heartbeatStateClientSession(
      clientData.clientId,
      clientData.clientId,
      clientData.sessionId,
      request,
      scope,
      options,
    );
  } catch (error) {
    if (!isStateWorkflowNotFoundError(error)) {
      throw error;
    }
  }

  return await connectStateClientSession(
    clientData.clientId,
    clientData.clientId,
    clientData.sessionId,
    {
      generationId: request.generationId,
      actorPrincipalId: request.actorPrincipalId ?? clientData.clientId,
      actorSessionId: request.actorSessionId ?? clientData.sessionId,
      presenceState: request.presenceState ?? 'online',
      transport: 'ws',
      connectionId: request.generationId,
      connectedAtEpochMs: request.lastHeartbeatAtEpochMs,
      lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs,
      expiresAtEpochMs: request.expiresAtEpochMs,
      requestId: toStateWorkflowRequestId(
        'client-session-connect-repair',
        clientData.clientId,
        clientData.sessionId,
      ),
    },
    scope,
    options,
  );
}

function shouldRetryHeartbeatError<T>(
  error: unknown,
  attempt: number,
  commandPolicy: CommandsOrchestratorPolicies<T>['command'] | undefined,
): boolean {
  if (readApiErrorStatus(error) === 401) {
    return false;
  }

  return commandPolicy?.shouldRetry?.(error, attempt) ?? true;
}

function readApiErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}
