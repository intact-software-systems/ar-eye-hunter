import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
  AppInboxEnqueueInput,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import type {
  ClientStateWritten,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import {
  hydrateStateSyncSnapshotCaches,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import type { ApiV1Runtime } from '../composition/api-v1-runtime.ts';
import { toGroupAppInboxError } from '../group-state/group-state-route-errors.ts';
import type { GroupStateRouteAuthSession } from '../group-state/group-state-route-contracts.ts';
import * as groupStateRoutes from '../group-state/register-group-state-routes.ts';
import { requireApiAuthSession } from '../services/request-auth-service.ts';
import * as clientStateRoutes from './client-state-routes.ts';

export function createStateSnapshotReadRouteRegistrars(runtime: ApiV1Runtime) {
  return {
    client: (app: Hono) =>
      clientStateRoutes.registerClientStateRoutes(app, {
        clientStateService: runtime.clientStateService,
        requireApiAuthSession: (request) =>
          requireApiAuthSession(request, runtime.authSessionRepository),
        hydrateStateSyncSnapshotCaches,
        processClientAppInbox: async <V>(
          enqueue: AppInboxEnqueueInput<V>,
          authority: IssuedAuthSession,
        ): Promise<ClientStateWritten> => {
          const result = await runtime.appClientInboxService
            .processAuthenticatedEntryUntilCompletion<V, ClientStateWritten>(
              enqueue,
              authority,
            );
          return result.fold(
            (error) => {
              throw clientStateRoutes.toClientAppInboxError(error);
            },
            (value) => value,
          );
        },
        readClientSnapshot: (ref, options) =>
          runtime.clientRestSnapshotReadSelector.read(ref, options),
      }),
    group: (app: Hono) =>
      groupStateRoutes.registerGroupStateRoutes(app, {
        groupStateService: runtime.groupStateService,
        requireApiAuthSession: (request) =>
          requireApiAuthSession(request, runtime.authSessionRepository),
        processGroupAppInbox: async <V, R>(
          authority: GroupStateRouteAuthSession,
          enqueue: AppInboxEnqueueInput<V>,
        ): Promise<R> => {
          const result = await runtime.appGroupInboxService
            .processAuthenticatedEntryUntilCompletion<V, R>(
              enqueue,
              authority as IssuedAuthSession,
            );
          return result.fold(
            (error) => {
              throw toGroupAppInboxError(error);
            },
            (value) => value,
          );
        },
        hydrateStateSyncSnapshotCaches,
        readGroupSnapshot: (ref, options) =>
          runtime.groupRestSnapshotReadSelector.read(ref, options),
      }),
    graphGroupStateService: {
      readCurrentSnapshot: (ref: GroupRef) => runtime.groupStateService.readCurrentSnapshot(ref),
    },
  };
}
