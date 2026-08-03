import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  AcceptGroupInviteRequest,
  CreateGroupInviteRequest,
  JoinGroupRequest,
  RevokeGroupInviteRequest,
  RotateGroupJoinCodeRequest,
} from '@shared/api/state-types.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type {
  GroupJoinCodeWritten,
  GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';

import {
  type ResolvedGroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

type GroupStateRouteCommandPayload = AuthenticatedGroupMutationEnqueue['data'];
const GROUP_INVITE_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId';

export function registerGroupAdmissionRoutes(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join',
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
              operation: 'join-group',
              authSession,
              scope,
              groupId,
              request: await readGroupStateRouteRequest<JoinGroupRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/accept',
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
              operation: 'accept-group-invite',
              authSession,
              scope,
              groupId,
              request: await readGroupStateRouteRequest<AcceptGroupInviteRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join-code/rotate',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const response = toGroupStateResponse({
          kind: 'join-code',
          written: await dependencies.processGroupAppInbox<
            GroupStateRouteCommandPayload,
            GroupJoinCodeWritten
          >(
            authSession,
            toGroupStateCommand({
              operation: 'rotate-group-join-code',
              authSession,
              scope,
              groupId,
              request: await readGroupStateRouteRequest<RotateGroupJoinCodeRequest>(context),
            }),
          ),
        });

        return context.json(response);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId',
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
              operation: 'create-group-invite',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readGroupStateRouteRequest<CreateGroupInviteRequest>(context),
            }),
          ),
        });

        return context.json(written.snapshot);
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );

  app.post(
    `${GROUP_INVITE_PATH}/revoke`,
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
              operation: 'revoke-group-invite',
              authSession,
              scope,
              groupId,
              principalId,
              request: await readGroupStateRouteRequest<RevokeGroupInviteRequest>(context),
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
