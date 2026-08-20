import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import {
  validateAuthoritativeClientSnapshot,
  validateAuthoritativeGroupSnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupJoinCodeResponse, StateScope } from '@shared/api/state-types.ts';
import type {
  AppointStateGroupDirectorBody,
  RevokeStateGroupInviteBody,
  RotateStateGroupJoinCodeBody,
} from '@shared-web/browser/api/state-mutation-http-contracts.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
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
  revokeStateGroupInvite as revokeStateGroupInviteApi,
  rotateStateGroupJoinCode as rotateStateGroupJoinCodeApi,
  updateStateGroup,
} from '@shared-web/browser/api-integration.ts';
import {
  isStateWorkflowNotFoundError,
  requireStateWorkflowResult,
  tolerateStateWorkflowNotFound,
  toApiMutationWorkflowRequestId,
} from '@shared-web/browser/state-workflow-support.ts';
// prettier-ignore
import type {
  StateGroupWorkflowValue,
} from '@shared-web/browser/rooms/room-group-state-workflows.ts';
// prettier-ignore
import {
  refreshCompleteStateSnapshotCollections,
} from '@shared-web/browser/state-read/collection-refresh.ts';

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

type StateHeartbeatKey = 'client' | `group:${string}`;

export async function refreshStateSnapshots(
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateSnapshotsWorkflowValue> = {},
): Promise<StateSnapshots> {
  return await refreshCompleteStateSnapshotCollections(scope, policies);
}

export async function appointStateGroupDirector(
  groupId: string,
  request: AppointStateGroupDirectorBody,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
  const requestId = toApiMutationWorkflowRequestId();
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupStateSnapshot>;

  return await new Command<GroupStateSnapshot>(
    (signal) =>
      appointStateGroupDirectorApi(
        groupId,
        {
          ...request,
          actorPrincipalId: principalId,
          actorSessionId: sessionId,
        },
        { requestId, signal },
        scope,
      ),
    commandOptions,
  ).run();
}

export async function revokeStateGroupInvite(
  groupId: string,
  targetPrincipalId: string,
  request: RevokeStateGroupInviteBody,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
  const requestId = toApiMutationWorkflowRequestId();
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
        },
        { requestId, signal },
        scope,
      ),
    commandOptions,
  ).run();
}

export async function rotateStateGroupJoinCode(
  groupId: string,
  request: RotateStateGroupJoinCodeBody,
  principalId: string,
  sessionId: string,
  scope: StateScope = defaultStateScope(),
  policies: CommandsOrchestratorPolicies<GroupJoinCodeResponse> = {},
): Promise<GroupJoinCodeResponse> {
  const requestId = toApiMutationWorkflowRequestId();
  const commandOptions = (policies.command ?? {}) as CommandOptions<GroupJoinCodeResponse>;

  return await new Command<GroupJoinCodeResponse>(
    (signal) =>
      rotateStateGroupJoinCodeApi(
        groupId,
        {
          ...request,
          actorPrincipalId: principalId,
          actorSessionId: sessionId,
        },
        { requestId, signal },
        scope,
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
  const clientHeartbeatRequestId = toApiMutationWorkflowRequestId();
  const clientPresenceRepairRequestId = toApiMutationWorkflowRequestId();
  const flow = CommandsOrchestrator.withPolicies<StateHeartbeatKey, StateHeartbeatWorkflowValue>(
    options.policies ?? {},
  );
  const commandPolicy = options.policies?.command;

  const results = await flow
    .sequential(
      flow.commandStep(
        'client',
        (signal) =>
          heartbeatStateClientSessionWithPresenceRepair({
            clientData,
            request: {
              generationId: options.generationId,
              actorPrincipalId: clientData.clientId,
              actorSessionId: clientData.sessionId,
              presenceState: 'online',
              lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
              expiresAtEpochMs,
            },
            requestId: clientHeartbeatRequestId,
            scope,
            repairRequestId: clientPresenceRepairRequestId,
            options: {
              signal,
              authSession: options.authSession,
            },
          }),
        {
          shouldRetry: (error, attempt) =>
            !isStateWorkflowNotFoundError(error) &&
            shouldRetryHeartbeatError(error, attempt, commandPolicy),
        },
      ),
    )
    .parallel(
      ...joinedGroups.map((snapshot) => {
        const groupHeartbeatRequestId = toApiMutationWorkflowRequestId();
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
              },
              {
                requestId: groupHeartbeatRequestId,
                signal,
                authSession: options.authSession,
              },
              scope,
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

interface HeartbeatStateClientSessionWithPresenceRepairInput {
  readonly clientData: ClientInfo;
  readonly request: Parameters<typeof heartbeatStateClientSession>[3];
  readonly requestId: string;
  readonly scope: StateScope;
  readonly repairRequestId: string;
  readonly options: Omit<Parameters<typeof heartbeatStateClientSession>[4], 'requestId'>;
}

async function heartbeatStateClientSessionWithPresenceRepair(
  input: HeartbeatStateClientSessionWithPresenceRepairInput,
): Promise<ClientStateSnapshot> {
  const { clientData, options, repairRequestId, request, requestId, scope } = input;
  try {
    return await heartbeatStateClientSession(
      clientData.clientId,
      clientData.clientId,
      clientData.sessionId,
      request,
      { ...options, requestId },
      scope,
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
    },
    { ...options, requestId: repairRequestId },
    scope,
  );
}

function shouldRetryHeartbeatError<T>(
  error: unknown,
  attempt: number,
  commandPolicy: CommandsOrchestratorPolicies<T>['command'] | undefined,
): boolean {
  if (error instanceof ApiHttpError && error.status === 401) {
    return false;
  }

  return commandPolicy?.shouldRetry?.(error, attempt) ?? true;
}

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}
