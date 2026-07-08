import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';

export const GROUP_TOPOLOGY_CONFIG_NAMESPACE = 'group-topology:config';
export const GROUP_TOPOLOGY_OVERRIDE_NAMESPACE = 'group-topology:override';

export class GroupTopologyConfigRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async findConfig(
        ref: GroupRef,
    ): Promise<StoredGroupTopologyConfig | undefined> {
        return await this.getValue<StoredGroupTopologyConfig>(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            this.configKey(ref),
        );
    }

    async putConfig(input: StoredGroupTopologyConfig): Promise<void> {
        await this.putValue(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            this.configKey(input.groupRef),
            input,
            this.neverExpireAtTimestamp(),
        );
    }

    async deleteConfig(ref: GroupRef): Promise<void> {
        await this.deleteValue(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            this.configKey(ref),
        );
    }

    async findOverride(
        ref: GroupRef,
    ): Promise<StoredGroupTopologyOverride | undefined> {
        return await this.getValue<StoredGroupTopologyOverride>(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            this.overrideKey(ref),
        );
    }

    async putOverride(
        input: StoredGroupTopologyOverride,
        expiresAtEpochMs: number = input.expiresAtEpochMs,
    ): Promise<void> {
        await this.putValue(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            this.overrideKey(input.groupRef),
            {
                ...input,
                expiresAtEpochMs,
            },
            expiresAtEpochMs,
        );
    }

    async deleteOverride(ref: GroupRef): Promise<void> {
        await this.deleteValue(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            this.overrideKey(ref),
        );
    }

    configKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }

    overrideKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }
}
