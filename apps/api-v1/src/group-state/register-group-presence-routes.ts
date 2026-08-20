import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  ConnectGroupPresenceSessionRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
} from '@shared/api/state-types.ts';
import { requireGroupAdmissionQuota } from '../services/group-admission-rate-limit.ts';
import { type GroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import {
  type GroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

const GROUP_PRESENCE_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId';

export function registerGroupPresenceRoutes(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  registerConnectGroupPresenceRoute(app, dependencies, authorization);
  registerHeartbeatGroupPresenceRoute(app, dependencies, authorization);
  registerDisconnectGroupPresenceRoute(app, dependencies, authorization);
}

function registerConnectGroupPresenceRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.put(
    GROUP_PRESENCE_PATH,
    (context) => handleConnectGroupPresenceRoute(context, dependencies, authorization),
  );
}

function registerHeartbeatGroupPresenceRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.post(
    `${GROUP_PRESENCE_PATH}/heartbeat`,
    (context) => handleHeartbeatGroupPresenceRoute(context, dependencies, authorization),
  );
}

function registerDisconnectGroupPresenceRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.post(
    `${GROUP_PRESENCE_PATH}/disconnect`,
    (context) => handleDisconnectGroupPresenceRoute(context, dependencies, authorization),
  );
}

async function handleConnectGroupPresenceRoute(
  context: Context,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const scope = toGroupStateRouteScope(context);
    const groupId = context.req.param('groupId');
    const sessionId = context.req.param('sessionId');
    requireGroupAdmissionQuota(
      'presence-connect',
      { ...scope, groupId },
      authSession.clientId,
    );
    authorization.assertSelfSession(authSession, sessionId);
    const receipt = await dependencies.processGroupAppInbox(
      authSession,
      toGroupStateCommand({
        operation: 'connect-group-presence',
        authSession,
        scope,
        groupId,
        sessionId,
        request: await readGroupStateRouteRequest<ConnectGroupPresenceSessionRequest>(context),
      }),
    );
    return context.json(
      await toGroupStateResponse({
        kind: 'presence',
        receipt,
        ref: { ...scope, groupId },
        service: dependencies.groupStateService,
      }),
    );
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}

async function handleHeartbeatGroupPresenceRoute(
  context: Context,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const scope = toGroupStateRouteScope(context);
    const groupId = context.req.param('groupId');
    const sessionId = context.req.param('sessionId');
    authorization.assertSelfSession(authSession, sessionId);
    const receipt = await dependencies.processGroupAppInbox(
      authSession,
      toGroupStateCommand({
        operation: 'heartbeat-group-presence',
        authSession,
        scope,
        groupId,
        sessionId,
        request: await readGroupStateRouteRequest<HeartbeatGroupPresenceSessionRequest>(context),
      }),
    );
    return context.json(
      await toGroupStateResponse({
        kind: 'presence',
        receipt,
        ref: { ...scope, groupId },
        service: dependencies.groupStateService,
      }),
    );
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}

async function handleDisconnectGroupPresenceRoute(
  context: Context,
  dependencies: GroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const scope = toGroupStateRouteScope(context);
    const groupId = context.req.param('groupId');
    const sessionId = context.req.param('sessionId');
    authorization.assertSelfSession(authSession, sessionId);
    const receipt = await dependencies.processGroupAppInbox(
      authSession,
      toGroupStateCommand({
        operation: 'disconnect-group-presence',
        authSession,
        scope,
        groupId,
        sessionId,
        request: await readGroupStateRouteRequest<DisconnectGroupPresenceSessionRequest>(context),
      }),
    );
    return context.json(
      await toGroupStateResponse({
        kind: 'presence',
        receipt,
        ref: { ...scope, groupId },
        service: dependencies.groupStateService,
      }),
    );
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}
