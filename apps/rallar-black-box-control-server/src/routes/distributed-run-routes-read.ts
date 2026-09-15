import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import { toNotFoundRejection } from './control-route-errors.ts';
import { toPathParameters } from './control-route-requests.ts';
import { ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS } from './run-routes-read.ts';

export interface DistributedRunReadRouteDependencies {
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'createDistributedRunArtifactBundle' | 'listDistributedRuns' | 'snapshotDistributedRun'
    >;
    readonly responses: ControlHttpResponses;
}

const DISTRIBUTED_RUN_PATH = /^\/distributed-runs\/([^/]+)$/;
const DISTRIBUTED_RUN_ARTIFACTS_PATH = /^\/distributed-runs\/([^/]+)\/artifacts$/;
const DISTRIBUTED_RUN_NOT_FOUND = toNotFoundRejection('Distributed run not found.');

export function routeDistributedRunReadRequest(
    url: URL,
    { controlService, responses }: DistributedRunReadRouteDependencies
): Response | undefined {
    if (url.pathname === '/distributed-runs') {
        return responses.json({ distributedRuns: controlService.listDistributedRuns() }, 200);
    }

    const [distributedRunId] = toPathParameters(url.pathname, DISTRIBUTED_RUN_PATH) ?? [];
    if (distributedRunId !== undefined) {
        const distributedRun = controlService.snapshotDistributedRun(distributedRunId);
        return distributedRun ? responses.json(distributedRun, 200) : responses.rejection(DISTRIBUTED_RUN_NOT_FOUND);
    }

    const [bundleRunId] = toPathParameters(url.pathname, DISTRIBUTED_RUN_ARTIFACTS_PATH) ?? [];
    if (bundleRunId !== undefined) {
        const bundle = controlService.createDistributedRunArtifactBundle(bundleRunId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
        return bundle ? responses.json(bundle, 200) : responses.rejection(DISTRIBUTED_RUN_NOT_FOUND);
    }
    return undefined;
}
