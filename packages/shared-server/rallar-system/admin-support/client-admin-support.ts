import type {
    AdminSupportExplainClientRequest,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support/admin-support-types.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { AdminSupportWriteInput, ClientAdminSupportDependencies } from './admin-support-contracts.ts';
import { projectClientAdminSupportNarrative } from './narratives/project-client-admin-support-narrative.ts';
import { readAdminSupportRecentEventLimit } from './read-admin-support-recent-event-limit.ts';
import { readTimedAdminSupportNarrative } from './read-timed-admin-support-narrative.ts';

export class ClientAdminSupport {
    private readonly dependencies: ClientAdminSupportDependencies;

    public constructor(dependencies: ClientAdminSupportDependencies) {
        this.dependencies = dependencies;
    }

    public async explainClient(
        input: AdminSupportWriteInput<AdminSupportExplainClientRequest>
    ): Promise<AdminSupportNarrativeResponse> {
        return await readTimedAdminSupportNarrative({
            dependencies: this.dependencies,
            operation: 'explain.client',
            adminSession: input.adminSession,
            timing: {},
            readNarrative: async () => {
                const ref: ClientPrincipalRef = {
                    ...input.request.scope,
                    principalId: input.request.principalId
                };
                const service = this.dependencies.clientStateService;
                const limit = readAdminSupportRecentEventLimit(
                    input.request.limitRecentEvents
                );
                const [snapshot, presence, recentEvents] = service
                    ? await Promise.all([
                        service.readSnapshot(ref),
                        service.readPresenceSnapshot(ref),
                        service.listRecentEvents?.(ref, { limit }) ?? Promise.resolve([])
                    ])
                    : ([undefined, undefined, []] as const);
                return projectClientAdminSupportNarrative({
                    request: input.request,
                    generatedAtEpochMs: this.dependencies.now(),
                    serverId: this.dependencies.serverId,
                    hasClientStateService: Boolean(service),
                    snapshot,
                    presence,
                    recentEvents,
                    wsStatus: this.dependencies.wsStatus?.()
                });
            }
        });
    }
}
