import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
    GroupConnectAppInboxPayload,
    GroupReconfigureAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { MutationActorInput } from '@shared/api/state-types.ts';

import { toGroupStateRouteScope, type GroupStateRouteDependencies } from './group-state-route-contracts.ts';
import { toGroupMutationErrorResponse } from './group-state-route-errors.ts';
import { readGroupStateRouteRequest } from './read-group-state-route-request.ts';
import { toGroupStateCommand } from './to-group-state-command.ts';
import { toGroupStateResponse } from './to-group-state-response.ts';

const GROUP_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/lifecycle';

export function registerGroupLifecycleRoutes(app: Hono, dependencies: GroupStateRouteDependencies): void {
    registerPlanGroupRoute(app, dependencies);
    registerConnectGroupRoute(app, dependencies);
    registerActivateGroupRoute(app, dependencies);
    registerReconfigureGroupRoute(app, dependencies);
    registerPauseGroupRoute(app, dependencies);
    registerResumeGroupRoute(app, dependencies);
    registerResetGroupRoute(app, dependencies);
    registerStartGroupRoute(app, dependencies);
}

function registerPlanGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/plan/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'plan-group-layout',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<MutationActorInput>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerConnectGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/connect/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'connect-group',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<GroupConnectAppInboxPayload['request']>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerActivateGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/activate/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'activate-group',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<MutationActorInput>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerReconfigureGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/reconfigure/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'reconfigure-group',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<GroupReconfigureAppInboxPayload['request']>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerPauseGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/pause/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'pause-group-transport',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<MutationActorInput>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerResumeGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/resume/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'resume-group-transport',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<MutationActorInput>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerResetGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/reset/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'reset-group-formation',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<MutationActorInput>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}

function registerStartGroupRoute(app: Hono, dependencies: GroupStateRouteDependencies): void {
    app.post(`${GROUP_PATH}/start/requests/:requestId`, async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const written = toGroupStateResponse({
                kind: 'mutation',
                written: await dependencies.processGroupAppInbox(
                    authSession,
                    toGroupStateCommand({
                        operation: 'start-group-formation',
                        authSession,
                        scope: toGroupStateRouteScope(context),
                        groupId: context.req.param('groupId'),
                        request: await readGroupStateRouteRequest<MutationActorInput>(context)
                    })
                )
            });
            return context.json(written.snapshot);
        }
        catch (error) {
            return toGroupMutationErrorResponse(context, error);
        }
    });
}
