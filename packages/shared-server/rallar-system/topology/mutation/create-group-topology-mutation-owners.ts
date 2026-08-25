import type { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';
import { GroupTopologyConfigMutationService } from '../config/group-topology-config-mutation-service.ts';
import type { GroupTopologyServerOptions } from '../config/group-topology-config.ts';
import type { GroupTopologyConfigRepository } from '../config/persistence/group-topology-config-repository.ts';
import type { GroupTopologyPlanningService } from '../planning/group-topology-planning-service.ts';
import { GroupTopologyReconfigureMutation } from '../reconfigure/group-topology-reconfigure-mutation.ts';
import type { RtcTopologyOutboxWriter } from './rtc-topology-outbox-writer.ts';

export interface CreateGroupTopologyMutationOwnersInput {
    readonly groupStateRepository: GroupStateRepository;
    readonly configRepository: GroupTopologyConfigRepository;
    readonly planning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    readonly serverDefaults?: GroupTopologyServerOptions;
    readonly nowEpochMs: () => number;
    readonly isPlatformAdmin: (principalId: string) => boolean;
    readonly outboxWriter: RtcTopologyOutboxWriter;
}

export interface GroupTopologyMutationOwners {
    readonly configMutation: GroupTopologyConfigMutationService;
    readonly reconfigureMutation: GroupTopologyReconfigureMutation;
}

export function createGroupTopologyMutationOwners(
    input: CreateGroupTopologyMutationOwnersInput
): GroupTopologyMutationOwners {
    return {
        configMutation: new GroupTopologyConfigMutationService({
            configRepository: input.configRepository,
            groupStateRepository: input.groupStateRepository,
            serverDefaults: input.serverDefaults,
            nowEpochMs: input.nowEpochMs,
            isPlatformAdmin: input.isPlatformAdmin,
            outboxWriter: input.outboxWriter
        }),
        reconfigureMutation: new GroupTopologyReconfigureMutation({
            groupStateRepository: input.groupStateRepository,
            readPlanningAuthority: async (authorityInput) =>
                await input.planning.readTopologyPlanningAuthority(authorityInput),
            isPlatformAdmin: input.isPlatformAdmin,
            outboxWriter: input.outboxWriter
        })
    };
}
