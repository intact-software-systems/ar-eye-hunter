import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  AcceptGroupInviteRequest,
  CreateGroupInviteRequest,
  JoinGroupRequest,
  MutationActorInput,
  RevokeGroupInviteRequest,
  RotateGroupJoinCodeRequest,
} from '@shared/api/state-types.ts';
import { toPendingMemberGroupSnapshot } from '@shared/api/group-client-views.ts';
import { requireGroupAdmissionQuota } from '../services/group-admission-rate-limit.ts';
import {
  type GroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

const GROUP_INVITE_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId';
const GROUP_ADMISSION_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/admissions/:principalId';

export function registerGroupAdmissionRoutes(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  registerJoinGroupRoute(app, dependencies);
  registerAcceptGroupInviteRoute(app, dependencies);
  registerRotateGroupJoinCodeRoute(app, dependencies);
  registerCreateGroupInviteRoute(app, dependencies);
  registerRevokeGroupInviteRoute(app, dependencies);
  registerGrantGroupAdmissionRoute(app, dependencies);
  registerDeclineGroupAdmissionRoute(app, dependencies);
}

function registerJoinGroupRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        requireGroupAdmissionQuota('join-admission', { ...scope, groupId }, authSession.clientId);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
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

        return context.json(
          toPendingMemberGroupSnapshot(written.snapshot, authSession.clientId),
        );
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerAcceptGroupInviteRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/accept',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        requireGroupAdmissionQuota('join-admission', { ...scope, groupId }, authSession.clientId);
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
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

        return context.json(
          toPendingMemberGroupSnapshot(written.snapshot, authSession.clientId),
        );
      } catch (error) {
        return toGroupStateErrorResponse(context, error);
      }
    },
  );
}

function registerRotateGroupJoinCodeRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join-code/rotate',
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const response = toGroupStateResponse({
          kind: 'join-code',
          written: await dependencies.processGroupAppInbox(
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
}

function registerCreateGroupInviteRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
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
          written: await dependencies.processGroupAppInbox(
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
}

function registerGrantGroupAdmissionRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    `${GROUP_ADMISSION_PATH}/grant`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const principalId = context.req.param('principalId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
            authSession,
            toGroupStateCommand({
              operation: 'grant-group-admission',
              authSession,
              scope,
              groupId,
              principalId,
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

function registerDeclineGroupAdmissionRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
  app.post(
    `${GROUP_ADMISSION_PATH}/decline`,
    async (context) => {
      try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const scope = toGroupStateRouteScope(context);
        const groupId = context.req.param('groupId');
        const principalId = context.req.param('principalId');
        const written = toGroupStateResponse({
          kind: 'mutation',
          written: await dependencies.processGroupAppInbox(
            authSession,
            toGroupStateCommand({
              operation: 'decline-group-admission',
              authSession,
              scope,
              groupId,
              principalId,
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

function registerRevokeGroupInviteRoute(
  app: Hono,
  dependencies: GroupStateRouteDependencies,
): void {
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
          written: await dependencies.processGroupAppInbox(
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
