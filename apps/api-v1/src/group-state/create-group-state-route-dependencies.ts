import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type {
  AppInboxEnqueueInput,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  hydrateStateSyncSnapshotCaches as defaultHydrateStateSyncSnapshotCaches,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';

import { getMiddleware } from '../middleware.ts';
import {
  requireApiAuthSession as defaultRequireApiAuthSession,
} from '../services/request-auth-service.ts';
import { getGroupStateService } from '../services/group-state-service.ts';

import {
  type GroupStateRouteAuthSession,
  type GroupStateRouteDependencies,
  type ResolvedGroupStateRouteDependencies,
} from './group-state-route-contracts.ts';
import { toGroupAppInboxError } from './group-state-route-errors.ts';

export function createGroupStateRouteDependencies(
  dependencies: GroupStateRouteDependencies,
): ResolvedGroupStateRouteDependencies {
  return {
    getGroupStateService: dependencies.getGroupStateService ?? getGroupStateService,
    requireApiAuthSession: dependencies.requireApiAuthSession ?? defaultRequireApiAuthSession,
    processGroupAppInbox: dependencies.processGroupAppInbox ?? defaultProcessGroupAppInbox,
    hydrateStateSyncSnapshotCaches: dependencies.hydrateStateSyncSnapshotCaches ??
      defaultHydrateStateSyncSnapshotCaches,
    readGroupSnapshot: dependencies.readGroupSnapshot ??
      (async (ref) => {
        const snapshot = await (dependencies.getGroupStateService ?? getGroupStateService)()
          .readCurrentSnapshot(ref);
        return snapshot
          ? { status: 'found' as const, source: 'durable' as const, snapshot }
          : { status: 'not-found' as const, source: 'durable' as const };
      }),
  };
}

async function defaultProcessGroupAppInbox<V, R>(
  authority: GroupStateRouteAuthSession,
  enqueue: AppInboxEnqueueInput<V>,
): Promise<R> {
  const result = await getMiddleware().appGroupInboxService
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
}
