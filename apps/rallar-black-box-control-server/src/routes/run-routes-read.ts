import type { ControlRunSnapshot, ControlRunSnapshotBounds } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import type { ControlArtifactJsonlKind, ControlArtifactRecorder } from '../control-artifact-recorder.ts';
import {
    controlRunArtifactContentType,
    controlRunArtifactFileNameFromValue,
    controlRunFailureBundle,
    createControlRunArtifactBundle,
    createControlRunArtifactFile
} from '../control-artifacts.ts';
import type { ControlCompletedRunArchive, ControlRunReadIssue } from '../control-run-completion.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlHttpRejection, ControlHttpResponses } from '../http/control-http-responses.ts';
import { toNotFoundRejection } from './control-route-errors.ts';
import { toPathParameters } from './control-route-requests.ts';

export interface RunReadRouteDependencies {
    readonly controlService: Pick<RallarBlackBoxControlService, 'snapshot'>;
    /** Every single-run read goes through the archive: a live run from memory, a completed run from its file. */
    readonly completedRuns: Pick<ControlCompletedRunArchive, 'readRun'>;
    readonly artifactRecorder: Pick<ControlArtifactRecorder, 'response'>;
    readonly responses: ControlHttpResponses;
}

interface RunArtifactFileRequest {
    readonly runId: string;
    readonly fileName: string;
}

interface RunJsonlRequest {
    readonly runId: string;
    readonly kind: ControlArtifactJsonlKind;
}

export const ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS: ControlRunSnapshotBounds = {
    commands: 200,
    results: 200,
    events: 200,
    stats: 100,
    reports: 20,
    heartbeats: 100
};

const RUN_PATH = /^\/runs\/([^/]+)$/;
const RUN_ARTIFACTS_PATH = /^\/runs\/([^/]+)\/artifacts$/;
const RUN_ARTIFACT_FILE_PATH = /^\/runs\/([^/]+)\/artifacts\/([^/]+)$/;
const RUN_EVENTS_JSONL_PATH = /^\/runs\/([^/]+)\/events\.jsonl$/;
const RUN_RESULTS_JSONL_PATH = /^\/runs\/([^/]+)\/results\.jsonl$/;
const RUN_FAILURE_BUNDLE_PATH = /^\/runs\/([^/]+)\/failure-bundle$/;

export async function routeRunReadRequest(
    url: URL,
    dependencies: RunReadRouteDependencies
): Promise<Response | undefined> {
    const { controlService, responses } = dependencies;
    if (url.pathname === '/runs') {
        return responses.json(controlService.snapshot(toRunSnapshotBounds(url)), 200);
    }

    const [runId] = toPathParameters(url.pathname, RUN_PATH) ?? [];
    if (runId !== undefined) {
        return await readRunRoute(
            { runId: runId, bounds: toRunSnapshotBounds(url) },
            dependencies,
            (run) => responses.json(run, 200)
        );
    }

    const [fileRunId, fileName] = toPathParameters(url.pathname, RUN_ARTIFACT_FILE_PATH) ?? [];
    if (fileRunId !== undefined) {
        return await readRunArtifactFileRoute({ runId: fileRunId, fileName }, dependencies);
    }
    return await routeRunArtifactReadRequest(url, dependencies);
}

async function routeRunArtifactReadRequest(
    url: URL,
    dependencies: RunReadRouteDependencies
): Promise<Response | undefined> {
    const { responses } = dependencies;
    const [bundleRunId] = toPathParameters(url.pathname, RUN_ARTIFACTS_PATH) ?? [];
    if (bundleRunId !== undefined) {
        return await readRunRoute(
            { runId: bundleRunId, bounds: ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS },
            dependencies,
            (run) => responses.artifactBundle(createControlRunArtifactBundle(run), 200)
        );
    }

    const [eventsRunId] = toPathParameters(url.pathname, RUN_EVENTS_JSONL_PATH) ?? [];
    if (eventsRunId !== undefined) {
        return await readRunJsonlRoute({ runId: eventsRunId, kind: 'events' }, dependencies);
    }

    const [resultsRunId] = toPathParameters(url.pathname, RUN_RESULTS_JSONL_PATH) ?? [];
    if (resultsRunId !== undefined) {
        return await readRunJsonlRoute({ runId: resultsRunId, kind: 'results' }, dependencies);
    }

    const [failureRunId] = toPathParameters(url.pathname, RUN_FAILURE_BUNDLE_PATH) ?? [];
    if (failureRunId !== undefined) {
        return await readRunRoute(
            { runId: failureRunId, bounds: ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS },
            dependencies,
            (run) => responses.json(controlRunFailureBundle(run), 200)
        );
    }
    return undefined;
}

async function readRunArtifactFileRoute(
    { runId, fileName }: RunArtifactFileRequest,
    dependencies: RunReadRouteDependencies
): Promise<Response> {
    const artifactFileName = controlRunArtifactFileNameFromValue(fileName);
    if (!artifactFileName) {
        return dependencies.responses.rejection(toNotFoundRejection('Artifact file not found.'));
    }
    if (artifactFileName === 'events.jsonl' || artifactFileName === 'results.jsonl') {
        const kind = artifactFileName === 'events.jsonl' ? 'events' : 'results';
        return await readRunJsonlRoute({ runId, kind }, dependencies);
    }
    return await readRunRoute(
        { runId: runId, bounds: ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS },
        dependencies,
        (run) =>
            dependencies.responses.text(
                createControlRunArtifactFile(run, artifactFileName, Date.now()),
                200,
                controlRunArtifactContentType(artifactFileName)
            )
    );
}

async function readRunJsonlRoute(
    { runId, kind }: RunJsonlRequest,
    dependencies: RunReadRouteDependencies
): Promise<Response> {
    const { artifactRecorder, responses } = dependencies;
    return await readRunRoute(
        { runId: runId, bounds: ARTIFACT_BUNDLE_SNAPSHOT_BOUNDS },
        dependencies,
        (run) => artifactRecorder.response({ runId, kind, fallbackRun: run, corsOrigins: responses.corsOrigins })
    );
}

interface RunReadTarget {
    readonly runId: string;
    readonly bounds: ControlRunSnapshotBounds;
}

async function readRunRoute(
    { runId, bounds }: RunReadTarget,
    { completedRuns, responses }: RunReadRouteDependencies,
    respond: (run: ControlRunSnapshot) => Response | Promise<Response>
): Promise<Response> {
    return await (await completedRuns.readRun(runId, bounds)).fold(
        (issue) => Promise.resolve(responses.rejection(toRunReadRejection(issue))),
        async (run) => await respond(run)
    );
}

/** A run whose file is gone is reported as gone, apart from a run that never existed. */
function toRunReadRejection(issue: ControlRunReadIssue): ControlHttpRejection {
    switch (issue.code) {
        case 'run-not-found':
            return toNotFoundRejection(issue.message);
        case 'completed-run-file-missing':
            return { status: 410, message: issue.message };
        case 'completed-run-file-invalid':
            return { status: 500, message: issue.message };
    }
}

function toRunSnapshotBounds(url: URL): ControlRunSnapshotBounds {
    return {
        commands: toSnapshotLimit(url, 'limitCommands'),
        results: toSnapshotLimit(url, 'limitResults'),
        events: toSnapshotLimit(url, 'limitEvents'),
        stats: toSnapshotLimit(url, 'limitStats'),
        reports: toSnapshotLimit(url, 'limitReports'),
        heartbeats: toSnapshotLimit(url, 'limitHeartbeats')
    };
}

function toSnapshotLimit(url: URL, key: string): number | undefined {
    const value = url.searchParams.get(key);
    if (!value) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
