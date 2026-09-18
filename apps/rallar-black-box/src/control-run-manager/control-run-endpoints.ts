import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlRunArtifactBundle,
    ControlRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { rememberControlResponseDocument } from '../control-response-document.ts';
import {
    toAuthorizationHeaders,
    toNormalizedBaseUrl,
    type ControlEndpointRequest,
    type ControlRunRequest
} from './control-endpoint-request.ts';
import { readJsonReply, readJsonReplyDocument, readTextReply } from './control-reply-reader.ts';
import type { ControlRequestFailure } from './control-request-failure.ts';

export type EnqueueBulkControlCommandResult = Readonly<{
    accepted: true;
    commands: readonly ControlCommandEnvelope[];
}>;

/** The run the control server confirmed it deleted. */
export type ControlRunDeletion = Readonly<{ runId: string; }>;

type ReadControlServerSnapshotInput =
    & ControlEndpointRequest
    & Readonly<{
        /** Absent when the caller wants the server's own collection sizes, unbounded. */
        bounds?: ControlSnapshotBounds;
    }>;

export async function readControlServerSnapshot(
    input: ReadControlServerSnapshotInput
): Promise<Either<ControlRequestFailure, ControlServerSnapshot>> {
    const response = await input.fetchFn(
        toControlRunSnapshotUrl(
            input.baseUrl,
            undefined,
            input.bounds
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    const document = await readJsonReplyDocument<ControlServerSnapshot>(response);
    return document.mapRight((carried) => {
        rememberControlResponseDocument(carried.value, carried.text);
        return carried.value;
    });
}

export async function readControlRunSnapshot(
    input:
        & ControlRunRequest
        & Readonly<{
            /** Absent when the caller wants the server's own collection sizes, unbounded. */
            bounds?: ControlSnapshotBounds;
        }>
): Promise<Either<ControlRequestFailure, ControlRunSnapshot>> {
    const response = await input.fetchFn(
        toControlRunSnapshotUrl(
            input.baseUrl,
            input.runId,
            input.bounds
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    const document = await readJsonReplyDocument<ControlRunSnapshot>(response);
    return document.mapRight((carried) => {
        rememberControlResponseDocument(carried.value, carried.text);
        return carried.value;
    });
}

export async function enqueueBulkControlCommand(
    input:
        & ControlRunRequest
        & Readonly<{
            agentIds: readonly string[];
            command: RallarBlackBoxTestCommand;
            /** Absent when the control server may name the queued commands itself. */
            commandIdPrefix?: string;
        }>
): Promise<Either<ControlRequestFailure, EnqueueBulkControlCommandResult>> {
    const response = await input.fetchFn(
        new URL(`/runs/${encodeURIComponent(input.runId)}/commands`, toNormalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...toAuthorizationHeaders(input.token)
            },
            body: JSON.stringify({
                agentIds: input.agentIds,
                commandIdPrefix: input.commandIdPrefix,
                command: input.command
            })
        }
    );
    return readJsonReply<EnqueueBulkControlCommandResult>(response);
}

export async function resetControlRun(
    input: ControlRunRequest
): Promise<Either<ControlRequestFailure, ControlRunSnapshot>> {
    const response = await input.fetchFn(
        new URL(`/runs/${encodeURIComponent(input.runId)}/reset`, toNormalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: toAuthorizationHeaders(input.token)
        }
    );
    const body = await readJsonReply<{ run: ControlRunSnapshot; }>(response);
    return body.mapRight((carried) => carried.run);
}

export async function deleteControlRun(
    input: ControlRunRequest
): Promise<Either<ControlRequestFailure, ControlRunDeletion>> {
    const response = await input.fetchFn(
        new URL(`/runs/${encodeURIComponent(input.runId)}`, toNormalizedBaseUrl(input.baseUrl)),
        {
            method: 'DELETE',
            headers: toAuthorizationHeaders(input.token)
        }
    );
    const acknowledgement = await readJsonReply<ApiJsonValue>(response);
    return acknowledgement.mapRight(() => ({ runId: input.runId }));
}

export async function readControlRunArtifactBundle(
    input: ControlRunRequest
): Promise<Either<ControlRequestFailure, ControlRunArtifactBundle>> {
    const response = await input.fetchFn(
        new URL(`/runs/${encodeURIComponent(input.runId)}/artifacts`, toNormalizedBaseUrl(input.baseUrl)),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonReply<ControlRunArtifactBundle>(response);
}

export async function readControlRunJsonl(
    input: ControlRunRequest & Readonly<{ kind: 'events' | 'results'; }>
): Promise<Either<ControlRequestFailure, string>> {
    const response = await input.fetchFn(
        new URL(
            `/runs/${encodeURIComponent(input.runId)}/${input.kind}.jsonl`,
            toNormalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readTextReply(response);
}

export async function readControlRunFailureBundle(
    input: ControlRunRequest
): Promise<Either<ControlRequestFailure, ApiJsonValue>> {
    const response = await input.fetchFn(
        new URL(`/runs/${encodeURIComponent(input.runId)}/failure-bundle`, toNormalizedBaseUrl(input.baseUrl)),
        {
            headers: toAuthorizationHeaders(input.token)
        }
    );
    return readJsonReply<ApiJsonValue>(response);
}

function toControlRunSnapshotUrl(
    baseUrl: string,
    runId: string | undefined,
    bounds: ControlSnapshotBounds | undefined
): string {
    const url = new URL(runId ? `/runs/${encodeURIComponent(runId)}` : '/runs', toNormalizedBaseUrl(baseUrl));
    if (bounds) {
        setSnapshotBounds(url, bounds);
    }
    return url.toString();
}

function setSnapshotBounds(url: URL, bounds: ControlSnapshotBounds): void {
    const entries: Array<[string, number | undefined]> = [
        ['limitCommands', bounds.commands],
        ['limitResults', bounds.results],
        ['limitEvents', bounds.events],
        ['limitStats', bounds.stats],
        ['limitReports', bounds.reports],
        ['limitHeartbeats', bounds.heartbeats]
    ];
    entries.forEach(([name, value]) => {
        if (value !== undefined && Number.isFinite(value) && value >= 0) {
            url.searchParams.set(name, String(Math.floor(value)));
        }
    });
}
