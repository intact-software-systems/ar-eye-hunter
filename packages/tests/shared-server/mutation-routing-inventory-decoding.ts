import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';

import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import {
  type MutationRouteInventoryRow,
  MUTATION_ROUTE_OWNER_DISPATCH_PATHS,
  MUTATION_ROUTE_OWNER_PATHS,
} from './mutation-routing-owner-inventory.ts';

const PATHS = {
  c: 'apps/api-v1/src/routes/client-state-routes.ts',
  ga: 'apps/api-v1/src/group-state/register-group-admission-routes.ts',
  gm: 'apps/api-v1/src/group-state/register-group-membership-routes.ts',
  gp: 'apps/api-v1/src/group-state/register-group-presence-routes.ts',
  gr: 'apps/api-v1/src/group-state/register-group-state-routes.ts',
  gs: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
  gc: 'apps/api-v1/src/group-state/to-group-state-command.ts',
  t: 'apps/api-v1/src/routes/graph-topology-routes.ts',
  a: 'apps/api-v1/src/routes/config-route.ts',
  w: 'apps/api-v1/src/routes/ws-routes.ts',
  ad: 'apps/api-v1/src/routes/admin-operations-routes.ts',
  cr: 'apps/api-v1/src/routes/crdt-admin-routes.ts',
  cm: 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts',
  ag: 'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts',
  rq: 'apps/api-v1/src/services/request-auth-service.ts',
  l: 'packages/shared-server/rallar-system/services/ws-lifecycle-service.ts',
  e:
    'packages/shared-server/rallar-system/group-state/presence/' +
    'reconcile-expired-group-presence.ts',
  s: 'packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts',
  d: 'packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts',
  gi: 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  ci: 'apps/api-v1/src/composition/create-api-v1-system-installers.ts',
} as const;

interface InventoryOwnerPathAliases {
  readonly dispatchSource?: string;
  readonly owner: string;
  readonly ownerSource: string;
  readonly typeOwnerSource?: string;
}

interface InventoryOwnerPaths {
  readonly dispatchSourcePath?: string;
  readonly ownerDispatchPath?: string;
  readonly ownerSourcePath?: string;
  readonly typeOwnerSourcePath?: string;
}

export function decodeMutationRouteInventory(
  rows: readonly MutationRouteInventoryRow[],
): readonly MutationRouteInventoryEntry[] {
  return rows.map(toMutationRouteInventoryEntry);
}

function toMutationRouteInventoryEntry(
  row: MutationRouteInventoryRow,
): MutationRouteInventoryEntry {
  const {
    transport,
    entrypoint,
    type,
    source,
    registrationMarker,
    enqueueSource,
    enqueueMarker,
    ownerSource,
    owner,
    typeOwnerSource,
    dispatchSource,
    operationDiscriminant,
    familyRegistrationMarker,
    rootSource,
    constructionRootMarker,
    familyOwnerOrder,
  } = row;
  const sourcePath = PATHS[source as keyof typeof PATHS];
  const enqueueSourcePath = PATHS[enqueueSource as keyof typeof PATHS];
  const rootSourcePath = rootSource ? PATHS[rootSource as keyof typeof PATHS] : undefined;
  const { ownerSourcePath, ownerDispatchPath, typeOwnerSourcePath, dispatchSourcePath } =
    resolveInventoryOwnerPaths({ dispatchSource, owner, ownerSource, typeOwnerSource });
  const appInboxType = AppInboxType[type as keyof typeof AppInboxType];
  if (
    !sourcePath ||
    !enqueueSourcePath ||
    !ownerSourcePath ||
    !ownerDispatchPath ||
    !typeOwnerSourcePath ||
    !dispatchSourcePath ||
    !appInboxType ||
    (Boolean(familyRegistrationMarker) &&
      (!rootSourcePath || !constructionRootMarker || !Number.isInteger(familyOwnerOrder)))
  ) {
    throw new Error(`Invalid mutation route inventory row: ${JSON.stringify(row)}`);
  }
  return {
    transport,
    entrypoint,
    type: appInboxType,
    owner,
    sourcePath,
    registrationMarker,
    enqueueSourcePath,
    enqueueMarker,
    ownerSourcePath,
    ownerDispatchPath,
    typeOwnerSourcePath,
    dispatchSourcePath,
    operationDiscriminant,
    familyRegistrationMarker,
    constructionRootSourcePath: rootSourcePath,
    constructionRootMarker,
    familyOwnerOrder,
  };
}

function resolveInventoryOwnerPaths({
  dispatchSource,
  owner,
  ownerSource,
  typeOwnerSource,
}: InventoryOwnerPathAliases): InventoryOwnerPaths {
  const ownerSourcePath =
    MUTATION_ROUTE_OWNER_PATHS[ownerSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS];
  return {
    ownerSourcePath,
    ownerDispatchPath:
      MUTATION_ROUTE_OWNER_DISPATCH_PATHS[
        owner as keyof typeof MUTATION_ROUTE_OWNER_DISPATCH_PATHS
      ],
    typeOwnerSourcePath: typeOwnerSource
      ? MUTATION_ROUTE_OWNER_PATHS[typeOwnerSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS]
      : ownerSourcePath,
    dispatchSourcePath: dispatchSource
      ? MUTATION_ROUTE_OWNER_PATHS[dispatchSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS]
      : ownerSourcePath,
  };
}
