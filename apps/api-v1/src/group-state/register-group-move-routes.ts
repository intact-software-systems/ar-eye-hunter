import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { GroupMutationAuthorizationError } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { decodeGroupMoveRequest } from '@shared-server/rallar-system/group-state/move/group-move-command.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { GroupMoveRequest } from '@shared/api/mutation/group-move.ts';

import { toApiMutationRouteFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';

export function registerGroupMoveRoutes(app: Hono, dependencies: GroupStateRouteDependencies): void {
    const path = '/api/state/apps/:applicationId/workspaces/:workspaceId/group-moves';
    app.get(path, async (context) => {
        try {
            const authority = await dependencies.requireApiAuthSession(context.req);
            return context.json(await dependencies.listGroupMoves(toGroupStateRouteScope(context), authority.clientId));
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
    app.post(`${path}/requests/:requestId`, async (context) => {
        try {
            const authority = await dependencies.requireApiAuthSession(context.req);
            const scope = toGroupStateRouteScope(context);
            const request = decodeGroupMoveRequest(await readGroupStateRouteRequest<GroupMoveRequest>(context));
            if (!isSameGroupScope(request.source, scope) || !isSameGroupScope(request.destination, scope)) {
                throw new GroupMutationAuthorizationError('Group move scope differs from the route');
            }
            if (request.action === 'propose' || request.action === 'commit') {
                dependencies.groupAdmissionQuota.require({
                    family: 'join-admission',
                    groupRef: request.destination,
                    principalId: authority.clientId
                });
            }
            const result = await dependencies.processGroupMove(
                { request, traceId: readApiRequestTraceId(context) },
                authority
            );
            return context.json(result.fold((failure) => {
                throw toApiMutationRouteFailure(failure);
            }, (move) => move));
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}
