import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { decodeQuickJoinGroupRequest } from '@shared-server/rallar-system/group-state/quick-join/group-quick-join-codec.ts';
import type { QuickJoinGroupRequest } from '@shared/api/mutation/group-quick-join.ts';

import { toApiMutationRouteFailure } from '../routes/api-mutation-route-failure.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';

export function registerGroupQuickJoinRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/quick-join/requests/:requestId',
        async (context) => {
            try {
                const authority = await dependencies.requireApiAuthSession(context.req);
                const scope = toGroupStateRouteScope(context);
                const request = decodeQuickJoinGroupRequest(
                    await readGroupStateRouteRequest<QuickJoinGroupRequest>(context)
                );
                dependencies.groupAdmissionQuota.require({
                    family: 'quick-join',
                    scope,
                    principalId: authority.clientId
                });
                const result = await dependencies.processQuickJoin({ scope, request }, authority);
                return context.json(result.fold(
                    (failure) => {
                        throw toApiMutationRouteFailure(failure);
                    },
                    (value) => value
                ));
            }
            catch (error) {
                return toGroupMutationErrorResponse(context, error);
            }
        }
    );
}
