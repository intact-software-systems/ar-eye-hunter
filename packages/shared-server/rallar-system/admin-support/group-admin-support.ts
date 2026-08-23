import type {
    AdminSupportExplainGroupRequest,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support-types.ts';
import type { AdminSupportWriteInput, GroupAdminSupportDependencies } from './admin-support-contracts.ts';
import { executeAdminSupportUseCase } from './execute-admin-support-use-case.ts';
import { projectGroupAdminSupportNarrative } from './narratives/project-group-admin-support-narrative.ts';
import { readAdminSupportRecentEventLimit } from './read-admin-support-recent-event-limit.ts';

export class GroupAdminSupport {
    private readonly dependencies: GroupAdminSupportDependencies;

    public constructor(dependencies: GroupAdminSupportDependencies) {
        this.dependencies = dependencies;
    }

    public async explainGroup(
        input: AdminSupportWriteInput<AdminSupportExplainGroupRequest>
    ): Promise<AdminSupportNarrativeResponse> {
        return await executeAdminSupportUseCase(
            this.dependencies,
            'explain.group',
            input,
            async () => {
                const groupRef = input.request.groupRef;
                const service = this.dependencies.groupStateService;
                const topologyQuery = this.dependencies.topologyQuery;
                const limit = readAdminSupportRecentEventLimit(
                    input.request.limitRecentEvents
                );
                const [snapshot, recentEvents, topologyView] = await Promise.all([
                    service?.readSnapshot(groupRef),
                    service?.listRecentEvents?.(groupRef, { limit }) ?? Promise.resolve([]),
                    topologyQuery?.readTopologyView(groupRef)
                ]);
                return projectGroupAdminSupportNarrative({
                    request: input.request,
                    generatedAtEpochMs: this.dependencies.now(),
                    serverId: this.dependencies.serverId,
                    hasGroupStateService: Boolean(service),
                    hasTopologyQuery: Boolean(topologyQuery),
                    snapshot,
                    recentEvents,
                    topologyView
                });
            }
        );
    }
}
