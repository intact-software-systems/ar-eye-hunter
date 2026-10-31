import type { Hono } from 'jsr:@hono/hono@4.11.9';
import { registerGroupLifecycleRoutes } from './register-group-lifecycle-routes.ts';
import { registerGroupSessionRoutes } from './register-group-session-routes.ts';

import { createGroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import type { GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { registerGroupAdmissionRoutes } from './register-group-admission-routes.ts';
import { registerGroupMembershipRoutes } from './register-group-membership-routes.ts';
import { registerGroupMoveRoutes } from './register-group-move-routes.ts';
import { registerGroupPresenceRoutes } from './register-group-presence-routes.ts';
import { registerGroupPublicationRoutes } from './register-group-publication-routes.ts';
import { registerGroupQuickJoinRoute } from './register-group-quick-join-route.ts';
import { registerGroupStateMutationRoutes } from './register-group-state-mutation-routes.ts';
import { registerGroupStateReadRoutes } from './register-group-state-read-routes.ts';

export function registerGroupStateRoutes(
    app: Hono,
    dependencies: GroupStateRouteDependencies
): void {
    const authorization = createGroupStateRouteAuthorization(dependencies);

    registerGroupStateReadRoutes(app, dependencies, authorization);
    registerGroupQuickJoinRoute(app, dependencies);
    registerGroupMoveRoutes(app, dependencies);
    registerGroupSessionRoutes(app, dependencies);
    registerGroupStateMutationRoutes(app, dependencies, authorization);
    registerGroupLifecycleRoutes(app, dependencies);
    registerGroupAdmissionRoutes(app, dependencies);
    registerGroupMembershipRoutes(app, dependencies, authorization);
    registerGroupPresenceRoutes(app, dependencies, authorization);
    registerGroupPublicationRoutes(app, dependencies);
}
