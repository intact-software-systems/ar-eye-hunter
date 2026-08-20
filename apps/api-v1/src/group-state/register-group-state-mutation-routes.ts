import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  AppointGroupDirectorRequest,
  CreateGroupRequest,
  MutationActorInput,
  UpdateGroupRequest,
} from '@shared/api/state-types.ts';
import { type GroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import {
  type GroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

export function registerGroupStateMutationRoutes(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  registerCreateGroupRoute(app, dependencies);
  registerUpdateGroupRoute(app, dependencies, authorization);
  registerAppointGroupDirectorRoute(app, dependencies);
  registerStartGroupEstablishmentRoute(app, dependencies);
  registerActivateGroupRoute(app, dependencies);
  registerReopenGroupEstablishmentRoute(app, dependencies);
}

function registerStartGroupEstablishmentRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/lifecycle/establish',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
            authSession,
            toGroupStateCommand({
              operation: 'start-group-establishment',
              authSession,
              scope: toGroupStateRouteScope(context),
              groupId: context.req.param('groupId'),
              request: await readGroupStateRouteRequest<MutationActorInput>(context),
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

function registerActivateGroupRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/lifecycle/activate',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
            authSession,
            toGroupStateCommand({
              operation: 'activate-group',
              authSession,
              scope: toGroupStateRouteScope(context),
              groupId: context.req.param('groupId'),
              request: await readGroupStateRouteRequest<MutationActorInput>(context),
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

function registerReopenGroupEstablishmentRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/lifecycle/reopen',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
            authSession,
            toGroupStateCommand({
              operation: 'reopen-group-establishment',
              authSession,
              scope: toGroupStateRouteScope(context),
              groupId: context.req.param('groupId'),
              request: await readGroupStateRouteRequest<MutationActorInput>(context),
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

function registerCreateGroupRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
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
  dependencies: GroupStateRouteDependencies,
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
          written: await dependencies.processGroupAppInbox(
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
  dependencies: GroupStateRouteDependencies,
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
          written: await dependencies.processGroupAppInbox(
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
