import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
    GroupTopologyConfigPatch,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupTopologyGroupSnapshotReader } from '../planning/group-topology-planning-contracts.ts';
import { resolveGroupTopologyConfig, type GroupTopologyServerOptions } from './group-topology-config.ts';
import { GroupTopologyConfigRepository } from './persistence/group-topology-config-repository.ts';

export interface GroupTopologyConfigQueryServiceDependencies {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly readLocalTopologySnapshot: (
        group: GroupSnapshot
    ) => RallarOverlayTopologySnapshot | undefined;
    readonly readPersistedTopologySnapshot?: (
        groupRef: GroupRef
    ) => Promise<RallarOverlayTopologySnapshot | undefined>;
    /** The accepted-slot reader (plan slice 4c). Absent in local mode: no promotion exists there. */
    readonly readPersistedAcceptedTopologySnapshot?: (
        groupRef: GroupRef
    ) => Promise<RallarOverlayTopologySnapshot | undefined>;
    /** Decision 11's transient half. Absent in local mode: no durable queue to consult. */
    readonly readPendingTopologyReplan?: (
        groupRef: GroupRef
    ) => Promise<GroupTopologyManagementView['pending']>;
    readonly configRepository?: GroupTopologyConfigRepository;
    readonly serverDefaults?: GroupTopologyServerOptions;
}

interface GroupTopologyConfigPairRead {
    readonly config: Awaited<ReturnType<GroupTopologyConfigRepository['findConfigEntry']>>;
    readonly override: Awaited<ReturnType<GroupTopologyConfigRepository['findOverrideEntry']>>;
}

export class GroupTopologyConfigQueryService {
    private readonly dependencies: GroupTopologyConfigQueryServiceDependencies;

    constructor(dependencies: GroupTopologyConfigQueryServiceDependencies) {
        this.dependencies = dependencies;
    }

    async readTopologyView(groupRef: GroupRef): Promise<GroupTopologyManagementView> {
        const group = await this.dependencies.findGroupSnapshotByRef(groupRef);
        const snapshot = this.dependencies.readPersistedTopologySnapshot
            ? await this.dependencies.readPersistedTopologySnapshot(groupRef)
            : group
            ? this.dependencies.readLocalTopologySnapshot(group)
            : undefined;
        const [acceptedSnapshot, pending] = await Promise.all([
            this.dependencies.readPersistedAcceptedTopologySnapshot?.(groupRef),
            this.dependencies.readPendingTopologyReplan?.(groupRef)
        ]);
        return {
            groupRef,
            overlayId: toScopedOverlayId(groupRef),
            snapshot: snapshot ?? null,
            acceptedSnapshot: acceptedSnapshot ?? null,
            config: await this.readConfig(groupRef),
            pending: pending ?? null
        };
    }

    async readConfig(groupRef: GroupRef): Promise<GroupTopologyConfigView> {
        return await this.readResolvedTopologyConfig(groupRef);
    }

    async readOverride(groupRef: GroupRef): Promise<StoredGroupTopologyOverride | undefined> {
        return await this.dependencies.configRepository?.findOverride(groupRef);
    }

    async readResolvedTopologyConfig(
        groupRef: GroupRef,
        requestOptions?: GroupTopologyConfigPatch
    ): Promise<GroupTopologyConfigView> {
        const repository = this.dependencies.configRepository;
        if (!repository) {
            return resolveGroupTopologyConfig({
                serverOptions: this.dependencies.serverDefaults,
                requestOptions
            });
        }

        const { config, override } = await readConsistentTopologyConfigPair(repository, groupRef);
        return resolveGroupTopologyConfig({
            serverOptions: this.dependencies.serverDefaults,
            durable: config?.value,
            temporary: override?.value,
            requestOptions
        });
    }

    async findCurrentGroupSnapshot(groupRef: GroupRef): Promise<GroupSnapshot> {
        const group = await this.dependencies.findGroupSnapshotByRef(groupRef);
        if (!group) {
            throw new Error(`Group snapshot not found: ${groupRef.groupId}`);
        }
        return group;
    }
}

async function readConsistentTopologyConfigPair(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef
): Promise<GroupTopologyConfigPairRead> {
    const exact = await repository.readMutationExactEntries(groupRef, null);
    if (exact.status === 'stable') {
        return {
            config: exact.config ?? undefined,
            override: exact.override ?? undefined
        };
    }
    const [config, override] = await Promise.all([
        repository.findConfigEntry(groupRef),
        repository.findOverrideEntry(groupRef)
    ]);
    return { config, override };
}
