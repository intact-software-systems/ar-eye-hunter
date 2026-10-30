import type { Hono } from 'jsr:@hono/hono@4.11.9';

import {
    decodeGrantGroupPublicationRequest,
    decodeRevokeGroupPublicationRequest
} from '@shared-server/rallar-system/group-state/mutation/publication/decode-group-publication-requests.ts';
import { formatRallarValidation } from '@shared/api/rallar-validation.ts';
import type { GrantGroupPublicationRequest, RevokeGroupPublicationRequest } from '@shared/api/state-types.ts';

import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

const GROUP_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId';

export function registerGroupPublicationRoutes(app: Hono, dependencies: GroupStateRouteDependencies): void {
    registerGrantGroupPublicationRoute(app, dependencies);
    registerRevokeGroupPublicationRoute(app, dependencies);
}

function registerGrantGroupPublicationRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(
        `${GROUP_PATH}/publication-grants/:principalId/grant/requests/:requestId`,
        async (context) => {
            try {
                const authSession = await dependencies.requireApiAuthSession(context.req);
                const request = decodeGrantGroupPublicationRequest(
                    await readGroupStateRouteRequest<GrantGroupPublicationRequest>(context)
                ).fold((issues) => {
                    throw new TypeError(formatRallarValidation(issues));
                }, (decoded) => decoded);
                const written = toGroupStateResponse({
                    kind: 'mutation',
                    written: await dependencies.processGroupAppInbox(
                        authSession,
                        toGroupStateCommand({
                            operation: 'grant-group-publication',
                            authSession,
                            scope: toGroupStateRouteScope(context),
                            traceId: readApiRequestTraceId(context),
                            groupId: context.req.param('groupId'),
                            principalId: context.req.param('principalId'),
                            request
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

function registerRevokeGroupPublicationRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(
        `${GROUP_PATH}/publication-grants/:principalId/revoke/requests/:requestId`,
        async (context) => {
            try {
                const authSession = await dependencies.requireApiAuthSession(context.req);
                const request = decodeRevokeGroupPublicationRequest(
                    await readGroupStateRouteRequest<RevokeGroupPublicationRequest>(context)
                ).fold((issues) => {
                    throw new TypeError(formatRallarValidation(issues));
                }, (decoded) => decoded);
                const written = toGroupStateResponse({
                    kind: 'mutation',
                    written: await dependencies.processGroupAppInbox(
                        authSession,
                        toGroupStateCommand({
                            operation: 'revoke-group-publication',
                            authSession,
                            scope: toGroupStateRouteScope(context),
                            traceId: readApiRequestTraceId(context),
                            groupId: context.req.param('groupId'),
                            principalId: context.req.param('principalId'),
                            request
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
