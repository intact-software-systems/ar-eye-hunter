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
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
  type GroupMutationReceipt,
  validateGroupMutationRequest,
  validateGroupPresenceMutationRequest,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  createGroupStateRouteDependencies,
} from '../group-state/create-group-state-route-dependencies.ts';
import {
  type GroupStateRouteAuthSession,
  type GroupStateRouteDependencies,
  type GroupStateRouteService,
  type ProcessGroupAppInbox,
  toGroupStateRouteScope as toScope,
} from '../group-state/group-state-route-contracts.ts';
import {
  createGroupStateRouteAuthorization,
} from '../group-state/group-state-route-authorization.ts';
import {
  toGroupStateErrorResponse as toErrorResponse,
} from '../group-state/group-state-route-errors.ts';
import {
  readGroupStateRouteRequest as readRequestWithRequestId,
} from '../group-state/read-group-state-route-request.ts';
import { registerGroupStateReadRoutes } from '../group-state/register-group-state-read-routes.ts';

export { toGroupAppInboxError } from '../group-state/group-state-route-errors.ts';
export type {
  GroupStateRouteAuthSession,
  GroupStateRouteDependencies,
  GroupStateRouteService,
  ProcessGroupAppInbox,
} from '../group-state/group-state-route-contracts.ts';

export function init(
  app: Hono,
  dependencies: GroupStateRouteDependencies = {},
): void {
  const deps = createGroupStateRouteDependencies(dependencies);
  const authorization = createGroupStateRouteAuthorization(deps);
  registerGroupStateReadRoutes(app, deps, authorization);

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const requestBody = await readRequestWithRequestId<CreateGroupRequest>(c);
        const request = validatedGroupMutationRequest(
          'createGroup',
          withActorAndCreator(requestBody, authSession),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupCreateAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        await authorization.assertCanUpdateGroup(authSession.clientId, {
          ...scope,
          groupId,
        });
        const request = validatedGroupMutationRequest(
          'updateGroup',
          withActor(
            await readRequestWithRequestId<UpdateGroupRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'appointDirector',
          withActor(
            await readRequestWithRequestId<AppointGroupDirectorRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupDirectorAppointAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'joinGroup',
          withActor(
            await readRequestWithRequestId<JoinGroupRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupJoinAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'acceptGroupInvite',
          withActor(
            await readRequestWithRequestId<AcceptGroupInviteRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupInviteAcceptAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'rotateGroupJoinCode',
          withActor(
            await readRequestWithRequestId<RotateGroupJoinCodeRequest>(c),
            authSession,
          ),
        );
        const response = unwrapGroupJoinCodeWritten(
          await deps.processGroupAppInbox<
            GroupJoinCodeRotateAppInboxPayload,
            GroupJoinCodeWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'createGroupInvite',
          withActor(
            await readRequestWithRequestId<CreateGroupInviteRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupInviteCreateAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'revokeGroupInvite',
          withActor(
            await readRequestWithRequestId<RevokeGroupInviteRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupInviteRevokeAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'removeGroupMember',
          withActor(
            await readRequestWithRequestId<RemoveGroupMemberRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberRemoveAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'banGroupMember',
          withActor(
            await readRequestWithRequestId<BanGroupMemberRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberBanAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'unbanGroupMember',
          withActor(
            await readRequestWithRequestId<UnbanGroupMemberRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberUnbanAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'setGroupMemberRole',
          withActor(
            await readRequestWithRequestId<SetGroupMemberRoleRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberRoleSetAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        const request = validatedGroupMutationRequest(
          'transferGroupOwnership',
          withActor(
            await readRequestWithRequestId<TransferGroupOwnershipRequest>(c),
            authSession,
          ),
        );
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupOwnershipTransferAppInboxPayload,
            GroupStateWritten
          >(authSession, {
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
        authorization.assertSelfPrincipal(authSession.clientId, principalId);
        const request = validatedGroupMutationRequest(
          'upsertMember',
          withActor(
            await readRequestWithRequestId<UpsertGroupMemberRequest>(c),
            authSession,
          ),
        );
        authorization.assertSelfServiceMemberStatus(request.status);
        const { role: _ignoredRole, ...selfServiceRequest } = request;
        const written = unwrapGroupStateWritten(
          await deps.processGroupAppInbox<
            GroupMemberUpsertAppInboxPayload,
            GroupStateWritten
          >(authSession, {
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: request.requestId,
            contextId: toGroupAppInboxContextId(scope, groupId),
            senderId: authSession.clientId,
            data: {
              scope,
              groupId,
              principalId,
              request: selfServiceRequest,
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
        authorization.assertSelfSession(authSession, sessionId);
        const request = await readRequestWithRequestId<ConnectGroupPresenceSessionRequest>(c);
        validateGroupPresenceMutationRequest('connectPresence', request);
        const receipt = await deps.processGroupAppInbox<
          GroupPresenceConnectAppInboxPayload,
          GroupMutationReceipt
        >(authSession, {
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
        });
        return c.json(
          await readReceiptSnapshot(
            deps.getGroupStateService(),
            { ...scope, groupId },
            receipt,
          ),
        );
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
        authorization.assertSelfSession(authSession, sessionId);
        const request = await readRequestWithRequestId<HeartbeatGroupPresenceSessionRequest>(
          c,
        );
        validateGroupPresenceMutationRequest('heartbeatPresence', request);
        const receipt = await deps.processGroupAppInbox<
          GroupPresenceHeartbeatAppInboxPayload,
          GroupMutationReceipt
        >(authSession, {
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
        });
        return c.json(
          await readReceiptSnapshot(
            deps.getGroupStateService(),
            { ...scope, groupId },
            receipt,
          ),
        );
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
        authorization.assertSelfSession(authSession, sessionId);
        const request = await readRequestWithRequestId<DisconnectGroupPresenceSessionRequest>(
          c,
        );
        validateGroupPresenceMutationRequest('disconnectPresence', request);
        const receipt = await deps.processGroupAppInbox<
          GroupPresenceDisconnectAppInboxPayload,
          GroupMutationReceipt
        >(authSession, {
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
        });
        return c.json(
          await readReceiptSnapshot(
            deps.getGroupStateService(),
            { ...scope, groupId },
            receipt,
          ),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );
}

function validatedGroupMutationRequest<T>(
  operation: Parameters<typeof validateGroupMutationRequest>[0],
  request: T,
): T {
  validateGroupMutationRequest(operation, request);
  return request;
}

async function readReceiptSnapshot(
  service: GroupStateRouteService,
  ref: GroupRef,
  receipt: GroupMutationReceipt,
): Promise<GroupSnapshot> {
  if (receipt.outcome === 'rejected') {
    throw new Error(receipt.rejection ?? 'Group presence mutation rejected');
  }
  const snapshot = await service.readCurrentSnapshot(ref);
  if (!snapshot) {
    throw new Error(`Group snapshot not found after mutation: ${ref.groupId}`);
  }
  return snapshot;
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
