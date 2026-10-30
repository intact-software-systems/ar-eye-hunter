import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type { SubscribeGroupTopicRequest, UnsubscribeGroupTopicRequest } from '@shared/api/state-types.ts';

import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import type { GroupStateRouteAuthorization } from './group-state-route-authorization.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

const GROUP_SESSION_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId';

export function registerGroupTopicSubscriptionRoutes(
    app: Hono,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): void {
    registerSubscribeGroupTopicRoute(app, dependencies, authorization);
    registerUnsubscribeGroupTopicRoute(app, dependencies, authorization);
}

function registerSubscribeGroupTopicRoute(
    app: Hono,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): void {
    app.post(
        `${GROUP_SESSION_PATH}/subscribe/requests/:requestId`,
        async (context) => {
            try {
                const authSession = await dependencies.requireApiAuthSession(context.req);
                const sessionId = context.req.param('sessionId');
                authorization.assertSelfSession(authSession, sessionId);
                const receipt = await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'subscribe-group-topic',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        traceId: readApiRequestTraceId(context),
                        groupId: context.req.param('groupId'),
                        sessionId,
                        request: await readGroupStateRouteRequest<SubscribeGroupTopicRequest>(context)
                    })
                );
                return context.json(toGroupStateResponse({ kind: 'subscription', receipt }));
            }
            catch (error) {
                return toGroupMutationErrorResponse(context, error);
            }
        }
    );
}

function registerUnsubscribeGroupTopicRoute(
    app: Hono,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): void {
    app.post(
        `${GROUP_SESSION_PATH}/unsubscribe/requests/:requestId`,
        async (context) => {
            try {
                const authSession = await dependencies.requireApiAuthSession(context.req);
                const sessionId = context.req.param('sessionId');
                authorization.assertSelfSession(authSession, sessionId);
                const receipt = await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'unsubscribe-group-topic',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        traceId: readApiRequestTraceId(context),
                        groupId: context.req.param('groupId'),
                        sessionId,
                        request: await readGroupStateRouteRequest<UnsubscribeGroupTopicRequest>(context)
                    })
                );
                return context.json(toGroupStateResponse({ kind: 'subscription', receipt }));
            }
            catch (error) {
                return toGroupMutationErrorResponse(context, error);
            }
        }
    );
}
