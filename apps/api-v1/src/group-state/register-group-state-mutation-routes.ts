import { requireGuestBookingApplication } from './guests/register-guest-booking-routes.ts';
import { requireRoomParticipantSession } from './group-state-route-authorization.ts';
import type { Hono } from 'hono';

import type { AppointGroupDirectorRequest, CreateGroupRequest, UpdateGroupRequest } from '@shared/api/state-types.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
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
                const request = await readGroupStateRouteRequest<CreateGroupRequest>(context);
                if (request.guestBooking) requireGuestBookingApplication(dependencies, scope.applicationId);
                const written = toGroupStateResponse({
                    kind: 'mutation',
                    written: await dependencies.processGroupAppInbox(
                        authSession,
                        toGroupStateCommand({
                            operation: 'create-group',
                            authSession,
                            scope,
                            traceId: readApiRequestTraceId(context),
                            request
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
                const authSession = await requireRoomParticipantSession({ request: context.req, roomRef: { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId') }, dependencies });
                const scope = toGroupStateRouteScope(context);
                const groupId = context.req.param('groupId');
                const request = await readGroupStateRouteRequest<UpdateGroupRequest>(context);
                await authorization.assertCanUpdateGroup(authSession.clientId, { ...scope, groupId }, request);
                const written = toGroupStateResponse({
                    kind: 'mutation',
                    written: await dependencies.processGroupAppInbox(
                        authSession,
                        toGroupStateCommand({
                            operation: 'update-group',
                            authSession,
                            scope,
                            traceId: readApiRequestTraceId(context),
                            groupId,
                            request
                        })
                    )
                });
                const response = request.roomLobby?.operation === 'release' || request.roomLobby?.operation === 'wait'
                    ? { roomRef: { ...scope, groupId } }
                    : written.snapshot;
                return context.json(response);
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
                const authSession = await requireRoomParticipantSession({ request: context.req, roomRef: { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId') }, dependencies });
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
                            traceId: readApiRequestTraceId(context),
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
