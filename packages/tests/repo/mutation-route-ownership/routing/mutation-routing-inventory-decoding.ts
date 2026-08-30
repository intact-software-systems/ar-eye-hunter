import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';

import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import { MUTATION_ROUTE_OWNER_DISPATCH_PATHS, MUTATION_ROUTE_OWNER_PATHS, type MutationRouteInventoryRow } from './mutation-routing-owner-inventory.ts';

const PATHS = {
    c: 'apps/api-v1/src/routes/client-state-mutation-routes.ts',
    ga: 'apps/api-v1/src/group-state/register-group-admission-routes.ts',
    gm: 'apps/api-v1/src/group-state/register-group-membership-routes.ts',
    gp: 'apps/api-v1/src/group-state/register-group-presence-routes.ts',
    gr: 'apps/api-v1/src/group-state/register-group-state-routes.ts',
    gl: 'apps/api-v1/src/group-state/register-group-lifecycle-routes.ts',
    gs: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
    gc: 'apps/api-v1/src/group-state/to-group-state-command.ts',
    t: 'apps/api-v1/src/routes/graph-topology-routes.ts',
    a: 'apps/api-v1/src/routes/config-route.ts',
    ac: 'apps/api-v1/src/routes/auth/register-auth-credential-mutation-routes.ts',
    au: 'apps/api-v1/src/routes/auth/register-auth-user-mutation-routes.ts',
    w: 'apps/api-v1/src/routes/ws-routes.ts',
    ad: 'apps/api-v1/src/admin-operations/register-admin-operation-mutation-routes.ts',
    cr: 'apps/api-v1/src/crdt/register-crdt-admin-routes.ts',
    cm: 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts',
    ar: 'apps/api-v1/src/admin-operations/recompute-api-admin-topology.ts',
    ap: 'apps/api-v1/src/admin-operations/prune-api-admin-expired-data.ts',
    acc: 'apps/api-v1/src/admin-operations/compact-api-admin-crdt.ts',
    acl: 'apps/api-v1/src/admin-operations/update-api-admin-crdt-lifecycle.ts',
    ace: 'apps/api-v1/src/admin-operations/erase-api-admin-crdt.ts',
    rq: 'apps/api-v1/src/services/request-auth-service.ts',
    l: 'packages/shared-server/rallar-system/websocket/ws-lifecycle-service.ts',
    e: 'packages/shared-server/rallar-system/group-state/presence/' +
        'reconcile-expired-group-presence.ts',
    s: 'packages/shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts',
    d: 'packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts',
    gi: 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts',
    ci: 'apps/api-v1/src/composition/create-api-v1-system-installers.ts'
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
    rows: readonly MutationRouteInventoryRow[]
): readonly MutationRouteInventoryEntry[] {
    return rows.map(toMutationRouteInventoryEntry);
}

function toMutationRouteInventoryEntry(
    row: MutationRouteInventoryRow
): MutationRouteInventoryEntry {
    const sourcePath = readStringProperty(PATHS, row.source);
    const enqueueSourcePath = readStringProperty(PATHS, row.enqueueSource);
    const rootSourcePath = row.rootSource ? readStringProperty(PATHS, row.rootSource) : undefined;
    const { ownerSourcePath, ownerDispatchPath, typeOwnerSourcePath, dispatchSourcePath } = resolveInventoryOwnerPaths({
        dispatchSource: row.dispatchSource,
        owner: row.owner,
        ownerSource: row.ownerSource,
        typeOwnerSource: row.typeOwnerSource
    });
    const appInboxType = Object.values(AppInboxType).find((candidate) => candidate === row.type);
    if (
        !sourcePath ||
        !enqueueSourcePath ||
        !ownerSourcePath ||
        !ownerDispatchPath ||
        !typeOwnerSourcePath ||
        !dispatchSourcePath ||
        !appInboxType ||
        (Boolean(row.familyRegistrationMarker) &&
            (!rootSourcePath || !row.constructionRootMarker || !Number.isInteger(row.familyOwnerOrder)))
    ) {
        throw new Error(`Invalid mutation route inventory row: ${JSON.stringify(row)}`);
    }
    return {
        transport: row.transport,
        entrypoint: row.entrypoint,
        type: appInboxType,
        owner: row.owner,
        sourcePath,
        registrationMarker: row.registrationMarker,
        enqueueSourcePath,
        enqueueMarker: row.enqueueMarker,
        ownerSourcePath,
        ownerDispatchPath,
        typeOwnerSourcePath,
        dispatchSourcePath,
        operationDiscriminant: row.operationDiscriminant,
        familyRegistrationMarker: row.familyRegistrationMarker,
        constructionRootSourcePath: rootSourcePath,
        constructionRootMarker: row.constructionRootMarker,
        familyOwnerOrder: row.familyOwnerOrder
    };
}

function resolveInventoryOwnerPaths({
    dispatchSource,
    owner,
    ownerSource,
    typeOwnerSource
}: InventoryOwnerPathAliases): InventoryOwnerPaths {
    const ownerSourcePath = readStringProperty(MUTATION_ROUTE_OWNER_PATHS, ownerSource);
    return {
        ownerSourcePath,
        ownerDispatchPath: readStringProperty(MUTATION_ROUTE_OWNER_DISPATCH_PATHS, owner),
        typeOwnerSourcePath: typeOwnerSource
            ? readStringProperty(MUTATION_ROUTE_OWNER_PATHS, typeOwnerSource)
            : ownerSourcePath,
        dispatchSourcePath: dispatchSource
            ? readStringProperty(MUTATION_ROUTE_OWNER_PATHS, dispatchSource)
            : ownerSourcePath
    };
}

function readStringProperty(value: object, key: string): string | undefined {
    const property = Reflect.get(value, key);
    return typeof property === 'string' ? property : undefined;
}
