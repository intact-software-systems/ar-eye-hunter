import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';

import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';
import { MUTATION_ROUTE_OWNER_DISPATCH_PATHS, MUTATION_ROUTE_OWNER_PATHS, type MutationRouteInventoryRow } from './mutation-routing-owner-inventory.ts';

const PATHS = {
    groupSessions: 'apps/api-v1/src/group-state/register-group-session-routes.ts',
    groupMove: 'apps/api-v1/src/group-state/register-group-move-routes.ts',
    groupMoveDeadline: 'packages/shared-server/rallar-system/group-state/move/group-move-inbox.ts',
    clientMutations: 'apps/api-v1/src/routes/client-state-mutation-routes.ts',
    groupAdmission: 'apps/api-v1/src/group-state/register-group-admission-routes.ts',
    groupMembership: 'apps/api-v1/src/group-state/register-group-membership-routes.ts',
    groupPresence: 'apps/api-v1/src/group-state/register-group-presence-routes.ts',
    groupPublication: 'apps/api-v1/src/group-state/register-group-publication-routes.ts',
    quickJoin: 'apps/api-v1/src/group-state/register-group-quick-join-route.ts',
    groupRetentionReconciliation: 'packages/shared-server/rallar-system/group-state/retention/reconcile-group-retention.ts',
    groupRoot: 'apps/api-v1/src/group-state/register-group-state-routes.ts',
    groupLifecycle: 'apps/api-v1/src/group-state/register-group-lifecycle-routes.ts',
    groupMutations: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
    groupCommand: 'apps/api-v1/src/group-state/to-group-state-command.ts',
    graphTopology: 'apps/api-v1/src/routes/graph-topology-routes.ts',
    config: 'apps/api-v1/src/routes/config-route.ts',
    authCredentials: 'apps/api-v1/src/routes/auth/register-auth-credential-mutation-routes.ts',
    authUsers: 'apps/api-v1/src/routes/auth/register-auth-user-mutation-routes.ts',
    webSocketRoutes: 'apps/api-v1/src/routes/ws-routes.ts',
    adminMutations: 'apps/api-v1/src/admin-operations/register-admin-operation-mutation-routes.ts',
    crdtAdminRoutes: 'apps/api-v1/src/crdt/register-crdt-admin-routes.ts',
    crdtAdminMutations: 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts',
    adminTopology: 'apps/api-v1/src/admin-operations/recompute-api-admin-topology.ts',
    adminPrune: 'apps/api-v1/src/admin-operations/prune-api-admin-expired-data.ts',
    adminCompaction: 'apps/api-v1/src/admin-operations/compact-api-admin-crdt.ts',
    adminCrdtLifecycle: 'apps/api-v1/src/admin-operations/update-api-admin-crdt-lifecycle.ts',
    adminCrdtErasure: 'apps/api-v1/src/admin-operations/erase-api-admin-crdt.ts',
    webSocketLifecycle: 'packages/shared-server/rallar-system/websocket/ws-lifecycle-service.ts',
    presenceExpiry: 'packages/shared-server/rallar-system/group-state/presence/' +
        'reconcile-expired-group-presence.ts',
    rtcRttTopic: 'packages/shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts',
    crdtTopics: 'packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts',
    groupInbox: 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts',
    systemInstallers: 'apps/api-v1/src/composition/create-api-v1-system-installers.ts'
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
    const sourcePath = decodeStringProperty(PATHS, row.source);
    const enqueueSourcePath = decodeStringProperty(PATHS, row.enqueueSource);
    const rootSourcePath = row.rootSource ? decodeStringProperty(PATHS, row.rootSource) : undefined;
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
            (!rootSourcePath || !row.constructionRootMarker))
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
        constructionRootMarker: row.constructionRootMarker
    };
}

function resolveInventoryOwnerPaths({
    dispatchSource,
    owner,
    ownerSource,
    typeOwnerSource
}: InventoryOwnerPathAliases): InventoryOwnerPaths {
    const ownerSourcePath = decodeStringProperty(MUTATION_ROUTE_OWNER_PATHS, ownerSource);
    return {
        ownerSourcePath,
        ownerDispatchPath: decodeStringProperty(MUTATION_ROUTE_OWNER_DISPATCH_PATHS, owner),
        typeOwnerSourcePath: typeOwnerSource
            ? decodeStringProperty(MUTATION_ROUTE_OWNER_PATHS, typeOwnerSource)
            : ownerSourcePath,
        dispatchSourcePath: dispatchSource
            ? decodeStringProperty(MUTATION_ROUTE_OWNER_PATHS, dispatchSource)
            : ownerSourcePath
    };
}

function decodeStringProperty(value: object, key: string): string | undefined {
    const property = Reflect.get(value, key);
    return typeof property === 'string' ? property : undefined;
}
