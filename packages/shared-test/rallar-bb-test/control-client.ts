import { toError } from '@shared/resilience/to-error.ts';

import { toAgentReloadResult, writeAgentResumeRecord } from './alm/browser-control-agent-resume.ts';
import { deleteBrowserStorageEntries } from './control-client/delete-browser-storage-entries.ts';
import {
    decodeControlAgentFleetLocation,
    toControlAgentIdentity
} from './control-client/to-control-agent-identity.ts';
import { toControlAgentReport } from './control-client/to-control-agent-report.ts';
import {
    writeControlFinalReport,
    type RallarBlackBoxControlFetch
} from './control-client/write-control-final-report.ts';
import {
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    toControlEventEnvelope,
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from './control-protocol.ts';
import type { RallarBlackBoxControlAgentIdentity } from './distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState
} from './rallar-black-box-test-contracts.ts';
import { toRuntimeStats } from './runtime/to-runtime-stats.ts';

export type RallarBlackBoxControlConnectionState =
    | 'idle'
    | 'connecting'
    | 'registered'
    | 'disconnected'
    | 'reconnecting'
    | 'failed';

export interface RallarBlackBoxControlSnapshot {
    readonly state: RallarBlackBoxControlConnectionState;
    /** Absent before the client is given a control URL. */
    readonly url?: string;
    /** Absent before the client connects to a run. */
    readonly runId?: string;
    /** Absent before the client connects to a run. */
    readonly agentId?: string;
    /** Absent before a control socket opens. */
    readonly connectedAtEpochMs?: number;
    /** Absent before the client sends a heartbeat. */
    readonly lastHeartbeatAtEpochMs?: number;
    /** Absent before the client sends stats. */
    readonly lastStatsAtEpochMs?: number;
    /** Absent before the client sends a final report. */
    readonly lastReportAtEpochMs?: number;
    /** Absent before a final report upload succeeds. */
    readonly lastReportUploadAtEpochMs?: number;
    /** Absent before the control server sends a message. */
    readonly lastMessageAtEpochMs?: number;
    readonly reconnectAttempt: number;
    readonly sentCount: number;
    readonly receivedCount: number;
    /** Absent before the client registers. */
    readonly identity?: RallarBlackBoxControlAgentIdentity;
    /** Absent while the connection carries no unresolved error. */
    readonly lastError?: string;
}

export type RallarBlackBoxControlSocketEventType = 'open' | 'message' | 'close' | 'error';

export interface RallarBlackBoxControlSocketEvent {
    /** Absent on open, close and error events. */
    readonly data?: string | ArrayBuffer | Blob;
    /** Absent unless an error event carries a message, as Deno and ws socket errors do; browser error events carry none. */
    readonly message?: string;
}

export type RallarBlackBoxControlSocketListener = (event: RallarBlackBoxControlSocketEvent) => void;

export interface RallarBlackBoxControlWebSocket {
    readonly readyState: number;
    send(message: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void;
    removeEventListener(
        type: RallarBlackBoxControlSocketEventType,
        listener: RallarBlackBoxControlSocketListener
    ): void;
}

export type RallarBlackBoxControlWebSocketFactory = (url: string) => RallarBlackBoxControlWebSocket;

export type RallarBlackBoxControlSnapshotListener = (snapshot: RallarBlackBoxControlSnapshot) => void;

export interface RallarBlackBoxControlClientOptions {
    readonly runtime: RallarBlackBoxTestRuntime;
    readonly webSocketFactory: RallarBlackBoxControlWebSocketFactory;
    readonly fetch: RallarBlackBoxControlFetch;
    readonly heartbeatIntervalMs: number;
    /** Zero turns periodic stats off. */
    readonly statsIntervalMs: number;
    readonly reconnectBaseMs: number;
    readonly reconnectMaxMs: number;
}

export interface RallarBlackBoxControlConnectOptions {
    readonly url: string;
    readonly runId: string;
    readonly agentId: string;
    /** Absent when the control server admits the agent without a run token. */
    readonly token?: string;
    /** Absent when the agent sends its final report only over the control socket. */
    readonly finalReportUploadUrl?: string;
    readonly completedCommandIds: readonly string[];
}

export interface RallarBlackBoxAgentControlClient {
    subscribe(listener: RallarBlackBoxControlSnapshotListener): () => void;
    connect(connection: RallarBlackBoxControlConnectOptions): void;
    dispose(): void;
}

interface ControlAgentIdentityReading {
    readonly identity: RallarBlackBoxControlAgentIdentity;
    /** Absent when no fleet location is configured or the configured one decodes. */
    readonly locationIssue: string | undefined;
}

interface ControlClientDiagnostic {
    readonly topic: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly payload: object;
    /** Absent when no command caused the diagnostic. */
    readonly commandId?: string;
}

const OPEN_STATE = 1;
const DEFAULT_RECONNECT_BASE_MS = 600;
const DEFAULT_RECONNECT_MAX_MS = 5_000;
const TERMINAL_RUNTIME_STATUSES: readonly RallarBlackBoxTestRuntimeStatus[] = ['completed', 'failed', 'cancelled'];

export function createDefaultRallarBlackBoxControlClient(
    input: Pick<RallarBlackBoxControlClientOptions, 'runtime' | 'heartbeatIntervalMs' | 'statsIntervalMs'>
): RallarBlackBoxControlClient {
    return new RallarBlackBoxControlClient({
        ...input,
        webSocketFactory: (url) => new WebSocket(url),
        fetch: (request, init) => globalThis.fetch(request, init),
        reconnectBaseMs: DEFAULT_RECONNECT_BASE_MS,
        reconnectMaxMs: DEFAULT_RECONNECT_MAX_MS
    });
}

export class RallarBlackBoxControlClient implements RallarBlackBoxAgentControlClient {
    private readonly options: RallarBlackBoxControlClientOptions;
    private readonly unsubscribeRuntime: () => void;
    private readonly snapshotListeners = new Set<RallarBlackBoxControlSnapshotListener>();
    private readonly sentEventIds = new Set<string>();
    private statsEventSequence = 1;
    private reportSequence = 1;
    private lastTerminalReportKey: string | undefined;
    private lastIdentityIssue: string | undefined;
    private connection: RallarBlackBoxControlConnectOptions | undefined;
    private socket: RallarBlackBoxControlWebSocket | undefined;
    private removeSocketListeners: (() => void) | undefined;
    private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    private statsTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    private manualClose = false;
    private disconnectReported = false;
    private snapshot: RallarBlackBoxControlSnapshot = {
        state: 'idle',
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0
    };

    constructor(options: RallarBlackBoxControlClientOptions) {
        this.options = options;
        this.unsubscribeRuntime = options.runtime.subscribe((state) => {
            this.sendNewEvents(state);
            this.sendTerminalReport(state);
        });
    }

    getSnapshot(): RallarBlackBoxControlSnapshot {
        return this.snapshot;
    }

    subscribe(listener: RallarBlackBoxControlSnapshotListener): () => void {
        this.snapshotListeners.add(listener);
        return () => {
            this.snapshotListeners.delete(listener);
        };
    }

    connect(connection: RallarBlackBoxControlConnectOptions): void {
        this.connection = connection;
        this.manualClose = false;
        this.disconnectReported = false;
        this.stopReconnectTimer();
        this.openSocket('connecting');
    }

    disconnect(): void {
        if (!this.disconnectReported) {
            this.sendFinalReport('manual-disconnect');
            this.disconnectReported = true;
        }
        this.manualClose = true;
        this.stopHeartbeat();
        this.stopStats();
        this.stopReconnectTimer();
        this.closeSocket(1000, 'manual disconnect');
        this.setSnapshot({ state: 'disconnected', lastError: undefined });
    }

    dispose(): void {
        this.disconnect();
        this.unsubscribeRuntime();
    }

    private openSocket(state: RallarBlackBoxControlConnectionState): void {
        const connection = this.assertConnection();
        this.closeSocket(1000, 'reopening');
        this.setSnapshot({
            state,
            url: connection.url,
            runId: connection.runId,
            agentId: connection.agentId,
            lastError: undefined
        });

        try {
            const socket = this.options.webSocketFactory(connection.url);
            this.socket = socket;
            this.removeSocketListeners = this.subscribeToSocket(socket);
        }
        catch (caught) {
            this.setSnapshot({ state: 'failed', lastError: toError(caught).message });
            this.startReconnectTimer();
        }
    }

    private subscribeToSocket(socket: RallarBlackBoxControlWebSocket): () => void {
        socket.addEventListener('open', this.onSocketOpen);
        socket.addEventListener('message', this.onSocketMessage);
        socket.addEventListener('close', this.onSocketClose);
        socket.addEventListener('error', this.onSocketError);
        return () => {
            socket.removeEventListener('open', this.onSocketOpen);
            socket.removeEventListener('message', this.onSocketMessage);
            socket.removeEventListener('close', this.onSocketClose);
            socket.removeEventListener('error', this.onSocketError);
        };
    }

    private readonly onSocketOpen = (): void => {
        this.setSnapshot({
            state: 'registered',
            connectedAtEpochMs: Date.now(),
            reconnectAttempt: 0,
            lastError: undefined
        });
        this.sendRegister();
        this.sendCompletedResults();
        this.sendNewEvents(this.options.runtime.state());
        this.sendHeartbeat();
        this.sendStats();
        this.startHeartbeat();
        this.startStats();
    };

    private readonly onSocketMessage = (event: RallarBlackBoxControlSocketEvent): void => {
        const connection = this.assertConnection();
        this.setSnapshot({
            receivedCount: this.snapshot.receivedCount + 1,
            lastMessageAtEpochMs: Date.now()
        });

        const parsed = parseControlServerMessage(event.data, {
            runId: connection.runId,
            agentId: connection.agentId
        });
        if (!parsed.ok) {
            this.recordDiagnostic({
                topic: 'rallar.bb.control.protocol_error',
                severity: 'error',
                payload: { error: parsed.error, data: event.data }
            });
            return;
        }

        void this.runCommand(parsed.envelope);
    };

    private readonly onSocketClose = (): void => {
        this.stopHeartbeat();
        this.stopStats();
        this.closeSocket();
        if (this.manualClose) {
            return;
        }

        this.setSnapshot({ state: 'disconnected' });
        this.startReconnectTimer();
    };

    private readonly onSocketError = (event: RallarBlackBoxControlSocketEvent): void => {
        this.setSnapshot({ lastError: event.message ?? String(event) });
        this.recordDiagnostic({ topic: 'rallar.bb.control.socket_error', severity: 'error', payload: { event } });
    };

    private startReconnectTimer(): void {
        if (this.manualClose || !this.connection) {
            return;
        }

        const attempt = this.snapshot.reconnectAttempt + 1;
        const delayMs = Math.min(
            this.options.reconnectMaxMs,
            this.options.reconnectBaseMs * 2 ** Math.max(0, attempt - 1)
        );
        this.setSnapshot({ state: 'reconnecting', reconnectAttempt: attempt });
        this.reconnectTimer = globalThis.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openSocket('reconnecting');
        }, delayMs);
    }

    private async runCommand(envelope: ControlCommandEnvelope): Promise<void> {
        const cached = this.options.runtime.state().resultCache[envelope.commandId];
        if (cached) {
            this.sendResult(cached, true);
            return;
        }

        this.recordDiagnostic({
            topic: 'rallar.bb.control.command_received',
            severity: 'info',
            payload: { commandId: envelope.commandId, command: envelope.command },
            commandId: envelope.commandId
        });
        const command = toEnvelopeCommand(envelope);
        if (command.kind === 'agent.reload') {
            this.startAgentReload(envelope.commandId, command.readyTimeoutMs);
            return;
        }
        if (command.kind === 'reset') {
            this.recordDiagnostic({
                topic: 'rallar.bb.control.browser_storage_cleaned',
                severity: 'info',
                payload: deleteBrowserStorageEntries(),
                commandId: envelope.commandId
            });
        }

        this.sendResult(await this.options.runtime.execute(command), false);
    }

    /** The result only buffers on the socket, so the reload waits one macrotask to give that write a turn to flush. */
    private startAgentReload(commandId: string, readyTimeoutMs: number): void {
        const connection = this.assertConnection();
        const written = writeAgentResumeRecord({
            runId: connection.runId,
            agentId: connection.agentId,
            completedCommandIds: this.resolveCompletedCommandIds([commandId])
        });
        this.sendResult(toAgentReloadResult({ commandId, readyTimeoutMs, written, atEpochMs: Date.now() }), false);
        if (written === 'written') {
            globalThis.setTimeout(() => globalThis.location.reload(), 0);
        }
    }

    private resolveCompletedCommandIds(extraCommandIds: readonly string[]): readonly string[] {
        return [
            ...new Set([
                ...this.assertConnection().completedCommandIds,
                ...Object.keys(this.options.runtime.state().resultCache),
                ...extraCommandIds
            ])
        ];
    }

    private sendRegister(): void {
        const connection = this.assertConnection();
        const atEpochMs = Date.now();
        const identity = this.readAgentIdentity(connection.agentId, atEpochMs);
        this.setSnapshot({ identity: identity.identity });
        this.sendEnvelope({
            kind: 'register',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: connection.runId,
            agentId: connection.agentId,
            token: connection.token,
            atEpochMs,
            identity: identity.identity,
            resume: { completedCommandIds: this.resolveCompletedCommandIds([]) }
        });
        this.recordIdentityIssue(identity.locationIssue);
    }

    private sendHeartbeat(): void {
        const connection = this.assertConnection();
        const state = this.options.runtime.state();
        const atEpochMs = Date.now();
        const identity = this.readAgentIdentity(connection.agentId, atEpochMs);
        this.sendEnvelope({
            kind: 'heartbeat',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: connection.runId,
            agentId: connection.agentId,
            atEpochMs,
            status: state.status,
            identity: identity.identity,
            lastCommandId: state.commandHistory.at(-1)?.commandId,
            lastEventAtEpochMs: state.events.at(-1)?.atEpochMs
        });
        this.setSnapshot({ lastHeartbeatAtEpochMs: atEpochMs, identity: identity.identity });
        this.recordIdentityIssue(identity.locationIssue);
    }

    private readAgentIdentity(agentId: string, atEpochMs: number): ControlAgentIdentityReading {
        const config = this.options.runtime.state().currentConfig;
        const location = decodeControlAgentFleetLocation(config);
        return {
            identity: toControlAgentIdentity({
                config,
                agentId,
                userAgent: globalThis.navigator?.userAgent,
                location: location.right?.location,
                atEpochMs
            }),
            locationIssue: location.left
        };
    }

    /** An unreadable configured location leaves the identity without one and is reported once until it changes. */
    private recordIdentityIssue(issue: string | undefined): void {
        if (issue !== undefined && issue !== this.lastIdentityIssue) {
            this.recordDiagnostic({
                topic: 'rallar.bb.control.identity_invalid',
                severity: 'error',
                payload: { issue }
            });
        }
        this.lastIdentityIssue = issue;
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = globalThis.setInterval(() => this.sendHeartbeat(), this.options.heartbeatIntervalMs);
    }

    private sendStats(): void {
        const connection = this.assertConnection();
        const atEpochMs = Date.now();
        const event: RallarBlackBoxTestEvent = {
            eventId: `control-stats-${this.statsEventSequence++}`,
            kind: 'stats',
            topic: 'rallar.bb.stats',
            atEpochMs,
            severity: 'info',
            payload: toRuntimeStats(this.options.runtime.state(), atEpochMs)
        };
        this.sendEnvelope({
            kind: 'stats',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: connection.runId,
            agentId: connection.agentId,
            atEpochMs,
            eventId: event.eventId,
            payload: event
        });
        this.setSnapshot({ lastStatsAtEpochMs: atEpochMs });
    }

    private startStats(): void {
        this.stopStats();
        if (this.options.statsIntervalMs > 0) {
            this.statsTimer = globalThis.setInterval(() => this.sendStats(), this.options.statsIntervalMs);
        }
    }

    private sendFinalReport(reason: string): void {
        const connection = this.connection;
        if (!connection) {
            return;
        }

        const atEpochMs = Date.now();
        const report = toControlAgentReport({
            runId: connection.runId,
            agentId: connection.agentId,
            reportId: `control-report-${this.reportSequence++}`,
            reason,
            state: this.options.runtime.state(),
            atEpochMs
        });
        const event: RallarBlackBoxTestEvent = {
            eventId: `control-report-event-${report.reportId}`,
            kind: 'report',
            topic: 'rallar.bb.report.final',
            atEpochMs,
            severity: 'info',
            payload: report
        };
        const envelope: ControlEventEnvelope = {
            kind: 'report',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: connection.runId,
            agentId: connection.agentId,
            atEpochMs,
            eventId: event.eventId,
            payload: event
        };
        this.sendEnvelope(envelope);
        if (connection.finalReportUploadUrl) {
            void this.writeFinalReport(envelope, connection.finalReportUploadUrl, connection.token);
        }
        this.setSnapshot({ lastReportAtEpochMs: atEpochMs });
    }

    private async writeFinalReport(
        envelope: ControlEventEnvelope,
        uploadUrl: string,
        token: string | undefined
    ): Promise<void> {
        const upload = await writeControlFinalReport({ fetch: this.options.fetch, uploadUrl, token, envelope });
        upload.fold(
            (failure) => {
                this.setSnapshot({ lastError: failure });
                this.recordDiagnostic({
                    topic: 'rallar.bb.control.report_upload_failed',
                    severity: 'warning',
                    payload: { error: failure, uploadUrl }
                });
            },
            () => this.setSnapshot({ lastReportUploadAtEpochMs: Date.now() })
        );
    }

    private sendCompletedResults(): void {
        Object.values(this.options.runtime.state().resultCache).forEach((result) => this.sendResult(result, true));
    }

    private sendResult(result: RallarBlackBoxTestResult, replayed: boolean): void {
        const connection = this.assertConnection();
        const envelope: ControlResultEnvelope = {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: connection.runId,
            agentId: connection.agentId,
            commandId: result.commandId,
            ok: result.ok,
            result: result.ok ? result : undefined,
            error: result.ok
                ? undefined
                : {
                    code: result.error?.code ?? 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                    message: result.error?.message ?? 'Command failed.',
                    details: result.error?.details
                },
            replayed
        };
        this.sendEnvelope(envelope);
    }

    private sendNewEvents(state: RallarBlackBoxTestState): void {
        const connection = this.connection;
        if (!connection || !this.isSocketOpen()) {
            return;
        }

        for (const event of state.events) {
            if (!this.sentEventIds.has(event.eventId)) {
                this.sentEventIds.add(event.eventId);
                this.sendEnvelope(toControlEventEnvelope(event, connection.runId, connection.agentId));
            }
        }
    }

    private sendTerminalReport(state: RallarBlackBoxTestState): void {
        if (!TERMINAL_RUNTIME_STATUSES.includes(state.status)) {
            return;
        }

        const latestCommandId = state.commandHistory.at(-1)?.commandId ?? 'no-command';
        const reportKey = `${state.status}:${latestCommandId}:${state.commandHistory.length}`;
        if (this.lastTerminalReportKey !== reportKey) {
            this.lastTerminalReportKey = reportKey;
            this.sendFinalReport(`runtime-${state.status}`);
        }
    }

    private recordDiagnostic(diagnostic: ControlClientDiagnostic): void {
        this.options.runtime.recordEvent({ kind: 'diagnostic', ...diagnostic });
    }

    private sendEnvelope(envelope: ControlClientEnvelope): void {
        if (!this.socket || !this.isSocketOpen()) {
            return;
        }

        this.socket.send(JSON.stringify(envelope));
        this.setSnapshot({ sentCount: this.snapshot.sentCount + 1 });
    }

    private isSocketOpen(): boolean {
        return this.socket?.readyState === OPEN_STATE;
    }

    private closeSocket(code?: number, reason?: string): void {
        this.removeSocketListeners?.();
        this.removeSocketListeners = undefined;
        const socket = this.socket;
        this.socket = undefined;
        try {
            socket?.close(code, reason);
        }
        catch {
            // Closing is best-effort during reconnect and disconnect cleanup.
        }
    }

    private stopHeartbeat(): void {
        globalThis.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
    }

    private stopStats(): void {
        globalThis.clearInterval(this.statsTimer);
        this.statsTimer = undefined;
    }

    private stopReconnectTimer(): void {
        globalThis.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }

    /** Socket callbacks and timers exist only after connect has named the run and agent. */
    private assertConnection(): RallarBlackBoxControlConnectOptions {
        if (!this.connection) {
            throw new Error('Control client is not configured.');
        }

        return this.connection;
    }

    private setSnapshot(patch: Partial<RallarBlackBoxControlSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        this.snapshotListeners.forEach((listener) => listener(this.snapshot));
    }
}

/** A deadline on the envelope overrides the command's own deadline. */
function toEnvelopeCommand(envelope: ControlCommandEnvelope): RallarBlackBoxTestCommand {
    return {
        ...envelope.command,
        commandId: envelope.commandId,
        deadlineEpochMs: envelope.deadlineEpochMs ?? envelope.command.deadlineEpochMs
    } as RallarBlackBoxTestCommand;
}
