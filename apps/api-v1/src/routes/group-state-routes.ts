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
  TransferGroupOwnershipRequest,
  UnbanGroupMemberRequest,
  UpdateGroupRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import type {
  GroupJoinCodeWritten,
  GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
  type GroupMutationReceipt,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  createGroupStateRouteDependencies,
} from '../group-state/create-group-state-route-dependencies.ts';
import {
  type GroupStateRouteDependencies,
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
import { toGroupStateCommand } from '../group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../group-state/to-group-state-response.ts';

export { toGroupAppInboxError } from '../group-state/group-state-route-errors.ts';
export type {
  GroupStateRouteAuthSession,
  GroupStateRouteDependencies,
  GroupStateRouteService,
  ProcessGroupAppInbox,
} from '../group-state/group-state-route-contracts.ts';

type GroupStateRouteCommandPayload = AuthenticatedGroupMutationEnqueue['data'];

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'create-group',
              authSession,
              scope,
              request: await readRequestWithRequestId<CreateGroupRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'update-group',
              authSession,
              scope,
              groupId,
              request: await readRequestWithRequestId<UpdateGroupRequest>(c),
            }),
          ),
        });
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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'appoint-group-director',
              authSession,
              scope,
              groupId,
              request: await readRequestWithRequestId<AppointGroupDirectorRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'join-group',
              authSession,
              scope,
              groupId,
              request: await readRequestWithRequestId<JoinGroupRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'accept-group-invite',
              authSession,
              scope,
              groupId,
              request: await readRequestWithRequestId<AcceptGroupInviteRequest>(c),
            }),
          ),
        });

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
        const response = toGroupStateResponse({
          kind: 'join-code',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupJoinCodeWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'rotate-group-join-code',
              authSession,
              scope,
              groupId,
              request: await readRequestWithRequestId<RotateGroupJoinCodeRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'create-group-invite',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readRequestWithRequestId<CreateGroupInviteRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'revoke-group-invite',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readRequestWithRequestId<RevokeGroupInviteRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'remove-group-member',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readRequestWithRequestId<RemoveGroupMemberRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'ban-group-member',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readRequestWithRequestId<BanGroupMemberRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'unban-group-member',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readRequestWithRequestId<UnbanGroupMemberRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'set-group-member-role',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readRequestWithRequestId<SetGroupMemberRoleRequest>(c),
            }),
          ),
        });

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
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'transfer-group-ownership',
              authSession,
              scope,
              groupId,
              request: await readRequestWithRequestId<TransferGroupOwnershipRequest>(c),
            }),
          ),
        });

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
        const request = await readRequestWithRequestId<UpsertGroupMemberRequest>(c);
        const command = toGroupStateCommand({
          operation: 'upsert-group-member',
          authSession,
          scope,
          groupId,
          principalId,
          request,
        });
        authorization.assertSelfServiceMemberStatus(request.status);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await deps.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(authSession, command),
        });
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
        const receipt = await deps.processGroupAppInbox<
          GroupStateRouteCommandPayload,
          GroupMutationReceipt
        >(
          authSession,
          toGroupStateCommand({
            operation: 'connect-group-presence',
            authSession,
            scope,
            groupId,
            sessionId,
            request: await readRequestWithRequestId<ConnectGroupPresenceSessionRequest>(c),
          }),
        );
        return c.json(
          await toGroupStateResponse({
            kind: 'presence',
            receipt,
            ref: { ...scope, groupId },
            service: deps.getGroupStateService(),
          }),
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
        const receipt = await deps.processGroupAppInbox<
          GroupStateRouteCommandPayload,
          GroupMutationReceipt
        >(
          authSession,
          toGroupStateCommand({
            operation: 'heartbeat-group-presence',
            authSession,
            scope,
            groupId,
            sessionId,
            request: await readRequestWithRequestId<HeartbeatGroupPresenceSessionRequest>(c),
          }),
        );
        return c.json(
          await toGroupStateResponse({
            kind: 'presence',
            receipt,
            ref: { ...scope, groupId },
            service: deps.getGroupStateService(),
          }),
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
        const receipt = await deps.processGroupAppInbox<
          GroupStateRouteCommandPayload,
          GroupMutationReceipt
        >(
          authSession,
          toGroupStateCommand({
            operation: 'disconnect-group-presence',
            authSession,
            scope,
            groupId,
            sessionId,
            request: await readRequestWithRequestId<DisconnectGroupPresenceSessionRequest>(c),
          }),
        );
        return c.json(
          await toGroupStateResponse({
            kind: 'presence',
            receipt,
            ref: { ...scope, groupId },
            service: deps.getGroupStateService(),
          }),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );
}
