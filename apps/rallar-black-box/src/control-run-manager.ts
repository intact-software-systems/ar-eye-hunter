import type {
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlResultEnvelope,
} from './control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

export type ControlQueuedCommandSnapshot = Readonly<{
    envelope: ControlCommandEnvelope;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
}>;

export type ControlAgentSnapshot = Readonly<{
    runId: string;
    agentId: string;
    connected: boolean;
    registeredAtEpochMs?: number;
    disconnectedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    status?: string;
    connectionSequence: number;
    reconnectCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    completedCommandIds: readonly string[];
    resumeCompletedCommandIds: readonly string[];
}>;

export type ControlRunSnapshot = Readonly<{
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: readonly ControlAgentSnapshot[];
    commands: readonly ControlQueuedCommandSnapshot[];
    results: readonly ControlResultEnvelope[];
    events: readonly ControlEventEnvelope[];
    stats: readonly ControlEventEnvelope[];
    reports: readonly ControlEventEnvelope[];
    heartbeats: readonly ControlHeartbeatEnvelope[];
}>;

export type ControlServerSnapshot = Readonly<{
    runs: readonly ControlRunSnapshot[];
}>;

export type ControlSnapshotBounds = Readonly<{
    commands?: number;
    results?: number;
    events?: number;
    stats?: number;
    reports?: number;
    heartbeats?: number;
}>;

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

export type EnqueueBulkControlCommandResult = Readonly<{
    accepted: true;
    commands: readonly ControlCommandEnvelope[];
}>;

export type ControlRunArtifactFileName =
    | 'report.json'
    | 'events.jsonl'
    | 'failures.json'
    | 'metadata.json';

export type ControlRunArtifactBundle = Readonly<{
    artifactSchemaVersion: number;
    runId: string;
    generatedAtEpochMs: number;
    files: Readonly<Record<ControlRunArtifactFileName, string>>;
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

export async function fetchControlServerSnapshot(input: Readonly<{
    baseUrl: string;
    token?: string;
    bounds?: ControlSnapshotBounds;
    fetchFn?: ControlRunManagerFetch;
}>): Promise<ControlServerSnapshot> {
    const response = await (input.fetchFn ?? fetch)(controlRunSnapshotUrl(
        input.baseUrl,
        undefined,
        input.bounds,
    ), {
        headers: authorizationHeaders(input.token),
    });
    return readJsonResponse<ControlServerSnapshot>(response);
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

async function readJsonResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const value = text.length > 0 ? JSON.parse(text) : {};
    if (!response.ok) {
        const message = value && typeof value === 'object' && 'error' in value
            ? String((value as { error: unknown }).error)
            : `Control server request failed: ${response.status} ${response.statusText}`;
        throw new Error(message);
    }
    return value as T;
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
        throw new Error(message);
    }
    return text;
}
