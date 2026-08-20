import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type { GroupRef } from '@shared/api/group-types.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type {
  AppInboxEnqueueInput,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type {
  ClientStateWritten,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import type {
  GroupStateInboxDurableResult,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import {
  hydrateStateSyncSnapshotCaches,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import type { ApiV1Runtime } from '../../composition/api-v1-runtime.ts';
import type { GroupStateRouteAuthSession } from '../../group-state/group-state-route-contracts.ts';
import * as groupStateRoutes from '../../group-state/register-group-state-routes.ts';
import * as clientStateRoutes from '../client-state-routes.ts';
import { toApiMutationRouteFailure } from '../api-mutation-route-failure.ts';

export interface ApiV1StateSnapshotRouteRuntime {
  readonly authSessionRepository: object;
  readonly appClientInboxService: Pick<
    ApiV1Runtime['appClientInboxService'],
    'processAuthenticatedEntryUntilCompletion'
  >;
  readonly appGroupInboxService: Pick<
    ApiV1Runtime['appGroupInboxService'],
    | 'processAuthenticatedGroupEntryUntilCompletionResult'
    | 'processAuthenticatedTopologyEntryUntilCompletionResult'
    | 'processAuthenticatedHttpTopologyEntryUntilCompletionResult'
  >;
  readonly clientStateService: Pick<
    ApiV1Runtime['clientStateService'],
    | 'listEventPage'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listSnapshots'
    | 'readCurrentSnapshot'
    | 'readPresenceSnapshot'
    | 'readSnapshot'
  >;
  readonly groupStateService: Pick<
    ApiV1Runtime['groupStateService'],
    | 'listEventPage'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listSnapshots'
    | 'readCurrentSnapshot'
    | 'readSnapshot'
  >;
  readonly clientRestSnapshotReadSelector: Pick<
    ApiV1Runtime['clientRestSnapshotReadSelector'],
    'read'
  >;
  readonly groupRestSnapshotReadSelector: Pick<
    ApiV1Runtime['groupRestSnapshotReadSelector'],
    'read'
  >;
}

export interface ApiV1StateSnapshotAuthRequest {
  readonly header: (name: string) => string | undefined;
}

export interface ApiV1StateSnapshotRouteOperations<
  Runtime extends ApiV1StateSnapshotRouteRuntime,
> {
  readonly requireApiAuthSession: (
    request: ApiV1StateSnapshotAuthRequest,
    repository: Runtime['authSessionRepository'],
  ) => Promise<IssuedAuthSession>;
}

export function createStateSnapshotReadRouteRegistrars<
  Runtime extends ApiV1StateSnapshotRouteRuntime,
>(
  runtime: Runtime,
  operations: ApiV1StateSnapshotRouteOperations<Runtime>,
) {
  return {
    client: (app: Hono) =>
      clientStateRoutes.registerClientStateRoutes(app, {
        clientStateService: runtime.clientStateService,
        requireApiAuthSession: (request) =>
          operations.requireApiAuthSession(request, runtime.authSessionRepository),
        hydrateStateSyncSnapshotCaches,
        processClientAppInbox: async <V>(
          enqueue: AppInboxEnqueueInput<V>,
          authority: IssuedAuthSession,
        ): Promise<Either<AppInboxFailure, ClientStateWritten>> =>
          await runtime.appClientInboxService
            .processAuthenticatedEntryUntilCompletion(enqueue, authority),
        readClientSnapshot: (ref, options) =>
          runtime.clientRestSnapshotReadSelector.read(ref, options),
      }),
    group: (app: Hono) =>
      groupStateRoutes.registerGroupStateRoutes(app, {
        groupStateService: runtime.groupStateService,
        requireApiAuthSession: (request) =>
          operations.requireApiAuthSession(request, runtime.authSessionRepository),
        processGroupAppInbox: async (
          authority: GroupStateRouteAuthSession,
          enqueue: AuthenticatedGroupMutationEnqueue,
        ): Promise<GroupStateInboxDurableResult> => {
          const result = await runtime.appGroupInboxService
            .processAuthenticatedGroupEntryUntilCompletionResult(
              enqueue,
              authority,
            );
          return result.fold(
            (error) => {
              throw toApiMutationRouteFailure(error);
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
