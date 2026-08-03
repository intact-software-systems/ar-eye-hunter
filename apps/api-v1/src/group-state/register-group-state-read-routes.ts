import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';

import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
  filterStateEventsForList,
  readStateEventListQuery,
  type StateEventListQuery,
} from '@shared-server/rallar-system/state-event-listing.ts';

import {
  type GroupStateRouteService,
  type ResolvedGroupStateRouteDependencies,
  toGroupStateRouteScope,
} from './group-state-route-contracts.ts';
import {
  type GroupStateRouteAuthorization,
  isGroupStateRouteSnapshotReadable,
} from './group-state-route-authorization.ts';
import { toGroupStateErrorResponse } from './group-state-route-errors.ts';

const GROUPS_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_PATH = `${GROUPS_PATH}/:groupId`;

export function registerGroupStateReadRoutes(
  app: Hono,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): void {
  app.get(GROUPS_PATH, (context) => readGroupSnapshotList(context, dependencies, authorization));
  app.get(GROUP_PATH, (context) => readGroupSnapshot(context, dependencies, authorization));
  app.get(
    `${GROUP_PATH}/events`,
    (context) => readGroupEventArray(context, dependencies, authorization),
  );
  app.get(
    `${GROUP_PATH}/events/page`,
    (context) => readGroupEventPage(context, dependencies, authorization),
  );
}

async function readGroupSnapshotList(
  context: Context,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const authSession = await authorization.readStrictAuthSession(context.req);
    const snapshots = authSession
      ? (await dependencies.getGroupStateService().listSnapshots(toGroupStateRouteScope(context)))
        .filter((snapshot) => isGroupStateRouteSnapshotReadable(snapshot, authSession.clientId))
      : await dependencies.getGroupStateService().listSnapshots(
        toGroupStateRouteScope(context),
      );
    hydrateGroupSnapshots(dependencies, snapshots);

    return context.json(snapshots);
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}

async function readGroupSnapshot(
  context: Context,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const groupId = context.req.param('groupId');
    const snapshot = await dependencies.getGroupStateService().readCurrentSnapshot({
      ...toGroupStateRouteScope(context),
      groupId,
    });
    if (!snapshot) {
      return context.json({ error: `Group not found: ${groupId}` }, 404);
    }
    await authorization.assertCanReadGroupState(context.req, snapshot);
    hydrateGroupSnapshots(dependencies, [snapshot]);

    return context.json(snapshot);
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}

async function readGroupEventArray(
  context: Context,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const groupId = context.req.param('groupId');
    await authorization.assertCanReadGroupRef(context.req, {
      ...toGroupStateRouteScope(context),
      groupId,
    });
    const ref = {
      ...toGroupStateRouteScope(context),
      groupId,
    };
    const query = readStateEventListQuery(new URL(context.req.raw.url).searchParams);

    return context.json(
      await listRecentGroupEventsForArrayRoute(
        dependencies.getGroupStateService(),
        ref,
        query,
      ),
    );
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}

async function readGroupEventPage(
  context: Context,
  dependencies: ResolvedGroupStateRouteDependencies,
  authorization: GroupStateRouteAuthorization,
): Promise<Response> {
  try {
    const groupId = context.req.param('groupId');
    await authorization.assertCanReadGroupRef(context.req, {
      ...toGroupStateRouteScope(context),
      groupId,
    });

    return context.json(
      await dependencies.getGroupStateService().listEventPage(
        {
          ...toGroupStateRouteScope(context),
          groupId,
        },
        readStateEventListQuery(new URL(context.req.raw.url).searchParams),
      ),
    );
  } catch (error) {
    return toGroupStateErrorResponse(context, error);
  }
}

function hydrateGroupSnapshots(
  dependencies: ResolvedGroupStateRouteDependencies,
  groups: readonly GroupSnapshot[],
): void {
  if (groups.length === 0) {
    return;
  }

  void dependencies.hydrateStateSyncSnapshotCaches({ groups })
    .catch((error) => console.warn('Failed to hydrate group state sync snapshot caches', error));
}

async function listRecentGroupEventsForArrayRoute(
  service: GroupStateRouteService,
  ref: GroupRef,
  query: StateEventListQuery,
): Promise<readonly GroupEvent[]> {
  return service.listRecentEvents
    ? await service.listRecentEvents(ref, query)
    : filterStateEventsForList(await service.listEvents(ref), query);
}
