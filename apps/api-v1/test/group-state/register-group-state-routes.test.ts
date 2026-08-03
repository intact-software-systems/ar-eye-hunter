import assert from 'node:assert/strict';

import { createGroupStateRouteTestRuntime } from './group-state-route-test-runtime.ts';

Deno.test('group state route registration retains all 21 Hono handlers in predecessor order', () => {
  const runtime = createGroupStateRouteTestRuntime({ installStateAuthentication: false });
  const registeredRoutes = (runtime.app as unknown as {
    readonly routes: readonly { readonly method: string; readonly path: string }[];
  }).routes.map((route) => `${route.method} ${route.path}`);

  assert.deepEqual(registeredRoutes, [
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events',
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events/page',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/director/appoint',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/accept',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join-code/rotate',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId/revoke',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/remove',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/ban',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/unban',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/role',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/owner/transfer',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/heartbeat',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/disconnect',
  ]);
});
