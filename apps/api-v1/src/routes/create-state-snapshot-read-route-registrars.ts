import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { Middleware } from '../middleware-contract.ts';
import * as groupStateRoutes from '../group-state/register-group-state-routes.ts';
import * as clientStateRoutes from './client-state-routes.ts';

export function createStateSnapshotReadRouteRegistrars(middleware: Middleware) {
  return {
    client: (app: Hono) =>
      clientStateRoutes.init(app, {
        getClientStateService: () => middleware.clientStateService,
        readClientSnapshot: (ref, options) =>
          middleware.clientRestSnapshotReadSelector.read(ref, options),
      }),
    group: (app: Hono) =>
      groupStateRoutes.registerGroupStateRoutes(app, {
        getGroupStateService: () => middleware.groupStateService,
        readGroupSnapshot: (ref, options) =>
          middleware.groupRestSnapshotReadSelector.read(ref, options),
      }),
    graphGroupStateService: {
      readCurrentSnapshot: (ref: GroupRef) => middleware.groupStateService.readCurrentSnapshot(ref),
    },
  };
}
