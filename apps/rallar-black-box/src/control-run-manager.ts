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
    ControlSnapshotBounds
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ControlRunManagerHttpError } from './control-http-error.ts';
import { inheritControlResponseDocument, rememberControlResponseDocument } from './control-response-document.ts';
import {
    decodeControlDistributedRunPlan,
    decodeControlDistributedRunPlans
} from './decode-control-distributed-run-plan.ts';

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
    RallarBlackBoxDistributedTargetResolution
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
    init?: RequestInit
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
        }
        else if (url.protocol === 'wss:') {
            url.protocol = 'https:';
        }
        if (url.pathname.endsWith(CONTROL_PATH_SUFFIX)) {
            url.pathname = url.pathname.slice(0, -CONTROL_PATH_SUFFIX.length) || '/';
        }
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    }
    catch (_error) {
        return DEFAULT_CONTROL_HTTP_BASE_URL;
    }
}

export function controlRunManagerStats(
    snapshot: ControlServerSnapshot | undefined
): ControlRunManagerStats {
    const runs = snapshot?.runs ?? [];
    return runs.reduce<ControlRunManagerStats>((stats, run) => ({
        runCount: stats.runCount + 1,
        agentCount: stats.agentCount + run.agents.length,
        connectedAgentCount: stats.connectedAgentCount +
            run.agents.filter((agent) => agent.connected).length,
        queuedCommandCount: stats.queuedCommandCount +
            run.commands.filter((command) => command.completedAtEpochMs === undefined).length,
        completedCommandCount: stats.completedCommandCount +
            run.commands.filter((command) => command.completedAtEpochMs !== undefined).length,
        resultCount: stats.resultCount + run.results.length,
        eventCount: stats.eventCount + run.events.length,
        reportCount: stats.reportCount + run.reports.length,
        heartbeatCount: stats.heartbeatCount + run.heartbeats.length
    }), {
        runCount: 0,
        agentCount: 0,
        connectedAgentCount: 0,
        queuedCommandCount: 0,
        completedCommandCount: 0,
        resultCount: 0,
        eventCount: 0,
        reportCount: 0,
        heartbeatCount: 0
    });
}

export function controlRunAgentRows(run: ControlRunSnapshot | undefined): readonly ControlRunAgentRow[] {
    if (!run) {
        return [];
    }

    return [...run.agents]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map((agent) => ({
            agentId: agent.agentId,
            connected: agent.connected,
            status: agent.status ?? (agent.connected ? 'connected' : 'offline'),
            lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
            lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
            identity: agent.identity,
            identitySummary: controlAgentIdentitySummary(agent.identity),
            queuedCommandCount: run.commands.filter((command) =>
                command.envelope.agentId === agent.agentId &&
                command.completedAtEpochMs === undefined
            ).length,
            completedCommandCount: agent.completedCommandIds.length,
            receivedResultCount: agent.receivedResultCount,
            receivedEventCount: agent.receivedEventCount,
            reconnectCount: agent.reconnectCount
        }));
}

export function controlAgentIdentitySummary(
    identity: RallarBlackBoxControlAgentIdentity | undefined
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
        scope ? `scope ${scope}` : undefined
    ].filter(Boolean).join(' - ') || undefined;
}

export function controlRunCommandRows(
    run: ControlRunSnapshot | undefined
): readonly ControlRunCommandRow[] {
    if (!run) {
        return [];
    }

    return [...run.commands]
        .sort((left, right) => right.queuedAtEpochMs - left.queuedAtEpochMs)
        .map((command) => ({
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
            completedAtEpochMs: command.completedAtEpochMs
        }));
}

function toControlRunSnapshotUrl(
    baseUrl: string,
    runId: string | undefined,
    bounds: ControlSnapshotBounds | undefined
): string {
    const url = new URL(runId ? `/runs/${encodeURIComponent(runId)}` : '/runs', normalizedBaseUrl(baseUrl));
    if (bounds) {
        applySnapshotBounds(url, bounds);
    }
    return url.toString();
}

export async function fetchControlServerSnapshot(
    input: FetchControlServerSnapshotInput
): Promise<ControlServerSnapshot> {
    const document = await fetchControlServerSnapshotDocument(input);
    rememberControlResponseDocument(document.value, document.text);
    return document.value;
}

async function fetchControlServerSnapshotDocument(
    input: FetchControlServerSnapshotInput
): Promise<ControlResponseDocument<ControlServerSnapshot>> {
    const response = await (input.fetchFn ?? fetch)(
        toControlRunSnapshotUrl(
            input.baseUrl,
            undefined,
            input.bounds
        ),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponseDocument<ControlServerSnapshot>(response);
}

export async function fetchControlRunSnapshot(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        token?: string;
        bounds?: ControlSnapshotBounds;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        toControlRunSnapshotUrl(
            input.baseUrl,
            input.runId,
            input.bounds
        ),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    const document = await readJsonResponseDocument<ControlRunSnapshot>(response);
    rememberControlResponseDocument(document.value, document.text);
    return document.value;
}

export async function enqueueBulkControlCommand(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        agentIds: readonly string[];
        command: RallarBlackBoxTestCommand;
        commandIdPrefix?: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<EnqueueBulkControlCommandResult> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/commands`, normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token)
            },
            body: JSON.stringify({
                agentIds: input.agentIds,
                commandIdPrefix: input.commandIdPrefix,
                command: input.command
            })
        }
    );
    return readJsonResponse<EnqueueBulkControlCommandResult>(response);
}

export async function resetControlRun(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/reset`, normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: authorizationHeaders(input.token)
        }
    );
    const body = await readJsonResponse<{ run: ControlRunSnapshot; }>(response);
    return body.run;
}

export async function deleteControlRun(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<void> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}`, normalizedBaseUrl(input.baseUrl)),
        {
            method: 'DELETE',
            headers: authorizationHeaders(input.token)
        }
    );
    await readAcknowledgedJsonResponse(response);
}

export async function fetchControlRunArtifactBundle(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlRunArtifactBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/artifacts`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlRunArtifactBundle>(response);
}

export async function fetchControlRunJsonl(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        kind: 'events' | 'results';
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<string> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/runs/${encodeURIComponent(input.runId)}/${input.kind}.jsonl`,
            normalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readTextResponse(response);
}

export async function fetchControlRunFailureBundle(
    input: Readonly<{
        baseUrl: string;
        runId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ApiJsonValue> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/runs/${encodeURIComponent(input.runId)}/failure-bundle`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ApiJsonValue>(response);
}

export async function fetchDistributedRuns(
    input: FetchDistributedRunsInput
): Promise<readonly ControlDistributedRunSnapshot[]> {
    const document = await fetchDistributedRunsDocument(input);
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

async function fetchDistributedRunsDocument(
    input: FetchDistributedRunsInput
): Promise<ControlResponseDocument<ControlDistributedRunListResponse>> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/distributed-runs', normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponseDocument<ControlDistributedRunListResponse>(
        response
    );
}

export async function fetchDistributedRun(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlDistributedRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/distributed-runs/${encodeURIComponent(input.distributedRunId)}`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readDistributedRunReply(response);
}

export async function createDistributedRun(
    input: Readonly<{
        baseUrl: string;
        manifest: RallarBlackBoxDistributedRunManifest;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlDistributedRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/distributed-runs', normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token)
            },
            body: JSON.stringify({
                manifest: input.manifest
            })
        }
    );
    return readDistributedRunReply(response);
}

export async function resolveDistributedTargets(
    input: Readonly<{
        baseUrl: string;
        manifest: RallarBlackBoxDistributedRunManifest;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<RallarBlackBoxDistributedTargetResolution> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/distributed-runs/resolve-targets', normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token)
            },
            body: JSON.stringify({
                manifest: input.manifest
            })
        }
    );
    return readJsonResponse<RallarBlackBoxDistributedTargetResolution>(response);
}

export async function stageDistributedRun(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlDistributedRunSnapshot> {
    return mutateDistributedRun(input, 'stage');
}

export async function startDistributedRun(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlDistributedRunSnapshot> {
    return mutateDistributedRun(input, 'start');
}

export async function cancelDistributedRun(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        reason?: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlDistributedRunSnapshot> {
    return mutateDistributedRun(input, 'cancel');
}

export async function fetchDistributedRunArtifactBundle(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlDistributedRunArtifactBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            normalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlDistributedRunArtifactBundle>(response);
}

export async function fetchDistributedRunArtifactBundleBytes(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
        maxBytes: number;
    }>
): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new RangeError('Control artifact byte limit must be a positive safe integer.');
    }
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            normalizedBaseUrl(input.baseUrl)
        ),
        { headers: authorizationHeaders(input.token) }
    );
    return readBoundedControlArtifactResponseBytes(response, input.maxBytes);
}

async function readBoundedControlArtifactResponseBytes(
    response: Response,
    maxBytes: number
): Promise<ArrayBuffer> {
    const declared = controlArtifactDeclaredByteLength(response);
    const maxResponseBytes = response.ok
        ? maxBytes
        : Math.min(maxBytes, CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES);
    if (declared !== undefined && declared > maxResponseBytes) {
        try {
            await response.body?.cancel();
        }
        catch {
            // Preserve the bounded protocol error when cancellation itself fails.
        }
        if (!response.ok) {
            throwControlArtifactHttpError(response);
        }
        throw controlArtifactTransferLimitError(maxResponseBytes);
    }
    let bytes: ArrayBuffer;
    try {
        bytes = await readBoundedControlArtifactBytes(
            response,
            maxResponseBytes,
            declared
        );
    }
    catch (error) {
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
const CONTROL_FLEET_REPORT_BUNDLE_TRANSFER_MAX_BYTES = 64 * 1_024 * 1_024;

async function readBoundedControlArtifactBytes(
    response: Response,
    maxBytes: number,
    declaredBytes: number | undefined
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
            maxBytes
        );
        if (resizableResult) {
            return await readResizableControlArtifactBytes(
                reader,
                resizableResult,
                maxBytes
            );
        }
        return declaredBytes === undefined
            ? await readControlArtifactChunks(reader, maxBytes)
            : await readDeclaredControlArtifactBytes(
                reader,
                declaredBytes,
                maxBytes
            );
    }
    finally {
        reader.releaseLock();
    }
}

type ResizableControlArtifactBuffer =
    & ArrayBuffer
    & Readonly<{
        maxByteLength: number;
        resizable: true;
    }>
    & {
        resize(byteLength: number): void;
        transferToFixedLength(): ArrayBuffer;
    };

/**
 * `ArrayBuffer` as the resizable-buffer proposal declares it. The repository's DOM lib predates
 * that constructor overload, so the runtime's own `ArrayBuffer` is read through this contract
 * after the prototype probe below proves the feature is present.
 */
type ResizableArrayBufferConstructor =
    & (new(
        byteLength: number,
        options: Readonly<{ maxByteLength: number; }>
    ) => ResizableControlArtifactBuffer)
    & ArrayBufferConstructor;

function resolveResizableArrayBufferConstructor(): ResizableArrayBufferConstructor | undefined {
    const prototype = ArrayBuffer.prototype as Partial<
        Pick<ResizableControlArtifactBuffer, 'resize' | 'transferToFixedLength'>
    >;
    return typeof prototype.resize === 'function' &&
            typeof prototype.transferToFixedLength === 'function'
        ? ArrayBuffer as ResizableArrayBufferConstructor
        : undefined;
}

function createResizableControlArtifactBuffer(
    initialBytes: number,
    maxBytes: number
): ResizableControlArtifactBuffer | undefined {
    const ResizableArrayBuffer = resolveResizableArrayBufferConstructor();
    if (!ResizableArrayBuffer) {
        return undefined;
    }
    try {
        const buffer = new ResizableArrayBuffer(initialBytes, {
            maxByteLength: maxBytes
        });
        return buffer.resizable ? buffer : undefined;
    }
    catch {
        return undefined;
    }
}

async function readResizableControlArtifactBytes(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    result: ResizableControlArtifactBuffer,
    maxBytes: number
): Promise<ArrayBuffer> {
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw controlArtifactTransferLimitError(maxBytes);
        }
        const nextTotalBytes = totalBytes + value.byteLength;
        if (nextTotalBytes > result.byteLength) {
            result.resize(controlArtifactBufferCapacity(
                result.byteLength,
                nextTotalBytes,
                maxBytes
            ));
        }
        new Uint8Array(result, totalBytes, value.byteLength).set(value);
        totalBytes = nextTotalBytes;
    }
    if (result.byteLength !== totalBytes) {
        result.resize(totalBytes);
    }
    return result.transferToFixedLength();
}

function controlArtifactBufferCapacity(
    currentBytes: number,
    requiredBytes: number,
    maxBytes: number
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
    maxBytes: number
): Promise<ArrayBuffer> {
    let result = new Uint8Array(declaredBytes);
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
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
                1
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
    maxBytes: number
): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
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
    reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
    try {
        await reader.cancel();
    }
    catch {
        // Preserve the bounded protocol error when cancellation itself fails.
    }
}

function controlArtifactDeclaredByteLength(response: Response): number | undefined {
    const value = response.headers.get('content-length')?.trim();
    if (!value || !/^\d+$/.test(value)) {
        return undefined;
    }
    const declared = Number(value);
    return Number.isSafeInteger(declared)
        ? declared
        : undefined;
}

function throwControlArtifactHttpError(
    response: Response,
    bytes?: ArrayBuffer
): never {
    const text = bytes ? new TextDecoder().decode(bytes) : '';
    throw new ControlRunManagerHttpError(
        toControlErrorMessage(response, decodeControlReplyBody(text)),
        response.status,
        response.statusText
    );
}

class ControlArtifactTransferLimitError extends RangeError {}

function controlArtifactTransferLimitError(
    maxBytes: number
): ControlArtifactTransferLimitError {
    return new ControlArtifactTransferLimitError(
        `Control artifact response exceeds the ${maxBytes}-byte transfer limit.`
    );
}

export async function fetchFleetReports(
    input: Readonly<{
        baseUrl: string;
        token?: string;
        filter?: ControlFleetReportFilter;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlFleetReportsResponse> {
    const url = new URL('/fleet/reports', normalizedBaseUrl(input.baseUrl));
    applyFleetReportFilter(url, input.filter ?? {});
    const response = await (input.fetchFn ?? fetch)(url, {
        headers: authorizationHeaders(input.token)
    });
    return readJsonResponse<ControlFleetReportsResponse>(response);
}

export async function fetchFleetReport(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlFleetRunReport> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(`/fleet/reports/${encodeURIComponent(input.distributedRunId)}`, normalizedBaseUrl(input.baseUrl)),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlFleetRunReport>(response);
}

export async function fetchFleetReportBundle(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlFleetReportBundle> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/fleet/reports/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            normalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readJsonResponse<ControlFleetReportBundle>(response);
}

export async function fetchFleetReportBundleBytes(
    input: Readonly<{
        baseUrl: string;
        distributedRunId: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ArrayBuffer> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/fleet/reports/${encodeURIComponent(input.distributedRunId)}/artifacts`,
            normalizedBaseUrl(input.baseUrl)
        ),
        {
            headers: authorizationHeaders(input.token)
        }
    );
    return readBoundedControlArtifactResponseBytes(
        response,
        CONTROL_FLEET_REPORT_BUNDLE_TRANSFER_MAX_BYTES
    );
}

export async function rebuildFleetReports(
    input: Readonly<{
        baseUrl: string;
        token?: string;
        fetchFn?: ControlRunManagerFetch;
    }>
): Promise<ControlFleetReportsResponse> {
    const response = await (input.fetchFn ?? fetch)(
        new URL('/fleet/reports/rebuild', normalizedBaseUrl(input.baseUrl)),
        {
            method: 'POST',
            headers: authorizationHeaders(input.token)
        }
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
    action: ControlDistributedRunCommandPhase
): Promise<ControlDistributedRunSnapshot> {
    const response = await (input.fetchFn ?? fetch)(
        new URL(
            `/distributed-runs/${encodeURIComponent(input.distributedRunId)}/${action}`,
            normalizedBaseUrl(input.baseUrl)
        ),
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorizationHeaders(input.token)
            },
            body: action === 'cancel' && input.reason
                ? JSON.stringify({ reason: input.reason })
                : undefined
        }
    );
    return readDistributedRunReply(response);
}

function normalizedBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_CONTROL_HTTP_BASE_URL;
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
    return token && token.trim().length > 0
        ? {
            Authorization: `Bearer ${token.trim()}`
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
        ['limitHeartbeats', bounds.heartbeats]
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
        ['toEpochMs', filter.toEpochMs]
    ];
    entries.forEach(([name, value]) => {
        if (value !== undefined && String(value).trim().length > 0) {
            url.searchParams.set(name, String(value));
        }
    });
}

async function readDistributedRunReply(response: Response): Promise<ControlDistributedRunSnapshot> {
    const distributedRun = await readJsonResponse<ControlDistributedRunSnapshot>(response);
    const plan = decodeControlDistributedRunPlan(distributedRun, 'distributedRun');
    if (plan.left !== undefined) {
        throw new Error(plan.left);
    }
    return distributedRun;
}

/** A control reply body as it arrived: empty, valid JSON, or text the JSON parser rejected. */
type ControlReplyBody =
    | Readonly<{ kind: 'absent'; }>
    | Readonly<{ kind: 'json'; value: ApiJsonValue; }>
    | Readonly<{ kind: 'unparsed'; error: Error; }>;

function decodeControlReplyBody(text: string): ControlReplyBody {
    if (text.length === 0) {
        return { kind: 'absent' };
    }
    try {
        return { kind: 'json', value: JSON.parse(text) as ApiJsonValue };
    }
    catch (error) {
        return { kind: 'unparsed', error: toError(error) };
    }
}

/** The message a failed reply carries in its own `error` field, else the HTTP status line. */
function toControlErrorMessage(response: Response, body: ControlReplyBody): string {
    const carried = body.kind === 'json' ? toControlReplyErrorText(body.value) : undefined;
    return carried ?? toControlStatusMessage(response);
}

function toControlReplyErrorText(value: ApiJsonValue): string | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
            'error' in value
        ? String(value.error)
        : undefined;
}

function toControlStatusMessage(response: Response): string {
    return `Control server request failed: ${response.status} ${response.statusText}`;
}

async function readAcknowledgedJsonResponse(response: Response): Promise<void> {
    await readJsonResponseDocument<ApiJsonValue>(response);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
    const document = await readJsonResponseDocument<T>(response);
    return document.value;
}

async function readJsonResponseDocument<T>(
    response: Response
): Promise<ControlResponseDocument<T>> {
    const text = await response.text();
    const body = decodeControlReplyBody(text);
    if (!response.ok) {
        throw new ControlRunManagerHttpError(
            toControlErrorMessage(response, body),
            response.status,
            response.statusText
        );
    }
    if (body.kind === 'unparsed') {
        throw body.error;
    }
    return {
        value: (body.kind === 'json' ? body.value : {}) as T,
        text
    };
}

async function readTextResponse(response: Response): Promise<string> {
    const text = await response.text();
    if (response.ok) {
        return text;
    }
    const body = decodeControlReplyBody(text);
    throw new ControlRunManagerHttpError(
        body.kind === 'unparsed' ? text : toControlErrorMessage(response, body),
        response.status,
        response.statusText
    );
}
