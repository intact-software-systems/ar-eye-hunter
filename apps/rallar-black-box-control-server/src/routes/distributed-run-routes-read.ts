import { createControlDistributedRunArtifactBundle } from '../control-artifacts.ts';
import type { ControlCompletedRunArchive } from '../control-run-completion.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlHttpResponses } from '../http/control-http-responses.ts';
import { toNotFoundRejection } from './control-route-errors.ts';
import { toPathParameters } from './control-route-requests.ts';
import { ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS } from './run-routes-read.ts';

export interface DistributedRunReadRouteDependencies {
    readonly controlService: Pick<RallarBlackBoxControlService, 'listDistributedRuns' | 'snapshotDistributedRun'>;
    /** The bundle's control run comes from memory while the run is live and from its file once it completed. */
    readonly completedRuns: Pick<ControlCompletedRunArchive, 'readRun'>;
    readonly responses: ControlHttpResponses;
    readonly now: () => number;
}

const DISTRIBUTED_RUN_PATH = /^\/distributed-runs\/([^/]+)$/;
const DISTRIBUTED_RUN_ARTIFACTS_PATH = /^\/distributed-runs\/([^/]+)\/artifacts$/;
const DISTRIBUTED_RUN_NOT_FOUND = toNotFoundRejection('Distributed run not found.');

export async function routeDistributedRunReadRequest(
    url: URL,
    dependencies: DistributedRunReadRouteDependencies
): Promise<Response | undefined> {
    const { controlService, responses } = dependencies;
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
        return await readDistributedRunBundleRoute(bundleRunId, dependencies);
    }
    return undefined;
}

async function readDistributedRunBundleRoute(
    distributedRunId: string,
    { completedRuns, controlService, now, responses }: DistributedRunReadRouteDependencies
): Promise<Response> {
    const distributedRun = controlService.snapshotDistributedRun(distributedRunId);
    if (!distributedRun) {
        return responses.rejection(DISTRIBUTED_RUN_NOT_FOUND);
    }
    const controlRun = await completedRuns.readRun(distributedRun.controlRunId, ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS);
    return responses.artifactBundle(
        createControlDistributedRunArtifactBundle(distributedRun, controlRun.right, now()),
        200
    );
}
