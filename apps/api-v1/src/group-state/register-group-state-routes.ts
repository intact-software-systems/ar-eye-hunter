import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { createGroupStateRouteDependencies } from './create-group-state-route-dependencies.ts';
import { createGroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import type { GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { registerGroupAdmissionRoutes } from './register-group-admission-routes.ts';
import { registerGroupMembershipRoutes } from './register-group-membership-routes.ts';
import { registerGroupPresenceRoutes } from './register-group-presence-routes.ts';
import { registerGroupStateMutationRoutes } from './register-group-state-mutation-routes.ts';
import { registerGroupStateReadRoutes } from './register-group-state-read-routes.ts';

export function registerGroupStateRoutes(
  app: Hono,
  dependencies: GroupStateRouteDependencies = {},
): void {
  const resolvedDependencies = createGroupStateRouteDependencies(dependencies);
  const authorization = createGroupStateRouteAuthorization(resolvedDependencies);

  registerGroupStateReadRoutes(app, resolvedDependencies, authorization);
  registerGroupStateMutationRoutes(app, resolvedDependencies, authorization);
  registerGroupAdmissionRoutes(app, resolvedDependencies);
  registerGroupMembershipRoutes(app, resolvedDependencies, authorization);
  registerGroupPresenceRoutes(app, resolvedDependencies, authorization);
}
