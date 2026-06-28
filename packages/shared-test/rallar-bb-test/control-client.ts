import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestReportFragment,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStatsSnapshot,
} from './types.ts';
import type { RallarBlackBoxControlAgentIdentity } from './distributed-run.ts';
import { redactRallarBlackBoxValue } from './redaction.ts';
import {
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlResultEnvelope,
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    toControlEventEnvelope,
} from './control-protocol.ts';

export type RallarBlackBoxControlConnectionState =
    | 'idle'
    | 'connecting'
    | 'registered'
    | 'disconnected'
    | 'reconnecting'
    | 'failed';

export type RallarBlackBoxControlSnapshot = Readonly<{
    state: RallarBlackBoxControlConnectionState;
    url?: string;
    runId?: string;
    agentId?: string;
    connectedAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    lastStatsAtEpochMs?: number;
    lastReportAtEpochMs?: number;
    lastReportUploadAtEpochMs?: number;
    lastMessageAtEpochMs?: number;
    reconnectAttempt: number;
    sentCount: number;
    receivedCount: number;
    identity?: RallarBlackBoxControlAgentIdentity;
    lastError?: string;
}>;

type WebSocketLike = {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
    onopen?: ((event: unknown) => void) | null;
    onmessage?: ((event: unknown) => void) | null;
    onclose?: ((event: unknown) => void) | null;
    onerror?: ((event: unknown) => void) | null;
};

export type RallarBlackBoxControlWebSocketFactory = (
    url: string,
) => WebSocketLike;

export type RallarBlackBoxControlFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type RallarBlackBoxControlClientOptions = Readonly<{
    runtime: RallarBlackBoxTestRuntime;
    webSocketFactory?: RallarBlackBoxControlWebSocketFactory;
    fetch?: RallarBlackBoxControlFetch;
    token?: string;
    heartbeatIntervalMs?: number;
    statsIntervalMs?: number;
    finalReportUploadUrl?: string;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    onSnapshot?: (snapshot: RallarBlackBoxControlSnapshot) => void;
}>;

export type RallarBlackBoxControlConnectOptions = Readonly<{
    url: string;
    runId: string;
    agentId: string;
    token?: string;
    finalReportUploadUrl?: string;
}>;

const OPEN_STATE = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STATS_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_BASE_MS = 600;
const DEFAULT_RECONNECT_MAX_MS = 5_000;

function addSocketListener(
    socket: WebSocketLike,
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
): () => void {
    if (socket.addEventListener && socket.removeEventListener) {
        socket.addEventListener(type, listener);
        return () => socket.removeEventListener?.(type, listener);
    }

    const property = `on${type}` as keyof Pick<
        WebSocketLike,
        'onopen' | 'onmessage' | 'onclose' | 'onerror'
    >;
    const previous = socket[property];
    const next = (event: unknown) => {
        previous?.(event);
        listener(event);
    };
    socket[property] = next;
    return () => {
        if (socket[property] === next) {
            socket[property] = previous;
        }
    };
}

function eventData(event: unknown): unknown {
    return event && typeof event === 'object' && 'data' in event
        ? (event as { data: unknown }).data
        : event;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
    return new WebSocket(url) as WebSocketLike;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (error && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }

    return String(error);
}

function commandForEnvelope(envelope: ControlCommandEnvelope): RallarBlackBoxTestCommand {
    return {
        ...envelope.command,
        commandId: envelope.commandId,
        deadlineEpochMs: envelope.deadlineEpochMs ?? envelope.command.deadlineEpochMs,
    } as RallarBlackBoxTestCommand;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function firstString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    return undefined;
}

const CONTROL_AGENT_CRDT_TRANSPORTS = [
    'local-only',
    'ws',
    'rtc',
    'ws-then-rtc',
    'rtc-with-ws-fallback',
] as const;

function hasCrdtRuntimeHints(config: RallarBlackBoxTestState['currentConfig']): boolean {
    const rallar = asRecord(config?.rallar);
    return Boolean(
        rallar.crdt === true ||
            typeof rallar.crdtTransport === 'string' ||
            rallar.crdtRuntime === true,
    );
}

function isCrdtCapableProvider(providerMode: string | undefined): boolean {
    return providerMode === 'browser-rallar' ||
        providerMode === 'rallar-browser' ||
        providerMode === 'rallar-remote-browser' ||
        providerMode === 'mixed';
}

function toControlAgentIdentity(
    state: RallarBlackBoxTestState,
    agentId: string,
): RallarBlackBoxControlAgentIdentity | undefined {
    const config = state.currentConfig;
    if (!config) {
        return {
            sessionLabel: agentId,
            updatedAtEpochMs: Date.now(),
        };
    }

    const rallar = asRecord(config.rallar);
    const rallarScope = asRecord(rallar.scope);
    const defaults = asRecord(config.defaults);
    const control = asRecord(config.control);
    const browser = asRecord(config.browser);
    const fleet = asRecord(config.fleet);
    const principalId = firstString(rallar.principalId, rallar.clientId, config.actor);
    const sessionId = firstString(rallar.sessionId, config.sessionId);
    const providerMode = firstString(control.providerMode, defaults.providerMode, rallar.providerMode);
    const apiBaseUrl = firstString(config.apiBaseUrl, rallar.apiBaseUrl, defaults.apiBaseUrl);
    const crdtSupported = isCrdtCapableProvider(providerMode) || hasCrdtRuntimeHints(config);
    const identity: RallarBlackBoxControlAgentIdentity = {
        principalId,
        clientId: firstString(rallar.clientId, principalId),
        username: firstString(rallar.username, config.actor, principalId),
        sessionId,
        clientInstanceId: firstString(rallar.clientInstanceId, rallar.instanceId, principalId),
        applicationId: firstString(defaults.applicationId, rallar.applicationId, rallarScope.applicationId),
        workspaceId: firstString(defaults.workspaceId, rallar.workspaceId, rallarScope.workspaceId),
        groupId: firstString(defaults.groupId, rallar.groupId, config.roomId),
        providerMode,
        browserLabel: firstString(browser.label, browser.name, globalThis.navigator?.userAgent),
        sessionLabel: firstString(
            browser.sessionLabel,
            sessionId && principalId ? `${principalId}:${sessionId}` : undefined,
            agentId,
        ),
        region: firstString(fleet.region),
        provider: firstString(fleet.provider),
        datacenter: firstString(fleet.datacenter),
        hostId: firstString(fleet.hostId),
        agentPoolId: firstString(fleet.agentPoolId),
        deploymentId: firstString(fleet.deploymentId),
        browserName: firstString(fleet.browserName, browser.name),
        browserVersion: firstString(fleet.browserVersion, browser.version),
        os: firstString(fleet.os, browser.os),
        tags: stringArray(fleet.tags),
        capabilities: {
            crdt: {
                supported: crdtSupported,
                transports: crdtSupported ? CONTROL_AGENT_CRDT_TRANSPORTS : [],
                runtimeSurface: providerMode,
                apiBaseUrlConfigured: Boolean(apiBaseUrl),
            },
        },
        updatedAtEpochMs: Date.now(),
    };

    return Object.values(identity).some(value => value !== undefined)
        ? identity
        : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map(entry => entry.trim());
    return entries.length > 0 ? entries : undefined;
}

function toStatsSnapshot(
    state: RallarBlackBoxTestState,
    atEpochMs: number,
): RallarBlackBoxTestStatsSnapshot {
    const events = state.events;
    const config = state.currentConfig;
    const durations = state.commandHistory.map(result => result.durationMs);
    const lastRallarDiagnostic = events
        .filter(event =>
            event.topic.includes('rtc.connected') ||
            event.topic.includes('rallar.bb.fake.rtc.connected') ||
            event.topic.includes('rallar.browser.connect_completed')
        )
        .at(-1);
    const lastRallarPayload = asRecord(lastRallarDiagnostic?.payload);

    return {
        atEpochMs,
        runId: config?.runId,
        agentId: config?.agentId,
        status: state.status,
        counters: {
            commands: state.commandHistory.length,
            events: events.length,
            failures: state.failures.length,
            messages: events.filter((event) => event.kind === 'message').length,
            diagnostics: events.filter((event) => event.kind === 'diagnostic').length,
            reconnects: events.filter((event) =>
                event.topic.toLowerCase().includes('reconnect')
            ).length,
        },
        lastCommandId: state.commandHistory.at(-1)?.commandId,
        lastEventAtEpochMs: events.at(-1)?.atEpochMs,
        commandLatency: {
            count: durations.length,
            minMs: durations.length > 0 ? Math.min(...durations) : undefined,
            maxMs: durations.length > 0 ? Math.max(...durations) : undefined,
            averageMs: durations.length > 0
                ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
                : undefined,
            lastMs: durations.at(-1),
        },
        rallar: {
            connected: lastRallarDiagnostic !== undefined,
            actor: config?.actor,
            sessionId: config?.sessionId,
            roomId: config?.roomId,
            transport: config?.transport,
            peerCount: typeof lastRallarPayload.peerCount === 'number'
                ? lastRallarPayload.peerCount
                : undefined,
            laneHealth: lastRallarPayload.laneHealth,
        },
    };
}

function toReportSummary(state: RallarBlackBoxTestState): unknown {
    return {
        status: state.status,
        commands: state.commandHistory.length,
        events: state.events.length,
        failures: state.failures.length,
        latestCommandId: state.commandHistory.at(-1)?.commandId,
        latestEventAtEpochMs: state.events.at(-1)?.atEpochMs,
    };
}

function cleanupBrowserStorage(): Readonly<{
    localStorage: 'cleared' | 'failed' | 'unavailable';
    sessionStorage: 'cleared' | 'failed' | 'unavailable';
}> {
    let localStorage: 'cleared' | 'failed' | 'unavailable' = 'unavailable';
    try {
        if (globalThis.localStorage) {
            globalThis.localStorage.clear();
            localStorage = 'cleared';
        }
    } catch (_error) {
        localStorage = 'failed';
    }

    let sessionStorage: 'cleared' | 'failed' | 'unavailable' = 'unavailable';
    try {
        if (globalThis.sessionStorage) {
            globalThis.sessionStorage.clear();
            sessionStorage = 'cleared';
        }
    } catch (_error) {
        sessionStorage = 'failed';
    }

    return {
        localStorage,
        sessionStorage,
    };
}

export class RallarBlackBoxControlClient {
    private readonly runtime: RallarBlackBoxTestRuntime;
    private readonly webSocketFactory: RallarBlackBoxControlWebSocketFactory;
    private readonly fetchFn: RallarBlackBoxControlFetch;
    private readonly heartbeatIntervalMs: number;
    private readonly statsIntervalMs: number;
    private readonly finalReportUploadUrl: string | undefined;
    private readonly token: string | undefined;
    private readonly reconnectBaseMs: number;
    private readonly reconnectMaxMs: number;
    private readonly onSnapshot: ((snapshot: RallarBlackBoxControlSnapshot) => void) | undefined;
    private readonly unsubscribeRuntime: () => void;
    private readonly sentEventIds = new Set<string>();
    private statsEventSequence = 1;
    private reportSequence = 1;
    private lastTerminalReportKey: string | undefined;
    private socket: WebSocketLike | undefined;
    private disposers: Array<() => void> = [];
    private heartbeatTimer: number | undefined;
    private statsTimer: number | undefined;
    private reconnectTimer: number | undefined;
    private manualClose = false;
    private disconnectReported = false;
    private options: RallarBlackBoxControlConnectOptions | undefined;
    private snapshot: RallarBlackBoxControlSnapshot = {
        state: 'idle',
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0,
    };

    constructor(options: RallarBlackBoxControlClientOptions) {
        this.runtime = options.runtime;
        this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
        this.fetchFn = options.fetch ?? fetch;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ??
            DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.statsIntervalMs = options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
        this.finalReportUploadUrl = options.finalReportUploadUrl;
        this.token = options.token;
        this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
        this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
        this.onSnapshot = options.onSnapshot;
        this.unsubscribeRuntime = this.runtime.subscribe(state => {
            this.streamNewEvents(state);
            this.maybeSendTerminalReport(state);
        });
    }

    currentSnapshot(): RallarBlackBoxControlSnapshot {
        return this.snapshot;
    }

    connect(options: RallarBlackBoxControlConnectOptions): void {
        this.options = options;
        this.manualClose = false;
        this.disconnectReported = false;
        this.clearReconnect();
        this.openSocket('connecting');
    }

    disconnect(): void {
        if (!this.disconnectReported) {
            this.sendFinalReport('manual-disconnect');
            this.disconnectReported = true;
        }
        this.manualClose = true;
        this.clearHeartbeat();
        this.clearStats();
        this.clearReconnect();
        this.closeSocket(1000, 'manual disconnect');
        this.setSnapshot({
            state: 'disconnected',
            lastError: undefined,
        });
    }

    dispose(): void {
        this.disconnect();
        this.unsubscribeRuntime();
    }

    private openSocket(state: RallarBlackBoxControlConnectionState): void {
        const options = this.requireOptions();
        this.closeSocket(1000, 'reopening');
        this.setSnapshot({
            state,
            url: options.url,
            runId: options.runId,
            agentId: options.agentId,
            lastError: undefined,
        });

        try {
            const socket = this.webSocketFactory(options.url);
            this.socket = socket;
            this.disposers = [
                addSocketListener(socket, 'open', () => this.onOpen()),
                addSocketListener(socket, 'message', event => {
                    void this.onMessage(eventData(event));
                }),
                addSocketListener(socket, 'close', () => this.onClose()),
                addSocketListener(socket, 'error', event => this.onError(event)),
            ];
        } catch (error) {
            this.setSnapshot({
                state: 'failed',
                lastError: toErrorMessage(error),
            });
            this.scheduleReconnect();
        }
    }

    private onOpen(): void {
        this.setSnapshot({
            state: 'registered',
            connectedAtEpochMs: Date.now(),
            reconnectAttempt: 0,
            lastError: undefined,
        });
        this.sendRegister();
        this.replayCompletedResults();
        this.streamNewEvents(this.runtime.state());
        this.sendHeartbeat();
        this.sendStats();
        this.startHeartbeat();
        this.startStats();
    }

    private async onMessage(data: unknown): Promise<void> {
        const options = this.requireOptions();
        this.setSnapshot({
            receivedCount: this.snapshot.receivedCount + 1,
            lastMessageAtEpochMs: Date.now(),
        });

        const parsed = parseControlServerMessage(data, {
            runId: options.runId,
            agentId: options.agentId,
        });
        if (!parsed.ok) {
            this.recordDiagnostic('rallar.bb.control.protocol_error', 'error', {
                error: parsed.error,
                data,
            });
            return;
        }

        await this.dispatchCommand(parsed.envelope);
    }

    private onClose(): void {
        this.clearHeartbeat();
        this.clearStats();
        this.closeSocket();
        if (this.manualClose) {
            return;
        }

        this.setSnapshot({
            state: 'disconnected',
        });
        this.scheduleReconnect();
    }

    private onError(event: unknown): void {
        this.setSnapshot({
            lastError: toErrorMessage(event),
        });
        this.recordDiagnostic('rallar.bb.control.socket_error', 'error', {
            event,
        });
    }

    private scheduleReconnect(): void {
        if (this.manualClose || !this.options) {
            return;
        }

        const attempt = this.snapshot.reconnectAttempt + 1;
        const delayMs = Math.min(
            this.reconnectMaxMs,
            this.reconnectBaseMs * 2 ** Math.max(0, attempt - 1),
        );
        this.setSnapshot({
            state: 'reconnecting',
            reconnectAttempt: attempt,
        });
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openSocket('reconnecting');
        }, delayMs);
    }

    private async dispatchCommand(envelope: ControlCommandEnvelope): Promise<void> {
        const command = commandForEnvelope(envelope);
        const cached = this.runtime.state().resultCache[envelope.commandId];
        if (cached) {
            this.sendResult(cached, true);
            return;
        }

        this.recordDiagnostic('rallar.bb.control.command_received', 'info', {
            commandId: envelope.commandId,
            command: envelope.command,
        }, envelope.commandId);

        if (command.kind === 'reset') {
            this.recordDiagnostic(
                'rallar.bb.control.browser_storage_cleaned',
                'info',
                cleanupBrowserStorage(),
                envelope.commandId,
            );
        }

        const result = await this.runtime.execute(command);
        this.sendResult(result);
    }

    private sendRegister(): void {
        const options = this.requireOptions();
        const identity = toControlAgentIdentity(this.runtime.state(), options.agentId);
        this.setSnapshot({ identity });
        this.sendEnvelope({
            kind: 'register',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            token: options.token ?? this.token,
            atEpochMs: Date.now(),
            identity,
            resume: {
                completedCommandIds: Object.keys(this.runtime.state().resultCache),
            },
        });
    }

    private sendHeartbeat(): void {
        const options = this.requireOptions();
        const state = this.runtime.state();
        const identity = toControlAgentIdentity(state, options.agentId);
        this.sendEnvelope({
            kind: 'heartbeat',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            atEpochMs: Date.now(),
            status: state.status,
            identity,
            lastCommandId: state.commandHistory.at(-1)?.commandId,
            lastEventAtEpochMs: state.events.at(-1)?.atEpochMs,
        });
        this.setSnapshot({
            lastHeartbeatAtEpochMs: Date.now(),
            identity,
        });
    }

    private startHeartbeat(): void {
        this.clearHeartbeat();
        this.heartbeatTimer = window.setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    private sendStats(): void {
        const options = this.requireOptions();
        const atEpochMs = Date.now();
        const stats = toStatsSnapshot(this.runtime.state(), atEpochMs);
        const event: RallarBlackBoxTestEvent = {
            eventId: `control-stats-${this.statsEventSequence++}`,
            kind: 'stats',
            topic: 'rallar.bb.stats',
            atEpochMs,
            severity: 'info',
            payload: stats,
        };

        this.sendEnvelope({
            kind: 'stats',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            atEpochMs,
            eventId: event.eventId,
            payload: event,
        });
        this.setSnapshot({
            lastStatsAtEpochMs: atEpochMs,
        });
    }

    private startStats(): void {
        this.clearStats();
        if (this.statsIntervalMs <= 0) {
            return;
        }

        this.statsTimer = window.setInterval(() => {
            this.sendStats();
        }, this.statsIntervalMs);
    }

    private toReport(reason: string): RallarBlackBoxTestReportFragment {
        const options = this.requireOptions();
        const state = this.runtime.state();
        const atEpochMs = Date.now();
        const report: RallarBlackBoxTestReportFragment = {
            reportId: `control-report-${this.reportSequence++}`,
            runId: options.runId,
            agentId: options.agentId,
            atEpochMs,
            summary: {
                ...asRecord(toReportSummary(state)),
                reason,
            },
            results: state.commandHistory,
            events: state.events,
            stats: toStatsSnapshot(state, atEpochMs),
        };

        return redactRallarBlackBoxValue(report, state.currentConfig?.redaction);
    }

    private sendFinalReport(reason: string): void {
        if (!this.options) {
            return;
        }

        const options = this.requireOptions();
        const atEpochMs = Date.now();
        const report = this.toReport(reason);
        const event: RallarBlackBoxTestEvent = {
            eventId: `control-report-event-${report.reportId}`,
            kind: 'report',
            topic: 'rallar.bb.report.final',
            atEpochMs,
            severity: 'info',
            payload: report,
        };
        const envelope: ControlClientEnvelope = {
            kind: 'report',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            atEpochMs,
            eventId: event.eventId,
            payload: event,
        };

        this.sendEnvelope(envelope);
        this.uploadFinalReport(envelope);
        this.setSnapshot({
            lastReportAtEpochMs: atEpochMs,
        });
    }

    private uploadFinalReport(envelope: ControlClientEnvelope): void {
        if (envelope.kind !== 'report') {
            return;
        }

        const uploadUrl = this.options?.finalReportUploadUrl ?? this.finalReportUploadUrl;
        if (!uploadUrl) {
            return;
        }

        void this.fetchFn(uploadUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.authorizationHeader(),
            },
            body: JSON.stringify(envelope),
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Final report upload failed: ${response.status} ${response.statusText}`);
                }
                this.setSnapshot({
                    lastReportUploadAtEpochMs: Date.now(),
                });
            })
            .catch(error => {
                this.setSnapshot({
                    lastError: toErrorMessage(error),
                });
                this.recordDiagnostic('rallar.bb.control.report_upload_failed', 'warning', {
                    error: toErrorMessage(error),
                    uploadUrl,
                });
            });
    }

    private replayCompletedResults(): void {
        Object.values(this.runtime.state().resultCache)
            .forEach(result => this.sendResult(result, true));
    }

    private sendResult(result: RallarBlackBoxTestResult, replayed = false): void {
        const options = this.requireOptions();
        const envelope: ControlResultEnvelope = {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            commandId: result.commandId,
            ok: result.ok,
            result: result.ok ? result : undefined,
            error: result.ok
                ? undefined
                : {
                    code: result.error?.code ?? 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                    message: result.error?.message ?? 'Command failed.',
                    details: result.error?.details,
                },
            replayed,
        };
        this.sendEnvelope(envelope);
    }

    private streamNewEvents(state: RallarBlackBoxTestState): void {
        if (!this.canSend()) {
            return;
        }

        const options = this.requireOptions();
        for (const event of state.events) {
            if (this.sentEventIds.has(event.eventId)) {
                continue;
            }

            this.sentEventIds.add(event.eventId);
            this.sendEnvelope(toControlEventEnvelope(event, options.runId, options.agentId));
        }
    }

    private maybeSendTerminalReport(state: RallarBlackBoxTestState): void {
        if (
            state.status !== 'completed' &&
            state.status !== 'failed' &&
            state.status !== 'cancelled'
        ) {
            return;
        }

        const latestCommandId = state.commandHistory.at(-1)?.commandId;
        const reportKey = `${state.status}:${latestCommandId ?? 'no-command'}:${state.commandHistory.length}`;
        if (this.lastTerminalReportKey === reportKey) {
            return;
        }

        this.lastTerminalReportKey = reportKey;
        this.sendFinalReport(`runtime-${state.status}`);
    }

    private recordDiagnostic(
        topic: string,
        severity: 'info' | 'warning' | 'error',
        payload: unknown,
        commandId?: string,
    ): void {
        this.runtime.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId,
            severity,
            payload,
        });
    }

    private sendEnvelope(envelope: ControlClientEnvelope): void {
        if (!this.canSend()) {
            return;
        }

        this.socket?.send(JSON.stringify(envelope));
        this.setSnapshot({
            sentCount: this.snapshot.sentCount + 1,
        });
    }

    private canSend(): boolean {
        return this.socket?.readyState === OPEN_STATE;
    }

    private authorizationHeader(): Record<string, string> {
        const token = this.options?.token ?? this.token;
        return token
            ? {
                Authorization: `Bearer ${token}`,
            }
            : {};
    }

    private closeSocket(code?: number, reason?: string): void {
        this.disposers.forEach(dispose => dispose());
        this.disposers = [];
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            try {
                socket.close(code, reason);
            } catch (_error) {
                // Closing is best-effort during reconnect/disconnect cleanup.
            }
        }
    }

    private clearHeartbeat(): void {
        if (this.heartbeatTimer !== undefined) {
            window.clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private clearStats(): void {
        if (this.statsTimer !== undefined) {
            window.clearInterval(this.statsTimer);
            this.statsTimer = undefined;
        }
    }

    private clearReconnect(): void {
        if (this.reconnectTimer !== undefined) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private requireOptions(): RallarBlackBoxControlConnectOptions {
        if (!this.options) {
            throw new Error('Control client is not configured.');
        }

        return this.options;
    }

    private setSnapshot(patch: Partial<RallarBlackBoxControlSnapshot>): void {
        this.snapshot = {
            ...this.snapshot,
            ...patch,
        };
        this.onSnapshot?.(this.snapshot);
    }
}
