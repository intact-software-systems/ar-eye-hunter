import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunListResponse,
    ControlDistributedRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { inheritControlResponseDocument, rememberControlResponseDocument } from '../control-response-document.ts';
import {
    decodeControlDistributedRunPlan,
    decodeControlDistributedRunPlans
} from '../decode-control-distributed-run-plan.ts';
import {
    toAuthorizationHeaders,
    toNormalizedBaseUrl,
    type ControlDistributedRunRequest,
    type ControlEndpointRequest
} from './control-endpoint-request.ts';
import { readJsonResponse, readJsonResponseDocument, type ControlResponseDocument } from './control-reply-reader.ts';
import { readBoundedControlArtifactResponseBytes } from './read-bounded-control-artifact-response-bytes.ts';

export async function readDistributedRuns(
    input: ControlEndpointRequest
): Promise<readonly ControlDistributedRunSnapshot[]> {
    const document = await readDistributedRunsDocument(input);
    const plans = decodeControlDistributedRunPlans(document.value.distributedRuns);
    if (plans.left !== undefined) {
        throw new Error(plans.left);
    }
    rememberControlResponseDocument(document.value, document.text);
    inheritControlResponseDocument(
        document.value,
        document.value.distributedRuns
    );
    return document.value.distributedRuns;
}

async function readDistributedRunsDocument(
    input: ControlEndpointRequest
): Promise<ControlResponseDocument<ControlDistributedRunListResponse>> {
    const response = await input.fetchFn(
        new URL('/distributed-runs', toNormalizedBaseUrl(input.baseUrl)),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonResponseDocument<ControlDistributedRunListResponse>(
        response
    );
}

export async function readDistributedRun(
    input: ControlDistributedRunRequest
): Promise<ControlDistributedRunSnapshot> {
    const response = await input.fetchFn(
        new URL(`/distributed-runs/${encodeURIComponent(input.distributedRunId)}`, toNormalizedBaseUrl(input.baseUrl)),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readDistributedRunReply(response);
}

export async function createDistributedRun(
    input:
        & ControlEndpointRequest
        & Readonly<{
            manifest: RallarBlackBoxDistributedRunManifest;
        }>
): Promise<ControlDistributedRunSnapshot> {
    const response = await input.fetchFn(
        new URL('/distributed-runs', toNormalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...toAuthorizationHeaders(input.token)
            },
            body: JSON.stringify({
                manifest: input.manifest
            })
        }
    );
    return readDistributedRunReply(response);
}

export async function readDistributedTargetResolution(
    input:
        & ControlEndpointRequest
        & Readonly<{
            manifest: RallarBlackBoxDistributedRunManifest;
        }>
): Promise<RallarBlackBoxDistributedTargetResolution> {
    const response = await input.fetchFn(
        new URL('/distributed-runs/resolve-targets', toNormalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...toAuthorizationHeaders(input.token)
            },
            body: JSON.stringify({
                manifest: input.manifest
            })
        }
    );
    return readJsonResponse<RallarBlackBoxDistributedTargetResolution>(response);
}

export async function stageDistributedRun(
    input: ControlDistributedRunRequest
): Promise<ControlDistributedRunSnapshot> {
    return writeDistributedRunPhase(input, 'stage');
}

export async function startDistributedRun(
    input: ControlDistributedRunRequest
): Promise<ControlDistributedRunSnapshot> {
    return writeDistributedRunPhase(input, 'start');
}

export async function cancelDistributedRun(
    input:
        & ControlDistributedRunRequest
        & Readonly<{
            /** Absent when the operator cancelled without naming a reason. */
            reason?: string;
        }>
): Promise<ControlDistributedRunSnapshot> {
    return writeDistributedRunPhase(input, 'cancel');
}

export async function readDistributedRunArtifactBundle(
    input: ControlDistributedRunRequest
): Promise<ControlDistributedRunArtifactBundle> {
    const response = await input.fetchFn(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlDistributedRunArtifactBundle>(response);
}

export async function readDistributedRunArtifactBundleBytes(
    input: ControlDistributedRunRequest & Readonly<{ maxBytes: number; }>
): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new RangeError('Control artifact byte limit must be a positive safe integer.');
    }
    const response = await input.fetchFn(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        { headers: toAuthorizationHeaders(input.token) }
    );
    return readBoundedControlArtifactResponseBytes(response, input.maxBytes);
}

async function writeDistributedRunPhase(
    input:
        & ControlDistributedRunRequest
        & Readonly<{
            /** Absent when the operator cancelled without naming a reason. */
            reason?: string;
        }>,
    action: ControlDistributedRunCommandPhase
): Promise<ControlDistributedRunSnapshot> {
    const response = await input.fetchFn(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/${action}`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...toAuthorizationHeaders(input.token)
            },
            body: action === 'cancel' && input.reason
                ? JSON.stringify({ reason: input.reason })
                : undefined
        }
    );
    return readDistributedRunReply(response);
}

async function readDistributedRunReply(response: Response): Promise<ControlDistributedRunSnapshot> {
    const distributedRun = await readJsonResponse<ControlDistributedRunSnapshot>(response);
    const plan = decodeControlDistributedRunPlan(distributedRun, 'distributedRun');
    if (plan.left !== undefined) {
        throw new Error(plan.left);
    }
    return distributedRun;
}
