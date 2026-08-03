import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  ConnectGroupPresenceSessionRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
} from '@shared/api/state-types.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type {
  GroupMutationReceipt,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

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

const GROUP_PRESENCE_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId';

export function registerGroupPresenceRoutes(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.put(
    GROUP_PRESENCE_PATH,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const sessionId = context.req.param('sessionId');
        authorization.assertSelfSession(authSession, sessionId);
        const receipt = await dependencies.processGroupAppInbox<
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
            request: await readGroupStateRouteRequest<ConnectGroupPresenceSessionRequest>(
              context,
            ),
          }),
        );
        return context.json(
          await toGroupStateResponse({
            kind: 'presence',
            receipt,
            ref: { ...scope, groupId },
            service: dependencies.getGroupStateService(),
          }),
        );
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );

  app.post(
    `${GROUP_PRESENCE_PATH}/heartbeat`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const sessionId = context.req.param('sessionId');
        authorization.assertSelfSession(authSession, sessionId);
        const receipt = await dependencies.processGroupAppInbox<
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
            request: await readGroupStateRouteRequest<HeartbeatGroupPresenceSessionRequest>(
              context,
            ),
          }),
        );
        return context.json(
          await toGroupStateResponse({
            kind: 'presence',
            receipt,
            ref: { ...scope, groupId },
            service: dependencies.getGroupStateService(),
          }),
        );
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );

  app.post(
    `${GROUP_PRESENCE_PATH}/disconnect`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const sessionId = context.req.param('sessionId');
        authorization.assertSelfSession(authSession, sessionId);
        const receipt = await dependencies.processGroupAppInbox<
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
            request: await readGroupStateRouteRequest<DisconnectGroupPresenceSessionRequest>(
              context,
            ),
          }),
        );
        return context.json(
          await toGroupStateResponse({
            kind: 'presence',
            receipt,
            ref: { ...scope, groupId },
            service: dependencies.getGroupStateService(),
          }),
        );
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}
