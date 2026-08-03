import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  AppointGroupDirectorRequest,
  CreateGroupRequest,
  UpdateGroupRequest,
} from '@shared/api/state-types.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type {
  GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';

import { type GroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import {
  type ResolvedGroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

type GroupStateRouteCommandPayload = AuthenticatedGroupMutationEnqueue['data'];

export function registerGroupStateMutationRoutes(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  registerCreateGroupRoute(app, dependencies);
  registerUpdateGroupRoute(app, dependencies, authorization);
  registerAppointGroupDirectorRoute(app, dependencies);
}

function registerCreateGroupRoute(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'create-group',
              authSession,
              scope,
              request: await readGroupStateRouteRequest<CreateGroupRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot, 201);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerUpdateGroupRoute(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        await authorization.assertCanUpdateGroup(authSession.clientId, { ...scope, groupId });
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupStateWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'update-group',
              authSession,
              scope,
              groupId,
              request: await readGroupStateRouteRequest<UpdateGroupRequest>(context),
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

function registerAppointGroupDirectorRoute(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/director/appoint',
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
              operation: 'appoint-group-director',
              authSession,
              scope,
              groupId,
              request: await readGroupStateRouteRequest<AppointGroupDirectorRequest>(context),
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
