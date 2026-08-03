import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import {
  MUTATION_ROUTE_OWNER_DISPATCH_PATHS,
  MUTATION_ROUTE_OWNER_PATHS,
} from './mutation-routing-owner-inventory.ts';

const PATHS = {
  c: 'apps/api-v1/src/routes/client-state-routes.ts',
  ga: 'apps/api-v1/src/group-state/register-group-admission-routes.ts',
  gm: 'apps/api-v1/src/group-state/register-group-membership-routes.ts',
  gp: 'apps/api-v1/src/group-state/register-group-presence-routes.ts',
  gs: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
  gc: 'apps/api-v1/src/group-state/to-group-state-command.ts',
  t: 'apps/api-v1/src/routes/graph-topology-routes.ts',
  a: 'apps/api-v1/src/routes/config-route.ts',
  w: 'apps/api-v1/src/routes/ws-routes.ts',
  ad: 'apps/api-v1/src/routes/admin-operations-routes.ts',
  cr: 'apps/api-v1/src/routes/crdt-admin-routes.ts',
  ag: 'apps/api-v1/src/services/create-api-admin-mutation-gateway.ts',
  rq: 'apps/api-v1/src/services/request-auth-service.ts',
  l: 'packages/shared-server/rallar-system/services/ws-lifecycle-service.ts',
  e: 'packages/shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts',
  s: 'packages/shared-server/rallar-system/ws-system-topics.ts',
  d: 'packages/shared-server/crdt/RallarCrdtServer.ts',
} as const;

export function decodeMutationRouteInventory(rows: string): readonly MutationRouteInventoryEntry[] {
  return rows.trim().split('\n').map(toMutationRouteInventoryEntry);
}

function toMutationRouteInventoryEntry(row: string): MutationRouteInventoryEntry {
  const [
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
  ] = row.split('\t');
  const sourcePath = PATHS[source as keyof typeof PATHS];
  const enqueueSourcePath = PATHS[enqueueSource as keyof typeof PATHS];
  const ownerSourcePath =
    MUTATION_ROUTE_OWNER_PATHS[ownerSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS];
  const ownerDispatchPath =
    MUTATION_ROUTE_OWNER_DISPATCH_PATHS[owner as keyof typeof MUTATION_ROUTE_OWNER_DISPATCH_PATHS];
  const typeOwnerSourcePath = typeOwnerSource
    ? MUTATION_ROUTE_OWNER_PATHS[typeOwnerSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS]
    : ownerSourcePath;
  const dispatchSourcePath = dispatchSource
    ? MUTATION_ROUTE_OWNER_PATHS[dispatchSource as keyof typeof MUTATION_ROUTE_OWNER_PATHS]
    : ownerSourcePath;
  const appInboxType = AppInboxType[type as keyof typeof AppInboxType];
  if (
    !sourcePath ||
    !enqueueSourcePath ||
    !ownerSourcePath ||
    !ownerDispatchPath ||
    !typeOwnerSourcePath ||
    !dispatchSourcePath ||
    !appInboxType
  ) {
    throw new Error(`Invalid mutation route inventory row: ${row}`);
  }
  return {
    transport: transport as MutationRouteInventoryEntry['transport'],
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
  };
}
