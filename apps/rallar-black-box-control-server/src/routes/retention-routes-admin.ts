import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import type { ControlHttpSecurity } from '../http/control-http-security.ts';
import { applyRetentionCleanup } from '../retention-cleanup.ts';
import type { RetentionPlanTokenAdapter } from '../retention-plan-token.ts';

export interface RetentionAdminRouteDependencies {
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'applyRetentionPlan' | 'applyRunRetention' | 'createRetentionPlan' | 'snapshot'
    >;
    readonly security: Pick<ControlHttpSecurity, 'authorizeAdminRequest'>;
    readonly retentionMaxRuns: number;
    readonly retentionPlanTokens: RetentionPlanTokenAdapter;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly responses: ControlHttpResponses;
}

export async function routeRetentionAdminRequest(
    request: Request,
    url: URL,
    { controlService, persistence, responses, retentionMaxRuns, retentionPlanTokens, security }:
        RetentionAdminRouteDependencies
): Promise<Response | undefined> {
    if (request.method !== 'POST' || url.pathname !== '/retention/cleanup') {
        return undefined;
    }

    const cleanup = await applyRetentionCleanup({
        url,
        maxRuns: retentionMaxRuns,
        authorize: () => security.authorizeAdminRequest(request, url),
        service: {
            createRetentionPlan: (maxRuns) => controlService.createRetentionPlan(maxRuns),
            applyRetentionPlan: (plan) => controlService.applyRetentionPlan(plan),
            applyRunRetention: (maxRuns) => controlService.applyRunRetention(maxRuns),
            readRetainedRunCount: () => controlService.snapshot().runs.length
        },
        tokens: retentionPlanTokens,
        persist: () => persistence.persist()
    });
    return responses.json(cleanup.body, cleanup.status);
}
