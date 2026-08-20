import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  BanGroupMemberRequest,
  RemoveGroupMemberRequest,
  SetGroupMemberRoleRequest,
  TransferGroupOwnershipRequest,
  UnbanGroupMemberRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type {
  GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';

import { requireGroupAdmissionQuota } from '../services/group-admission-rate-limit.ts';
import { type GroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import {
  type GroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toPendingMemberGroupSnapshot } from '@shared/api/group-client-views.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

type GroupStateRouteCommandPayload = AuthenticatedGroupMutationEnqueue['data'];
const GROUP_MEMBER_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId';

export function registerGroupMembershipRoutes(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  registerRemoveGroupMemberRoute(app, dependencies);
  registerBanGroupMemberRoute(app, dependencies);
  registerUnbanGroupMemberRoute(app, dependencies);
  registerSetGroupMemberRoleRoute(app, dependencies);
  registerTransferGroupOwnershipRoute(app, dependencies);
  registerUpsertSelfGroupMemberRoute(app, dependencies, authorization);
}

function registerRemoveGroupMemberRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    `${GROUP_MEMBER_PATH}/remove`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const principalId = context.req.param('principalId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
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
              request: await readGroupStateRouteRequest<RemoveGroupMemberRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerBanGroupMemberRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    `${GROUP_MEMBER_PATH}/ban`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const principalId = context.req.param('principalId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
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
              request: await readGroupStateRouteRequest<BanGroupMemberRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerUnbanGroupMemberRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    `${GROUP_MEMBER_PATH}/unban`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const principalId = context.req.param('principalId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
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
              request: await readGroupStateRouteRequest<UnbanGroupMemberRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerSetGroupMemberRoleRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.put(
    `${GROUP_MEMBER_PATH}/role`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const principalId = context.req.param('principalId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
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
              request: await readGroupStateRouteRequest<SetGroupMemberRoleRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerTransferGroupOwnershipRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/owner/transfer',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'transfer-group-ownership',
              authSession,
              scope,
              groupId,
              request: await readGroupStateRouteRequest<TransferGroupOwnershipRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerUpsertSelfGroupMemberRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.put(
    GROUP_MEMBER_PATH,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const { groupId, principalId } = context.req.param();
        requireGroupAdmissionQuota('join-admission', { ...scope, groupId }, authSession.clientId);
        authorization.assertSelfPrincipal(authSession.clientId, principalId);
        const request = await readGroupStateRouteRequest<UpsertGroupMemberRequest>(context);
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
          written: await dependencies.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(authSession, command),
        });
        const body = toPendingMemberGroupSnapshot(written.snapshot, authSession.clientId);
        return context.json(body);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}
