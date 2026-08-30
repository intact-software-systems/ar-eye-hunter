import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type { AppointGroupDirectorRequest, CreateGroupRequest, UpdateGroupRequest } from '@shared/api/state-types.ts';
import { type GroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

const GROUP_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId';

export function registerGroupStateMutationRoutes(
    app: Hono,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): void {
    registerCreateGroupRoute(app, dependencies);
    registerUpdateGroupRoute(app, dependencies, authorization);
    registerAppointGroupDirectorRoute(app, dependencies);
}

function registerCreateGroupRoute(
    app: Hono,
    dependencies: GroupStateRouteDependencies
): void {
    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/requests/:requestId',
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
                            request: await readGroupStateRouteRequest<CreateGroupRequest>(context)
                        })
                    )
                });

                return context.json(written.snapshot, 201);
            }
            catch (error) {
                return toGroupMutationErrorResponse(context, error);
            }
        }
    );
}

function registerUpdateGroupRoute(
    app: Hono,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): void {
    app.put(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/requests/:requestId',
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
                            request: await readGroupStateRouteRequest<UpdateGroupRequest>(context)
                        })
                    )
                });
                return context.json(written.snapshot);
            }
            catch (error) {
                return toGroupMutationErrorResponse(context, error);
            }
        }
    );
}

function registerAppointGroupDirectorRoute(
    app: Hono,
    dependencies: GroupStateRouteDependencies
): void {
    app.post(
        `${GROUP_PATH}/director/appoint/requests/:requestId`,
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
                            request: await readGroupStateRouteRequest<AppointGroupDirectorRequest>(context)
                        })
                    )
                });

                return context.json(written.snapshot);
            }
            catch (error) {
                return toGroupMutationErrorResponse(context, error);
            }
        }
    );
}
