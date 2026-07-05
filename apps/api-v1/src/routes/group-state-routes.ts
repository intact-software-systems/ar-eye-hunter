import { Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  AcceptGroupInviteRequest,
  AppointGroupDirectorRequest,
  BanGroupMemberRequest,
  ConnectGroupPresenceSessionRequest,
  CreateGroupInviteRequest,
  CreateGroupRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
  JoinGroupRequest,
  RemoveGroupMemberRequest,
  RevokeGroupInviteRequest,
  RotateGroupJoinCodeRequest,
  SetGroupMemberRoleRequest,
  StateScope,
  TransferGroupOwnershipRequest,
  UnbanGroupMemberRequest,
  UpdateGroupRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import { getGroupStateService, type GroupStateService } from '../services/group-state-service.ts';
import { requireApiAuthSession as defaultRequireApiAuthSession } from '../services/request-auth-service.ts';
import { getMiddleware } from '../middleware.ts';
import type {
  GroupJoinCodeWritten,
  GroupMutationWritten,
  GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  type GroupCreateAppInboxPayload,
  type GroupDirectorAppointAppInboxPayload,
  type GroupInviteAcceptAppInboxPayload,
  type GroupInviteCreateAppInboxPayload,
  type GroupInviteRevokeAppInboxPayload,
  type GroupJoinAppInboxPayload,
  type GroupJoinCodeRotateAppInboxPayload,
  type GroupMemberBanAppInboxPayload,
  type GroupMemberRemoveAppInboxPayload,
  type GroupMemberRoleSetAppInboxPayload,
  type GroupMemberUnbanAppInboxPayload,
  type GroupMemberUpsertAppInboxPayload,
  type GroupOwnershipTransferAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
  type GroupPresenceDisconnectAppInboxPayload,
  type GroupPresenceHeartbeatAppInboxPayload,
  type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  filterStateEventsForList,
  readStateEventListQuery,
  type StateEventListQuery,
} from '@shared-server/rallar-system/state-event-listing.ts';
import {
  hydrateStateSyncSnapshotCaches as defaultHydrateStateSyncSnapshotCaches,
  type StateSyncCacheHydrationInput,
  type StateSyncCacheHydrationResult,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import {
  canReadGroupSnapshot as canReadFullGroupSnapshot,
  canUpdateGroupSnapshot,
  GroupPolicyDeniedError,
  isGroupPolicyDeniedError,
} from '@shared-server/rallar-system/group-policy.ts';
import {
  GROUP_POLICY_REASON_CODES,
  type GroupPolicyDenied,
  type GroupPolicyReasonCode,
} from '@shared/api/group-policy-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

const GROUP_POLICY_REASON_CODE_SET = new Set<string>(GROUP_POLICY_REASON_CODES);

export type GroupStateRouteService = Pick<
  GroupStateService,
  | 'listSnapshots'
  | 'readSnapshot'
  | 'listEvents'
  | 'listRecentEvents'
  | 'listEventPage'
>;

export type GroupStateRouteAuthSession = Pick<
  AuthSession,
  'clientId' | 'sessionId'
>;

export type ProcessGroupAppInbox = <V, R>(
  enqueue: AppInboxEnqueueInput<V>,
) => Promise<R>;

export type GroupStateRouteDependencies = Readonly<{
  getGroupStateService?: () => GroupStateRouteService;
  requireApiAuthSession?: (
    req: {
      header(name: string): string | undefined;
    },
  ) => Promise<GroupStateRouteAuthSession>;
  processGroupAppInbox?: ProcessGroupAppInbox;
  hydrateStateSyncSnapshotCaches?: (
    input: StateSyncCacheHydrationInput,
  ) => Promise<StateSyncCacheHydrationResult>;
}>;

export function init(
  app: Hono,
  dependencies: GroupStateRouteDependencies = {},
): void {
  const deps = toGroupStateRouteDependencies(dependencies);

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    async (c) => {
      try {
        const authSession = await readStrictReadAuthSession(c.req, deps);
        const snapshots = authSession
          ? (await deps.getGroupStateService().listSnapshots(toScope(c)))
            .filter((snapshot) =>
              canReadFullGroupSnapshot({
                snapshot,
                actor: { principalId: authSession.clientId },
              }).allowed
            )
          : await deps.getGroupStateService().listSnapshots(toScope(c));
        hydrateGroupSnapshots(deps, snapshots);
        return c.json(snapshots);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    async (c) => {
      try {
        const groupId = c.req.param('groupId');
        const snapshot = await deps.getGroupStateService().readSnapshot({
          ...toScope(c),
          groupId,
        });
        if (!snapshot) {
          return c.json({ error: `Group not found: ${groupId}` }, 404);
        }
        await assertCanReadGroupState(c.req, deps, snapshot);
        hydrateGroupSnapshots(deps, [snapshot]);

        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events',
    async (c) => {
      try {
        const groupId = c.req.param('groupId');
        await assertCanReadGroupRef(c.req, deps, {
          ...toScope(c),
          groupId,
        });
        const ref = {
          ...toScope(c),
          groupId,
        };
        const query = readStateEventListQuery(
          new URL(c.req.raw.url).searchParams,
        );

        return c.json(
          await listRecentGroupEventsForLegacyRoute(
            deps.getGroupStateService(),
            ref,
            query,
          ),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events/page',
    async (c) => {
      try {
        const groupId = c.req.param('groupId');
        await assertCanReadGroupRef(c.req, deps, {
          ...toScope(c),
          groupId,
        });

        return c.json(
          await deps.getGroupStateService().listEventPage(
            {
              ...toScope(c),
              groupId,
            },
            readStateEventListQuery(
              new URL(c.req.raw.url).searchParams,
            ),
          ),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const requestBody = await readRequestWithRequestId<CreateGroupRequest>(c);
        const request = withActorAndCreator(requestBody, authSession);
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupCreateAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_CREATE,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, request.groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              request,
            },
          }),
        );

        return c.json(written.snapshot, 201);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        await assertCanUpdateGroup(
          authSession.clientId,
          scope,
          groupId,
          deps.getGroupStateService(),
        );
        const request = withActor(
          await readRequestWithRequestId<UpdateGroupRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_UPDATE,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              request,
            },
          }),
        );
        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/director/appoint',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const request = withActor(
          await readRequestWithRequestId<AppointGroupDirectorRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupDirectorAppointAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_DIRECTOR_APPOINT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const request = withActor(
          await readRequestWithRequestId<JoinGroupRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupJoinAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_JOIN,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/accept',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const request = withActor(
          await readRequestWithRequestId<AcceptGroupInviteRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupInviteAcceptAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_INVITE_ACCEPT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join-code/rotate',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const request = withActor(
          await readRequestWithRequestId<RotateGroupJoinCodeRequest>(c),
          authSession,
        );
        const response = unwrapGroupJoinCodeWritten(
          await deps.processGroupAppInbox<
            GroupJoinCodeRotateAppInboxPayload,
            GroupJoinCodeWritten
          >({
            type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              request,
            },
          }),
        );

        return c.json(response);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        const request = withActor(
          await readRequestWithRequestId<CreateGroupInviteRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupInviteCreateAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_INVITE_CREATE,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId/revoke',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        const request = withActor(
          await readRequestWithRequestId<RevokeGroupInviteRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupInviteRevokeAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_INVITE_REVOKE,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/remove',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        const request = withActor(
          await readRequestWithRequestId<RemoveGroupMemberRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberRemoveAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_MEMBER_REMOVE,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/ban',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        const request = withActor(
          await readRequestWithRequestId<BanGroupMemberRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberBanAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_MEMBER_BAN,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/unban',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        const request = withActor(
          await readRequestWithRequestId<UnbanGroupMemberRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberUnbanAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_MEMBER_UNBAN,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/role',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        const request = withActor(
          await readRequestWithRequestId<SetGroupMemberRoleRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberRoleSetAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_MEMBER_ROLE_SET,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/owner/transfer',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const request = withActor(
          await readRequestWithRequestId<TransferGroupOwnershipRequest>(c),
          authSession,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupOwnershipTransferAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              request,
            },
          }),
        );

        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const principalId = c.req.param('principalId');
        assertSelfPrincipal(authSession.clientId, principalId);
        const request = await readRequestWithRequestId<UpsertGroupMemberRequest>(c);
        assertSelfServiceMemberStatus(request.status);
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberUpsertAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request: withActor(
                {
                  ...request,
                  role: undefined,
                },
                authSession,
              ),
            },
          }),
        );
        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const sessionId = c.req.param('sessionId');
        assertSelfSession(authSession, sessionId);
        const request = await readRequestWithRequestId<ConnectGroupPresenceSessionRequest>(c);
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupPresenceConnectAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              sessionId,
              request: {
                ...request,
                principalId: authSession.clientId,
                actorPrincipalId: authSession.clientId,
                actorSessionId: authSession.sessionId,
              },
            },
          }),
        );
        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/heartbeat',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const sessionId = c.req.param('sessionId');
        assertSelfSession(authSession, sessionId);
        const request = await readRequestWithRequestId<HeartbeatGroupPresenceSessionRequest>(
          c,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupPresenceHeartbeatAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              sessionId,
              request: {
                ...request,
                principalId: authSession.clientId,
                actorPrincipalId: authSession.clientId,
                actorSessionId: authSession.sessionId,
              },
            },
          }),
        );
        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/disconnect',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const groupId = c.req.param('groupId');
        const sessionId = c.req.param('sessionId');
        assertSelfSession(authSession, sessionId);
        const request = await readRequestWithRequestId<DisconnectGroupPresenceSessionRequest>(
          c,
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupPresenceDisconnectAppInboxPayload,
            GroupStateWritten
          >({
            type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              sessionId,
              request: {
                ...request,
                principalId: authSession.clientId,
                actorPrincipalId: authSession.clientId,
                actorSessionId: authSession.sessionId,
              },
            },
          }),
        );
        return c.json(written.snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );
}

function toGroupStateRouteDependencies(
  dependencies: GroupStateRouteDependencies,
): Required<GroupStateRouteDependencies> {
  return {
    getGroupStateService: dependencies.getGroupStateService ??
      getGroupStateService,
    requireApiAuthSession: dependencies.requireApiAuthSession ??
      defaultRequireApiAuthSession,
    processGroupAppInbox: dependencies.processGroupAppInbox ??
      defaultProcessGroupAppInbox,
    hydrateStateSyncSnapshotCaches: dependencies.hydrateStateSyncSnapshotCaches ??
      defaultHydrateStateSyncSnapshotCaches,
  };
}

async function listRecentGroupEventsForLegacyRoute(
  service: GroupStateRouteService,
  ref: GroupRef,
  query: StateEventListQuery,
): Promise<readonly GroupEvent[]> {
  return service.listRecentEvents
    ? await service.listRecentEvents(ref, query)
    : filterStateEventsForList(await service.listEvents(ref), query);
}

async function assertCanReadGroupRef(
  req: {
    header(name: string): string | undefined;
  },
  deps: Required<GroupStateRouteDependencies>,
  ref: StateScope & Readonly<{ groupId: string }>,
): Promise<void> {
  const authSession = await readStrictReadAuthSession(req, deps);
  if (!authSession) {
    return;
  }

  const snapshot = await deps.getGroupStateService().readSnapshot(ref);
  if (!snapshot) {
    throw new Error(`Group not found: ${ref.groupId}`);
  }

  assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

async function assertCanReadGroupState(
  req: {
    header(name: string): string | undefined;
  },
  deps: Required<GroupStateRouteDependencies>,
  snapshot: GroupSnapshot,
): Promise<void> {
  const authSession = await readStrictReadAuthSession(req, deps);
  if (!authSession) {
    return;
  }

  assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

function assertCanReadGroupSnapshot(
  principalId: string,
  snapshot: GroupSnapshot,
): void {
  const result = canReadFullGroupSnapshot({
    snapshot,
    actor: { principalId },
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }
}

async function readStrictReadAuthSession(
  req: {
    header(name: string): string | undefined;
  },
  deps: Required<GroupStateRouteDependencies>,
): Promise<GroupStateRouteAuthSession | undefined> {
  return isStrictReadAuthEnabled() ? await deps.requireApiAuthSession(req) : undefined;
}

function isStrictReadAuthEnabled(): boolean {
  const value = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  if (value === undefined || value.trim() === '') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function hydrateGroupSnapshots(
  deps: Required<GroupStateRouteDependencies>,
  groups: readonly GroupSnapshot[],
): void {
  if (groups.length === 0) {
    return;
  }

  void deps.hydrateStateSyncSnapshotCaches({ groups })
    .catch((error) => console.warn('Failed to hydrate group state sync snapshot caches', error));
}

async function defaultProcessGroupAppInbox<V, R>(
  enqueue: AppInboxEnqueueInput<V>,
): Promise<R> {
  const result = await getMiddleware().appGroupInboxService.processEntryUntilCompletion<V, R>(
    enqueue,
  );

  return result.fold(
    (error) => {
      const denial = readAppInboxPolicyDenial(error);
      if (denial) {
        throw new GroupPolicyDeniedError(denial);
      }
      throw new Error(error);
    },
    (value) => value,
  );
}

function readAppInboxPolicyDenial(value: string): GroupPolicyDenied | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const code = parsed.code;
    const message = parsed.message;
    if (
      typeof code !== 'string' ||
      !GROUP_POLICY_REASON_CODE_SET.has(code) ||
      typeof message !== 'string'
    ) {
      return undefined;
    }

    return {
      allowed: false,
      code: code as GroupPolicyReasonCode,
      message,
      details: isRecord(parsed.details) ? parsed.details : undefined,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readRequestWithRequestId<T extends { requestId?: string }>(c: {
  req: {
    json(): Promise<unknown>;
    header(name: string): string | undefined;
  };
}): Promise<T & { requestId: string }> {
  const requestBody = (await c.req.json()) as T;
  const requestId = requestBody.requestId ??
    c.req.header('Idempotency-Key') ??
    crypto.randomUUID();

  return {
    ...requestBody,
    requestId,
  };
}

function unwrapGroupStateWritten(written: GroupStateWritten): GroupMutationWritten {
  const mutation = written.result.right;
  if (!mutation) {
    throw new Error(written.result.left ?? 'Client mutation failed');
  }

  return mutation;
}

function unwrapGroupJoinCodeWritten(written: GroupJoinCodeWritten) {
  const mutation = written.result.right;
  if (!mutation) {
    throw new Error(written.result.left ?? 'Group join code rotation failed');
  }

  const { event: _event, ...response } = mutation;
  return response;
}

function toGroupAppInboxContextId(scope: StateScope, groupId: string): string {
  return [scope.applicationId, scope.workspaceId, groupId]
    .map(encodeURIComponent)
    .join(':');
}

function toScope(c: {
  req: {
    param(key: 'applicationId' | 'workspaceId'): string;
  };
}): StateScope {
  return {
    applicationId: c.req.param('applicationId'),
    workspaceId: c.req.param('workspaceId'),
  };
}

function toErrorResponse(
  c: {
    json(value: unknown, status?: number): Response;
  },
  error: unknown,
): Response {
  if (isGroupPolicyDeniedError(error)) {
    return c.json(
      {
        error: error.message,
        code: error.denial.code,
        message: error.denial.message,
        details: error.denial.details,
      },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : message.includes('already exists')
    ? 409
    : 400;

  return c.json({ error: message }, status);
}

function withActor<
  T extends {
    actorPrincipalId?: string;
    actorSessionId?: string;
  },
>(
  request: T,
  authSession: {
    clientId: string;
    sessionId: string;
  },
): T {
  return {
    ...request,
    actorPrincipalId: authSession.clientId,
    actorSessionId: authSession.sessionId,
  };
}

function withActorAndCreator(
  request: CreateGroupRequest,
  authSession: {
    clientId: string;
    sessionId: string;
  },
): CreateGroupRequest {
  return {
    ...request,
    createdByPrincipalId: authSession.clientId,
    actorPrincipalId: authSession.clientId,
    actorSessionId: authSession.sessionId,
  };
}

function assertSelfPrincipal(clientId: string, principalId: string): void {
  if (clientId !== principalId) {
    throw new Error(
      'Forbidden: principal id does not match authenticated client',
    );
  }
}

function assertSelfSession(
  authSession: {
    clientId: string;
    sessionId: string;
  },
  sessionId: string,
): void {
  if (authSession.sessionId !== sessionId) {
    throw new Error(
      'Forbidden: session id does not match authenticated session',
    );
  }
}

function assertSelfServiceMemberStatus(
  status: UpsertGroupMemberRequest['status'],
): void {
  if (status !== 'active' && status !== 'left') {
    throw new Error(
      'Forbidden: self-service membership changes only support active/left',
    );
  }
}

async function assertCanUpdateGroup(
  principalId: string,
  scope: StateScope,
  groupId: string,
  service: GroupStateRouteService,
): Promise<void> {
  const snapshot = await service.readSnapshot({
    ...scope,
    groupId,
  });
  if (!snapshot) {
    throw new Error(`Group not found: ${groupId}`);
  }

  const result = canUpdateGroupSnapshot({
    snapshot,
    actor: { principalId },
  });
  if (result.allowed) {
    return;
  }

  if (result.code === 'member-not-active') {
    throw new Error(
      'Forbidden: only active group owners/admins can update groups',
    );
  }

  if (result.code === 'forbidden-role') {
    throw new Error('Forbidden: only group owners/admins can update groups');
  }

  throw new GroupPolicyDeniedError(result);
}
