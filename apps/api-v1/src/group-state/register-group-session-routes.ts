import type { ChangeGroupSessionRequest } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';

export function registerGroupSessionRoutes(app: Hono, dependencies: GroupStateRouteDependencies): void {
    const base = '/api/state/apps/:applicationId/workspaces/:workspaceId';
    const sessionPath = `${base}/groups/:groupId/session`;
    app.get(`${base}/group-sessions`, (context) => listAccountSessions(context, dependencies));
    app.get(sessionPath, async (context) => {
        try {
            const auth = await dependencies.requireApiAuthSession(context.req);
            const preview = await dependencies.sessionDirectory.read(
                { ...toGroupStateRouteScope(context), groupId: context.req.param('groupId') },
                auth.clientId
            );
            return preview === null
                ? context.json({ error: 'Scheduled session not found' }, 404)
                : context.json(preview);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
    app.post(`${sessionPath}/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const scope = toGroupStateRouteScope(context);
            const groupId = context.req.param('groupId');
            dependencies.groupAdmissionQuota.require({
                family: 'join-admission',
                groupRef: { ...scope, groupId },
                principalId: authSession.clientId
            });
            await dependencies.processGroupAppInbox(
                authSession,
                toGroupStateCommand({
                    operation: 'change-group-session',
                    authSession,
                    scope,
                    groupId,
                    traceId: readApiRequestTraceId(context),
                    request: await readGroupStateRouteRequest<ChangeGroupSessionRequest>(context)
                })
            );
            // RSVP does not grant membership or access to the group's member/presence roster.
            return context.json({ accepted: true });
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

async function listAccountSessions(context: Context, dependencies: GroupStateRouteDependencies): Promise<Response> {
    try {
        const auth = await dependencies.requireApiAuthSession(context.req);
        return context.json(
            await dependencies.sessionDirectory.listForPrincipal(
                toGroupStateRouteScope(context),
                auth.clientId,
                context.req.query('after') ?? null
            )
        );
    }
    catch (error) {
        return toGroupMutationErrorResponse(context, error);
    }
}
