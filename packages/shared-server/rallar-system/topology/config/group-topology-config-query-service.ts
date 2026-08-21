import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
    GroupTopologyConfigPatch,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupTopologyGroupSnapshotReader } from '../group-topology-management-contracts.ts';
import { resolveGroupTopologyConfig, type GroupTopologyServerOptions } from './group-topology-config.ts';
import type { GroupTopologyConfigGenerationReadiness } from './maintenance/group-topology-config-generation-readiness.ts';
import { GroupTopologyConfigRepository } from './persistence/group-topology-config-repository.ts';

export interface GroupTopologyConfigQueryServiceDependencies {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly readLocalTopologySnapshot: (
        group: GroupSnapshot
    ) => RallarOverlayTopologySnapshot | undefined;
    readonly readPersistedTopologySnapshot?: (
        groupRef: GroupRef
    ) => Promise<RallarOverlayTopologySnapshot | undefined>;
    readonly configRepository?: GroupTopologyConfigRepository;
    readonly readiness: Pick<GroupTopologyConfigGenerationReadiness, 'ensure'>;
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

        return {
            groupRef,
            overlayId: toScopedOverlayId(groupRef),
            snapshot: snapshot ?? null,
            config: await this.readConfig(groupRef),
            pending: null
        };
    }

    async readConfig(groupRef: GroupRef): Promise<GroupTopologyConfigView> {
        return await this.readResolvedTopologyConfig(groupRef);
    }

    async readOverride(groupRef: GroupRef): Promise<StoredGroupTopologyOverride | undefined> {
        await this.dependencies.readiness.ensure(groupRef);
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

        await this.dependencies.readiness.ensure(groupRef);
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
