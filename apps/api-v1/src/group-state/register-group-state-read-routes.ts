import { Hono, type Context, type Next } from 'jsr:@hono/hono@4.11.9';
import { etag, RETAINED_304_HEADERS } from 'jsr:@hono/hono@4.11.9/etag';

import { computeGroupDirectoryPage } from '@shared-server/rallar-system/group-state/directory/compute-group-directory-page.ts';
import {
    decodeGroupDirectoryQuery,
    type GroupDirectoryQuery
} from '@shared-server/rallar-system/group-state/directory/decode-group-directory-query.ts';
import { readStateEventListQuery } from '@shared-server/rallar-system/state-events/state-event-listing.ts';
import type { GroupDirectoryPage } from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { isGroupSnapshotCausalRevisionCovered } from '@shared/repository/group-state-snapshot-revision.ts';

import { readGroupSnapshotPointQuery } from '../routes/state-snapshot-read/state-snapshot-read-query.ts';
import { writeGroupSnapshotHeaders } from '../routes/state-snapshot-read/state-snapshot-read-response.ts';
import {
    isGroupStateRouteSnapshotDirectoryListed,
    isGroupStateRouteSnapshotReadable,
    type GroupStateRouteAuthorization
} from './group-state-route-authorization.ts';
import {
    toGroupStateRouteScope,
    type GroupStateRouteDependencies
} from './group-state-route-contracts.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';

interface ReadGroupDirectoryPageInput {
    readonly scope: StateScope;
    readonly principalId: string | undefined;
    readonly query: GroupDirectoryQuery;
}

const GROUPS_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_DIRECTORY_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/group-directory';
const GROUP_PATH = `${GROUPS_PATH}/:groupId`;
const directoryEtag = etag({
    retainedHeaders: [
        ...RETAINED_304_HEADERS,
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'access-control-expose-headers'
    ]
});

export function registerGroupStateReadRoutes(
    app: Hono,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): void {
    app.get(GROUPS_PATH, (context) => readGroupSnapshotList(context, dependencies, authorization));
    app.use(GROUP_DIRECTORY_PATH, revalidateGroupDirectory);
    app.get(GROUP_DIRECTORY_PATH, (context) => readGroupDirectory(context, dependencies, authorization));
    app.get(GROUP_PATH, (context) => readGroupSnapshot(context, dependencies, authorization));
    app.get(
        `${GROUP_PATH}/events`,
        (context) => readGroupEventArray(context, dependencies, authorization)
    );
    app.get(
        `${GROUP_PATH}/events/page`,
        (context) => readGroupEventPage(context, dependencies, authorization)
    );
}

async function revalidateGroupDirectory(context: Context, next: Next): Promise<void> {
    await next();
    context.header('Vary', 'Authorization, x-client-id', { append: true });
    if (context.res.status !== 200) {
        context.header('Cache-Control', 'no-store');
        return;
    }

    context.header('Cache-Control', 'private, no-cache');
    await directoryEtag(context, async () => {});
}

async function readGroupSnapshotList(
    context: Context,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): Promise<Response> {
    try {
        const scope = toGroupStateRouteScope(context);
        const authSession = await authorization.readStrictAuthSession(context.req);
        const snapshots = authSession
            ? (await dependencies.groupStateService.listSnapshotsForPrincipal(scope, authSession.clientId))
                .filter((snapshot) => isGroupStateRouteSnapshotReadable(snapshot, authSession.clientId))
            : await dependencies.groupStateService.listSnapshots(scope);
        hydrateGroupSnapshots(dependencies, snapshots);

        return context.json(snapshots);
    }
    catch (error) {
        return toGroupStateErrorResponse(context, error);
    }
}

async function readGroupDirectory(
    context: Context,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): Promise<Response> {
    try {
        const authSession = await authorization.readStrictAuthSession(context.req);
        return await decodeGroupDirectoryQuery(new URL(context.req.raw.url).searchParams).fold<Promise<Response>>(
            (issues) =>
                Promise.resolve(
                    context.json({ error: issues.join('; '), code: 'invalid-group-directory-query' }, 400)
                ),
            async (query) =>
                context.json(
                    await readGroupDirectoryPage(dependencies, {
                        scope: toGroupStateRouteScope(context),
                        principalId: authSession?.clientId,
                        query
                    })
                )
        );
    }
    catch (error) {
        return toGroupStateErrorResponse(context, error);
    }
}

async function readGroupDirectoryPage(
    dependencies: GroupStateRouteDependencies,
    request: ReadGroupDirectoryPageInput
): Promise<GroupDirectoryPage> {
    const snapshots = await dependencies.groupStateService.listSnapshots(request.scope);
    const nowEpochMs = dependencies.nowEpochMs();
    const listed = snapshots.filter((snapshot) =>
        isGroupStateRouteSnapshotDirectoryListed(snapshot, request.principalId, nowEpochMs)
    );
    return computeGroupDirectoryPage(listed, {
        query: request.query,
        defaultMaxMembers: dependencies.groupDefaultMaxMembers
    });
}

async function readGroupSnapshot(
    context: Context,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): Promise<Response> {
    try {
        const groupId = context.req.param('groupId');
        const authSession = await authorization.readStrictAuthSession(context.req);
        const result = await dependencies.readGroupSnapshot({
            ...toGroupStateRouteScope(context),
            groupId
        }, {
            ...readGroupSnapshotPointQuery(new URL(context.req.raw.url).searchParams),
            strictMode: authSession !== undefined
        });
        if (result.status === 'not-found') {
            return context.json({ error: `Group not found: ${groupId}` }, 404);
        }
        authorization.assertAuthenticatedCanReadGroupState(authSession, result.snapshot);
        if (result.status === 'floor-not-satisfied') {
            return context.json({
                error: 'Group state revision floor was not satisfied',
                code: 'state-revision-floor-not-satisfied'
            }, 409);
        }
        hydrateGroupSnapshots(dependencies, [result.snapshot]);
        writeGroupSnapshotHeaders(context, result.source, result.snapshot);

        return context.json(result.snapshot);
    }
    catch (error) {
        return toGroupStateErrorResponse(context, error);
    }
}

async function readGroupEventArray(
    context: Context,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): Promise<Response> {
    try {
        const groupId = context.req.param('groupId');
        await authorization.assertCanReadGroupRef(context.req, {
            ...toGroupStateRouteScope(context),
            groupId
        });
        const ref = {
            ...toGroupStateRouteScope(context),
            groupId
        };
        const query = readStateEventListQuery(new URL(context.req.raw.url).searchParams);

        return context.json(
            await dependencies.groupStateService.listRecentEvents(ref, query)
        );
    }
    catch (error) {
        return toGroupStateErrorResponse(context, error);
    }
}

async function readGroupEventPage(
    context: Context,
    dependencies: GroupStateRouteDependencies,
    authorization: GroupStateRouteAuthorization
): Promise<Response> {
    try {
        const groupId = context.req.param('groupId');
        await authorization.assertCanReadGroupRef(context.req, {
            ...toGroupStateRouteScope(context),
            groupId
        });

        return context.json(
            await dependencies.groupStateService.listEventPage(
                {
                    ...toGroupStateRouteScope(context),
                    groupId
                },
                readStateEventListQuery(new URL(context.req.raw.url).searchParams)
            )
        );
    }
    catch (error) {
        return toGroupStateErrorResponse(context, error);
    }
}

function hydrateGroupSnapshots(
    dependencies: GroupStateRouteDependencies,
    snapshots: readonly GroupSnapshot[]
): void {
    const groups = snapshots.filter((snapshot) =>
        !isGroupSnapshotCausalRevisionCovered(dependencies.findStateSyncGroupSnapshot(snapshot.group), snapshot)
    );
    if (groups.length === 0) {
        return;
    }

    void dependencies.hydrateStateSyncSnapshotCaches({ groups })
        .catch((error) => console.warn('Failed to hydrate group state sync snapshot caches', error));
}
