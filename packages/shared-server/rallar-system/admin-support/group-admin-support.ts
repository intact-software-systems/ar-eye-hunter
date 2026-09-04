import type {
    AdminSupportExplainGroupRequest,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support/admin-support-types.ts';
import { toReadGroupLifecyclePolicy } from '../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { AdminSupportWriteInput, GroupAdminSupportDependencies } from './admin-support-contracts.ts';
import { projectGroupAdminSupportNarrative } from './narratives/project-group-admin-support-narrative.ts';
import { readAdminSupportRecentEventLimit } from './read-admin-support-recent-event-limit.ts';
import { readTimedAdminSupportNarrative } from './read-timed-admin-support-narrative.ts';

export class GroupAdminSupport {
    private readonly dependencies: GroupAdminSupportDependencies;

    public constructor(dependencies: GroupAdminSupportDependencies) {
        this.dependencies = dependencies;
    }

    public async explainGroup(
        input: AdminSupportWriteInput<AdminSupportExplainGroupRequest>
    ): Promise<AdminSupportNarrativeResponse> {
        return await readTimedAdminSupportNarrative({
            dependencies: this.dependencies,
            operation: 'explain.group',
            adminSession: input.adminSession,
            timing: {},
            readNarrative: async () => {
                const groupRef = input.request.groupRef;
                const service = this.dependencies.groupStateService;
                const topologyQuery = this.dependencies.topologyQuery;
                const limit = readAdminSupportRecentEventLimit(
                    input.request.limitRecentEvents
                );
                const readPolicy = this.dependencies.readLifecyclePolicy;
                const [snapshot, recentEvents, topologyView, policyRead] = await Promise.all([
                    service?.readSnapshot(groupRef),
                    service?.listRecentEvents?.(groupRef, { limit }) ?? Promise.resolve([]),
                    topologyQuery?.readTopologyView(groupRef),
                    readPolicy?.(groupRef)
                ]);
                return projectGroupAdminSupportNarrative({
                    request: input.request,
                    generatedAtEpochMs: this.dependencies.now(),
                    serverId: this.dependencies.serverId,
                    hasGroupStateService: Boolean(service),
                    hasTopologyQuery: Boolean(topologyQuery),
                    snapshot,
                    recentEvents,
                    topologyView,
                    hasLifecyclePolicyReader: Boolean(readPolicy),
                    policy: policyRead === undefined ? null : toReadGroupLifecyclePolicy(policyRead)
                });
            }
        });
    }
}
