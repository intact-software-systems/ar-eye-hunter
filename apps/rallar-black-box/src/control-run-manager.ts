import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunListResponse,
    ControlDistributedRunSnapshot,
    ControlFleetAgentRunOutcome,
    ControlFleetAggregateReport,
    ControlFleetFailureSignature,
    ControlFleetReportFilter,
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
    ControlFleetTimingDistribution,
    ControlQueuedCommandSnapshot,
    ControlRunArtifactBundle,
    ControlRunArtifactFileName,
    ControlRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';
import { ControlRunManagerHttpError } from './control-http-error.ts';
import {
    inheritControlResponseDocument,
    rememberControlResponseDocument,
} from './control-response-document.ts';

export { ControlRunManagerHttpError };

export type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunListResponse,
    ControlDistributedRunSnapshot,
    ControlFleetAgentRunOutcome,
    ControlFleetAggregateReport,
    ControlFleetFailureSignature,
    ControlFleetReportBundle,
    ControlFleetReportFilter,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
    ControlFleetTimingDistribution,
    ControlQueuedCommandSnapshot,
    ControlRunArtifactBundle,
    ControlRunArtifactFileName,
    ControlRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
    RallarBlackBoxDistributedTargetResolution,
};

export type ControlRunManagerStats = Readonly<{
    runCount: number;
    agentCount: number;
    connectedAgentCount: number;
    queuedCommandCount: number;
    completedCommandCount: number;
    resultCount: number;
    eventCount: number;
    reportCount: number;
    heartbeatCount: number;
}>;

export type ControlRunAgentRow = Readonly<{
    agentId: string;
    connected: boolean;
    status: string;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    identity?: RallarBlackBoxControlAgentIdentity;
    identitySummary?: string;
    queuedCommandCount: number;
    completedCommandCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    reconnectCount: number;
}>;

export type ControlRunCommandRow = Readonly<{
    commandId: string;
    agentId: string;
    kind: string;
    status: 'queued' | 'dispatched' | 'completed';
    dispatchCount: number;
    queuedAtEpochMs: number;
    completedAtEpochMs?: number;
}>;

export type ControlRunManagerFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

type ControlResponseDocument<T> = Readonly<{
    value: T;
    text: string;
}>;

type FetchControlServerSnapshotInput = Readonly<{
    baseUrl: string;
    token?: string;
    bounds?: ControlSnapshotBounds;
    fetchFn?: ControlRunManagerFetch;
}>;

type FetchDistributedRunsInput = Readonly<{
    baseUrl: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>;

export type EnqueueBulkControlCommandResult = Readonly<{
    accepted: true;
    commands: readonly ControlCommandEnvelope[];
}>;

const DEFAULT_CONTROL_HTTP_BASE_URL = 'http://localhost:5180';
const CONTROL_PATH_SUFFIX = '/control';

export function controlHttpBaseUrlFromWsUrl(value: string | undefined): string {
    if (!value) {
        return DEFAULT_CONTROL_HTTP_BASE_URL;
    }

    try {
        const url = new URL(value);
        if (url.protocol === 'ws:') {
            url.protocol = 'http:';
        } else if (url.protocol === 'wss:') {
            url.protocol = 'https:';
        }
        if (url.pathname.endsWith(CONTROL_PATH_SUFFIX)) {
            url.pathname = url.pathname.slice(0, -CONTROL_PATH_SUFFIX.length) || '/';
        }
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch (_error) {
        return DEFAULT_CONTROL_HTTP_BASE_URL;
    }
}

export function controlRunManagerStats(
    snapshot: ControlServerSnapshot | undefined,
): ControlRunManagerStats {
    const runs = snapshot?.runs ?? [];
    return runs.reduce<ControlRunManagerStats>((stats, run) => ({
        runCount: stats.runCount + 1,
        agentCount: stats.agentCount + run.agents.length,
        connectedAgentCount: stats.connectedAgentCount +
            run.agents.filter(agent => agent.connected).length,
        queuedCommandCount: stats.queuedCommandCount +
            run.commands.filter(command => command.completedAtEpochMs === undefined).length,
        completedCommandCount: stats.completedCommandCount +
            run.commands.filter(command => command.completedAtEpochMs !== undefined).length,
        resultCount: stats.resultCount + run.results.length,
        eventCount: stats.eventCount + run.events.length,
        reportCount: stats.reportCount + run.reports.length,
        heartbeatCount: stats.heartbeatCount + run.heartbeats.length,
    }), {
        runCount: 0,
        agentCount: 0,
        connectedAgentCount: 0,
        queuedCommandCount: 0,
        completedCommandCount: 0,
        resultCount: 0,
        eventCount: 0,
        reportCount: 0,
        heartbeatCount: 0,
    });
}

export function controlRunAgentRows(run: ControlRunSnapshot | undefined): readonly ControlRunAgentRow[] {
    if (!run) {
        return [];
    }

    return [...run.agents]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map(agent => ({
            agentId: agent.agentId,
            connected: agent.connected,
            status: agent.status ?? (agent.connected ? 'connected' : 'offline'),
            lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
            lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
            identity: agent.identity,
            identitySummary: controlAgentIdentitySummary(agent.identity),
            queuedCommandCount: run.commands.filter(command =>
                command.envelope.agentId === agent.agentId &&
                command.completedAtEpochMs === undefined
            ).length,
            completedCommandCount: agent.completedCommandIds.length,
            receivedResultCount: agent.receivedResultCount,
            receivedEventCount: agent.receivedEventCount,
            reconnectCount: agent.reconnectCount,
        }));
}

export function controlAgentIdentitySummary(
    identity: RallarBlackBoxControlAgentIdentity | undefined,
): string | undefined {
    if (!identity) {
        return undefined;
    }

    const principal = identity.principalId ?? identity.clientId ?? identity.username;
    const group = identity.groupId;
    const session = identity.sessionId;
    const scope = [identity.applicationId, identity.workspaceId]
        .filter(Boolean)
        .join('/');

    return [
        principal,
        group ? `group ${group}` : undefined,
        session ? `session ${session}` : undefined,
        scope ? `scope ${scope}` : undefined,
    ].filter(Boolean).join(' - ') || undefined;
}

export function controlRunCommandRows(
    run: ControlRunSnapshot | undefined,
): readonly ControlRunCommandRow[] {
    if (!run) {
        return [];
    }

    return [...run.commands]
        .sort((left, right) => right.queuedAtEpochMs - left.queuedAtEpochMs)
        .map(command => ({
            commandId: command.envelope.commandId,
            agentId: command.envelope.agentId ?? '-',
            kind: command.envelope.command.kind,
            status: command.completedAtEpochMs !== undefined
                ? 'completed'
                : command.dispatchedAtEpochMs !== undefined
                ? 'dispatched'
                : 'queued',
            dispatchCount: command.dispatchCount,
            queuedAtEpochMs: command.queuedAtEpochMs,
            completedAtEpochMs: command.completedAtEpochMs,
        }));
}

export function controlRunSnapshotUrl(
    baseUrl: string,
    runId: string | undefined,
    bounds: ControlSnapshotBounds = {},
): string {
    const url = new URL(runId ? `/runs/${encodeURIComponent(runId)}` : '/runs', normalizedBaseUrl(baseUrl));
    applySnapshotBounds(url, bounds);
    return url.toString();
}

export async function fetchControlServerSnapshot(
    input: FetchControlServerSnapshotInput,
): Promise<ControlServerSnapshot> {
    const document = await fetchControlServerSnapshotDocument(input);
    rememberControlResponseDocument(document.value, document.text);
    return document.value;
}

async function fetchControlServerSnapshotDocument(
    input: FetchControlServerSnapshotInput,
): Promise<ControlResponseDocument<ControlServerSnapshot>> {
    const response = await (input.fetchFn ?? fetch)(controlRunSnapshotUrl(
        input.baseUrl,
        undefined,
        input.bounds,
    ), {
        headers: authorizationHeaders(input.token),
    });
    return readJsonResponseDocument<ControlServerSnapshot>(response);
}

export async function fetchControlRunSnapshot(input: Readonly<{
    baseUrl: string;
    runId: string;
    token?: string;
    bounds?: ControlSnapshotBounds;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(controlRunSnapshotUrl(
        input.baseUrl,
        input.runId,
        input.bounds,
    ), {
        headers: authorizationHeaders(input.token),
    });
    return readJsonResponse<ControlRunSnapshot>(response);
}

export async function enqueueBulkControlCommand(input: Readonly<{
    baseUrl: string;
    runId: string;
    agentIds: readonly string[];
    command: RallarBlackBoxTestCommand;
    commandIdPrefix?: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<EnqueueBulkControlCommandResult> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/commands`, normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token),
            },
            body: JSON.stringify({
                agentIds: input.agentIds,
                commandIdPrefix: input.commandIdPrefix,
                command: input.command,
            }),
        },
    );
    return readJsonResponse<EnqueueBulkControlCommandResult>(response);
}

export async function resetControlRun(input: Readonly<{
    baseUrl: string;
    runId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/reset`, normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: authorizationHeaders(input.token),
        },
    );
    const body = await readJsonResponse<{ run: ControlRunSnapshot }>(response);
    return body.run;
}

export async function deleteControlRun(input: Readonly<{
    baseUrl: string;
    runId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<void> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}`, normalizedBaseUrl(input.baseUrl)),
        {
            method: 'DELETE',
            headers: authorizationHeaders(input.token),
        },
    );
    await readJsonResponse<unknown>(response);
}

export async function fetchControlRunArtifactBundle(input: Readonly<{
    baseUrl: string;
    runId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlRunArtifactBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/artifacts`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<ControlRunArtifactBundle>(response);
}

export async function fetchControlRunJsonl(input: Readonly<{
    baseUrl: string;
    runId: string;
    kind: 'events' | 'results';
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<string> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/runs/${encodeURIComponent(input.runId)}/${input.kind}.jsonl`,
            normalizedBaseUrl(input.baseUrl),
        ),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readTextResponse(response);
}

export async function fetchControlRunFailureBundle(input: Readonly<{
    baseUrl: string;
    runId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<unknown> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/failure-bundle`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<unknown>(response);
}

export async function fetchDistributedRuns(
    input: FetchDistributedRunsInput,
): Promise<readonly ControlDistributedRunSnapshot[]> {
    const document = await fetchDistributedRunsDocument(input);
    rememberControlResponseDocument(document.value, document.text);
    inheritControlResponseDocument(
        document.value,
        document.value.distributedRuns,
    );
    return document.value.distributedRuns;
}

async function fetchDistributedRunsDocument(
    input: FetchDistributedRunsInput,
): Promise<ControlResponseDocument<ControlDistributedRunListResponse>> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/distributed-runs', normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponseDocument<ControlDistributedRunListResponse>(
        response,
    );
}

export async function fetchDistributedRun(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlDistributedRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/distributed-runs/${encodeURIComponent(input.distributedRunId)}`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<ControlDistributedRunSnapshot>(response);
}

export async function createDistributedRun(input: Readonly<{
    baseUrl: string;
    manifest: RallarBlackBoxDistributedRunManifest;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlDistributedRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/distributed-runs', normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token),
            },
            body: JSON.stringify({
                manifest: input.manifest,
            }),
        },
    );
    return readJsonResponse<ControlDistributedRunSnapshot>(response);
}

export async function resolveDistributedTargets(input: Readonly<{
    baseUrl: string;
    manifest: RallarBlackBoxDistributedRunManifest;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<RallarBlackBoxDistributedTargetResolution> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/distributed-runs/resolve-targets', normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token),
            },
            body: JSON.stringify({
                manifest: input.manifest,
            }),
        },
    );
    return readJsonResponse<RallarBlackBoxDistributedTargetResolution>(response);
}

export async function stageDistributedRun(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlDistributedRunSnapshot> {
    return mutateDistributedRun(input, 'stage');
}

export async function startDistributedRun(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlDistributedRunSnapshot> {
    return mutateDistributedRun(input, 'start');
}

export async function cancelDistributedRun(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    reason?: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlDistributedRunSnapshot> {
    return mutateDistributedRun(input, 'cancel');
}

export async function fetchDistributedRunArtifactBundle(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlDistributedRunArtifactBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            normalizedBaseUrl(input.baseUrl),
        ),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<ControlDistributedRunArtifactBundle>(response);
}

export async function fetchDistributedRunArtifactBundleBytes(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
    maxBytes: number;
}>): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new RangeError('Control artifact byte limit must be a positive safe integer.');
    }
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            normalizedBaseUrl(input.baseUrl),
        ),
        { headers: authorizationHeaders(input.token) },
    );
    const declared = controlArtifactDeclaredByteLength(response);
    const maxResponseBytes = response.ok
        ? input.maxBytes
        : Math.min(input.maxBytes, CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES);
    if (declared !== undefined && declared > maxResponseBytes) {
        try {
            await response.body?.cancel();
        } catch {
            // Preserve the bounded protocol error when cancellation itself fails.
        }
        if (!response.ok) throwControlArtifactHttpError(response);
        throw controlArtifactTransferLimitError(maxResponseBytes);
    }
    let bytes: ArrayBuffer;
    try {
        bytes = await readBoundedControlArtifactBytes(
            response,
            maxResponseBytes,
            declared,
        );
    } catch (error) {
        if (!response.ok && error instanceof ControlArtifactTransferLimitError) {
            throwControlArtifactHttpError(response);
        }
        throw error;
    }
    if (!response.ok) {
        throwControlArtifactHttpError(response, bytes);
    }
    return bytes;
}

const CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES = 64 * 1_024;

async function readBoundedControlArtifactBytes(
    response: Response,
    maxBytes: number,
    declaredBytes: number | undefined,
): Promise<ArrayBuffer> {
    if (!response.body) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) {
            throw controlArtifactTransferLimitError(maxBytes);
        }
        return bytes;
    }
    const reader = response.body.getReader();
    try {
        const resizableResult = createResizableControlArtifactBuffer(
            declaredBytes ?? 0,
            maxBytes,
        );
        if (resizableResult) {
            return await readResizableControlArtifactBytes(
                reader,
                resizableResult,
                maxBytes,
            );
        }
        return declaredBytes === undefined
            ? await readControlArtifactChunks(reader, maxBytes)
            : await readDeclaredControlArtifactBytes(
                reader,
                declaredBytes,
                maxBytes,
            );
    } finally {
        reader.releaseLock();
    }
}

type ResizableControlArtifactBuffer = ArrayBuffer & Readonly<{
    maxByteLength: number;
    resizable: true;
}> & {
    resize(byteLength: number): void;
    transferToFixedLength(): ArrayBuffer;
};

function createResizableControlArtifactBuffer(
    initialBytes: number,
    maxBytes: number,
): ResizableControlArtifactBuffer | undefined {
    const prototype = ArrayBuffer.prototype as {
        resize?: unknown;
        transferToFixedLength?: unknown;
    };
    if (
        typeof prototype.resize !== 'function' ||
        typeof prototype.transferToFixedLength !== 'function'
    ) {
        return undefined;
    }
    try {
        const ResizableArrayBuffer = ArrayBuffer as unknown as new (
            byteLength: number,
            options: { maxByteLength: number },
        ) => ResizableControlArtifactBuffer;
        const buffer = new ResizableArrayBuffer(initialBytes, {
            maxByteLength: maxBytes,
        });
        return buffer.resizable ? buffer : undefined;
    } catch {
        return undefined;
    }
}

async function readResizableControlArtifactBytes(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    result: ResizableControlArtifactBuffer,
    maxBytes: number,
): Promise<ArrayBuffer> {
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw controlArtifactTransferLimitError(maxBytes);
        }
        const nextTotalBytes = totalBytes + value.byteLength;
        if (nextTotalBytes > result.byteLength) {
            result.resize(controlArtifactBufferCapacity(
                result.byteLength,
                nextTotalBytes,
                maxBytes,
            ));
        }
        new Uint8Array(result, totalBytes, value.byteLength).set(value);
        totalBytes = nextTotalBytes;
    }
    if (result.byteLength !== totalBytes) result.resize(totalBytes);
    return result.transferToFixedLength();
}

function controlArtifactBufferCapacity(
    currentBytes: number,
    requiredBytes: number,
    maxBytes: number,
): number {
    let capacity = Math.max(1, currentBytes);
    while (capacity < requiredBytes) {
        capacity = capacity > Math.floor(maxBytes / 2)
            ? maxBytes
            : capacity * 2;
    }
    return capacity;
}

async function readDeclaredControlArtifactBytes(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    declaredBytes: number,
    maxBytes: number,
): Promise<ArrayBuffer> {
    let result = new Uint8Array(declaredBytes);
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw controlArtifactTransferLimitError(maxBytes);
        }
        const nextTotalBytes = totalBytes + value.byteLength;
        if (nextTotalBytes > result.byteLength) {
            const doubledCapacity = result.byteLength > Math.floor(maxBytes / 2)
                ? maxBytes
                : result.byteLength * 2;
            const expanded = new Uint8Array(Math.max(
                nextTotalBytes,
                doubledCapacity,
                1,
            ));
            expanded.set(result.subarray(0, totalBytes));
            result = expanded;
        }
        result.set(value, totalBytes);
        totalBytes = nextTotalBytes;
    }
    return totalBytes === result.byteLength
        ? result.buffer
        : result.buffer.slice(0, totalBytes);
}

async function readControlArtifactChunks(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxBytes: number,
): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw controlArtifactTransferLimitError(maxBytes);
        }
        totalBytes += value.byteLength;
        chunks.push(value);
    }
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}

async function cancelControlArtifactReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
    try {
        await reader.cancel();
    } catch {
        // Preserve the bounded protocol error when cancellation itself fails.
    }
}

function controlArtifactDeclaredByteLength(response: Response): number | undefined {
    const value = response.headers.get('content-length')?.trim();
    if (!value || !/^\d+$/.test(value)) return undefined;
    const declared = Number(value);
    return Number.isSafeInteger(declared)
        ? declared
        : undefined;
}

function throwControlArtifactHttpError(
    response: Response,
    bytes?: ArrayBuffer,
): never {
    const text = bytes ? new TextDecoder().decode(bytes) : '';
    let value: unknown;
    try {
        value = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
        value = undefined;
    }
    const message = value && typeof value === 'object' && 'error' in value
        ? String((value as { error: unknown }).error)
        : `Control server request failed: ${response.status} ${response.statusText}`;
    throw new ControlRunManagerHttpError(
        message,
        response.status,
        response.statusText,
    );
}

class ControlArtifactTransferLimitError extends RangeError {}

function controlArtifactTransferLimitError(
    maxBytes: number,
): ControlArtifactTransferLimitError {
    return new ControlArtifactTransferLimitError(
        `Control artifact response exceeds the ${maxBytes}-byte transfer limit.`,
    );
}

export async function fetchFleetReports(input: Readonly<{
    baseUrl: string;
    token?: string;
    filter?: ControlFleetReportFilter;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlFleetReportsResponse> {
    const url = new URL('/fleet/reports', normalizedBaseUrl(input.baseUrl));
    applyFleetReportFilter(url, input.filter ?? {});
    const response = await (input.fetchFn ?? fetch)(url, {
        headers: authorizationHeaders(input.token),
    });
    return readJsonResponse<ControlFleetReportsResponse>(response);
}

export async function fetchFleetReport(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlFleetRunReport> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/fleet/reports/${encodeURIComponent(input.distributedRunId)}`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<ControlFleetRunReport>(response);
}

export async function fetchFleetReportBundle(input: Readonly<{
    baseUrl: string;
    distributedRunId: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlFleetReportBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/fleet/reports/${encodeURIComponent(input.distributedRunId)}/artifacts`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<ControlFleetReportBundle>(response);
}

export async function rebuildFleetReports(input: Readonly<{
    baseUrl: string;
    token?: string;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlFleetReportsResponse> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/fleet/reports/rebuild', normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: authorizationHeaders(input.token),
        },
    );
    return readJsonResponse<ControlFleetReportsResponse>(response);
}

async function mutateDistributedRun(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        reason?: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>,
    action: ControlDistributedRunCommandPhase,
): Promise<ControlDistributedRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/${action}`,
            normalizedBaseUrl(input.baseUrl),
        ),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token),
            },
            body: action === 'cancel' && input.reason
                ? JSON.stringify({ reason: input.reason })
                : undefined,
        },
    );
    return readJsonResponse<ControlDistributedRunSnapshot>(response);
}

function normalizedBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_CONTROL_HTTP_BASE_URL;
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
    return token && token.trim().length > 0
        ? {
            Authorization: `Bearer ${token.trim()}`,
        }
        : {};
}

function applySnapshotBounds(url: URL, bounds: ControlSnapshotBounds): void {
    const entries: Array<[string, number | undefined]> = [
        ['limitCommands', bounds.commands],
        ['limitResults', bounds.results],
        ['limitEvents', bounds.events],
        ['limitStats', bounds.stats],
        ['limitReports', bounds.reports],
        ['limitHeartbeats', bounds.heartbeats],
    ];
    entries.forEach(([name, value]) => {
        if (value !== undefined && Number.isFinite(value) && value >= 0) {
            url.searchParams.set(name, String(Math.floor(value)));
        }
    });
}

function applyFleetReportFilter(url: URL, filter: ControlFleetReportFilter): void {
    const entries: Array<[string, string | number | undefined]> = [
        ['region', filter.region],
        ['provider', filter.provider],
        ['recipeId', filter.recipeId],
        ['groupId', filter.groupId],
        ['state', filter.state],
        ['fromEpochMs', filter.fromEpochMs],
        ['toEpochMs', filter.toEpochMs],
    ];
    entries.forEach(([name, value]) => {
        if (value !== undefined && String(value).trim().length > 0) {
            url.searchParams.set(name, String(value));
        }
    });
}

async function readJsonResponse<T>(response: Response): Promise<T> {
    const document = await readJsonResponseDocument<T>(response);
    return document.value;
}

async function readJsonResponseDocument<T>(
    response: Response,
): Promise<ControlResponseDocument<T>> {
    const text = await response.text();
    let value: unknown = {};
    let parseError: unknown;
    if (text.length > 0) {
        try {
            value = JSON.parse(text);
        } catch (error) {
            parseError = error;
        }
    }
    if (!response.ok) {
        const message = value && typeof value === 'object' && 'error' in value
            ? String((value as { error: unknown }).error)
            : `Control server request failed: ${response.status} ${response.statusText}`;
        throw new ControlRunManagerHttpError(
            message,
            response.status,
            response.statusText,
        );
    }
    if (parseError) {
        throw parseError;
    }
    return {
        value: value as T,
        text,
    };
}

async function readTextResponse(response: Response): Promise<string> {
    const text = await response.text();
    if (!response.ok) {
        let message = `Control server request failed: ${response.status} ${response.statusText}`;
        try {
            const value = JSON.parse(text) as unknown;
            if (value && typeof value === 'object' && 'error' in value) {
                message = String((value as { error: unknown }).error);
            }
        } catch (_error) {
            if (text.length > 0) {
                message = text;
            }
        }
        throw new ControlRunManagerHttpError(
            message,
            response.status,
            response.statusText,
        );
    }
    return text;
}
