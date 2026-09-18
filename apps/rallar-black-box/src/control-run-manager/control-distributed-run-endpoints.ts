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
import { Either } from '@shared/resilience/Either.ts';
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
import { readJsonReply, readJsonReplyDocument } from './control-reply-reader.ts';
import type { ControlRequestFailure } from './control-request-failure.ts';
import { readBoundedControlArtifactResponseBytes } from './read-bounded-control-artifact-response-bytes.ts';

export async function readDistributedRuns(
    input: ControlEndpointRequest
): Promise<Either<ControlRequestFailure, readonly ControlDistributedRunSnapshot[]>> {
    const response = await input.fetchFn(
        new URL('/distributed-runs', toNormalizedBaseUrl(input.baseUrl)),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    const document = await readJsonReplyDocument<ControlDistributedRunListResponse>(response);
    return document.flatMap(
        (failure) => Either.ofLeft(failure),
        (carried) => {
            const plans = decodeControlDistributedRunPlans(carried.value.distributedRuns);
            if (plans.left !== undefined) {
                return Either.ofLeft({
                    kind: 'unsupported-distributed-run',
                    message: plans.left
                });
            }
            rememberControlResponseDocument(carried.value, carried.text);
            inheritControlResponseDocument(
                carried.value,
                carried.value.distributedRuns
            );
            return Either.ofRight(carried.value.distributedRuns);
        }
    );
}

export async function readDistributedRun(
    input: ControlDistributedRunRequest
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
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
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
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
): Promise<Either<ControlRequestFailure, RallarBlackBoxDistributedTargetResolution>> {
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
    return readJsonReply<RallarBlackBoxDistributedTargetResolution>(response);
}

export async function stageDistributedRun(
    input: ControlDistributedRunRequest
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
    return writeDistributedRunPhase(input, 'stage');
}

export async function startDistributedRun(
    input: ControlDistributedRunRequest
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
    return writeDistributedRunPhase(input, 'start');
}

export async function cancelDistributedRun(
    input:
        & ControlDistributedRunRequest
        & Readonly<{
            /** Absent when the operator cancelled without naming a reason. */
            reason?: string;
        }>
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
    return writeDistributedRunPhase(input, 'cancel');
}

export async function readDistributedRunArtifactBundle(
    input: ControlDistributedRunRequest
): Promise<Either<ControlRequestFailure, ControlDistributedRunArtifactBundle>> {
    const response = await input.fetchFn(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonReply<ControlDistributedRunArtifactBundle>(response);
}

export async function readDistributedRunArtifactBundleBytes(
    input: ControlDistributedRunRequest & Readonly<{ maxBytes: number; }>
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    assertControlArtifactByteLimit(input.maxBytes);
    const response = await input.fetchFn(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        { headers: toAuthorizationHeaders(input.token) }
    );
    return readBoundedControlArtifactResponseBytes(response, input.maxBytes);
}

function assertControlArtifactByteLimit(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError('Control artifact byte limit must be a positive safe integer.');
    }
}

async function writeDistributedRunPhase(
    input:
        & ControlDistributedRunRequest
        & Readonly<{
            /** Absent when the operator cancelled without naming a reason. */
            reason?: string;
        }>,
    action: ControlDistributedRunCommandPhase
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
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

async function readDistributedRunReply(
    response: Response
): Promise<Either<ControlRequestFailure, ControlDistributedRunSnapshot>> {
    const reply = await readJsonReply<ControlDistributedRunSnapshot>(response);
    return reply.flatMap(
        (failure) => Either.ofLeft(failure),
        (distributedRun) => {
            const plan = decodeControlDistributedRunPlan(distributedRun, 'distributedRun');
            return plan.left === undefined
                ? Either.ofRight(distributedRun)
                : Either.ofLeft({
                    kind: 'unsupported-distributed-run',
                    message: plan.left
                });
        }
    );
}
