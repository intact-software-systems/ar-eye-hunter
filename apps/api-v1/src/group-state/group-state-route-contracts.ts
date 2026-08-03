import type { StateScope } from '@shared/api/state-types.ts';
import type {
  CachedGroupStateService,
} from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import type {
  AppInboxEnqueueInput,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import type {
  StateSyncCacheHydrationInput,
  StateSyncCacheHydrationResult,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

import type { GroupStateService } from '../services/group-state-service.ts';

export type GroupStateRouteService =
  & Pick<
    GroupStateService,
    | 'listSnapshots'
    | 'readSnapshot'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listEventPage'
  >
  & Pick<CachedGroupStateService, 'readCurrentSnapshot'>;

export type GroupStateRouteAuthSession = Pick<
  IssuedAuthSession,
  | 'clientId'
  | 'sessionId'
  | 'accessToken'
  | 'issuedAtEpochMs'
  | 'expiresAtEpochMs'
>;

export type ProcessGroupAppInbox = <V, R>(
  authority: GroupStateRouteAuthSession,
  enqueue: AppInboxEnqueueInput<V>,
) => Promise<R>;

export interface GroupStateRouteRequest {
  header(name: string): string | undefined;
}

export interface GroupStateRouteScopeRequest {
  param(key: 'applicationId' | 'workspaceId'): string;
}

export interface GroupStateRouteScopeContext {
  readonly req: GroupStateRouteScopeRequest;
}

export interface GroupStateRouteDependencies {
  readonly getGroupStateService?: () => GroupStateRouteService;
  readonly requireApiAuthSession?: (
    request: GroupStateRouteRequest,
  ) => Promise<GroupStateRouteAuthSession>;
  readonly processGroupAppInbox?: ProcessGroupAppInbox;
  readonly hydrateStateSyncSnapshotCaches?: (
    input: StateSyncCacheHydrationInput,
  ) => Promise<StateSyncCacheHydrationResult>;
}

export type ResolvedGroupStateRouteDependencies = Required<
  GroupStateRouteDependencies
>;

export function toGroupStateRouteScope(
  context: GroupStateRouteScopeContext,
): StateScope {
  return {
    applicationId: context.req.param('applicationId'),
    workspaceId: context.req.param('workspaceId'),
  };
}
