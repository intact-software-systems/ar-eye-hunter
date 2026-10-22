import { FailureBackoff } from '@shared/resilience/failure-backoff.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { decodeResultReleaseEnvelope, type ResultReleaseRequest } from './result-release/result-release-protocol.ts';
import { computeAppendedResultHistory, createRuntimeResultHistory } from './runtime/runtime-result-history.ts';

import { toAgentReloadResult, writeAgentResumeRecord } from './alm/browser-control-agent-resume.ts';
import { decodeControlBarrierEnvelope, toBarrierResolvedEvent } from './barrier/control-barrier-protocol.ts';
import {
    ControlRecipeEventHistory,
    toUnavailableRecipeHistoryResult
} from './control-client/control-recipe-event-history.ts';
import { deleteBrowserStorageEntries } from './control-client/delete-browser-storage-entries.ts';
import { createDefaultBrowserCensusReader } from './control-client/read-browser-census.ts';
import {
    decodeControlAgentFleetLocation,
    toControlAgentIdentity
} from './control-client/to-control-agent-identity.ts';
import { toControlAgentReport, toControlOwnedReportState } from './control-client/to-control-agent-report.ts';
import {
    writeControlFinalReport,
    type RallarBlackBoxControlFetch
} from './control-client/write-control-final-report.ts';
import {
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    toControlEventEnvelope,
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from './control-protocol.ts';
import type { RallarBlackBoxControlAgentIdentity } from './distributed-run.ts';
import { decodeRtcCaptureSupport } from './distributed/rtc-capture-support.ts';
import type {
    RallarBlackBoxRtcCaptureSupport,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState
} from './rallar-black-box-test-contracts.ts';
import {
    computeCountedEventHistory,
    createEventHistory,
    type RallarBlackBoxEventHistory
} from './runtime/event-history.ts';
import type { RallarBlackBoxBrowserCensus } from './runtime/runtime-stats-contracts.ts';
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
    readonly now: () => number;
    readonly webSocketFactory: RallarBlackBoxControlWebSocketFactory;
    readonly fetch: RallarBlackBoxControlFetch;
    readonly heartbeatIntervalMs: number;
    /** Zero turns periodic stats off. */
    readonly statsIntervalMs: number;
    /** Zero turns the browser census off; otherwise each reading is sent in a stats of its own at this interval. */
    readonly browserCensusIntervalMs: number;
    /** Never rejects. */
    readonly readBrowserCensus: () => Promise<RallarBlackBoxBrowserCensus>;
    readonly reconnectBaseMs: number;
    readonly reconnectMaxMs: number;
    /** A larger serialized frame is not sent: a bounded diagnostic and a capture gap stand in for it, and a bounded failed result for a result. */
    readonly maxFrameBytes: number;
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
    /** Present only when this page resumes active owned reload executions. */
    readonly recipeExecutions?: ControlRecipeEventHistory.Resume;
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

type ControlFrameSendOutcome =
    | Readonly<{ status: 'sent' | 'socket-closed'; }>
    | Readonly<{ status: 'oversize'; frameBytes: number; }>;

const OPEN_STATE = 1;
const DEFAULT_RECONNECT_BASE_MS = 600;
const DEFAULT_RECONNECT_MAX_MS = 5_000;
const TERMINAL_RUNTIME_STATUSES: readonly RallarBlackBoxTestRuntimeStatus[] = ['completed', 'failed', 'cancelled'];

export function createDefaultRallarBlackBoxControlClient(
    input: Pick<
        RallarBlackBoxControlClientOptions,
        'runtime' | 'heartbeatIntervalMs' | 'statsIntervalMs' | 'browserCensusIntervalMs'
    >
): RallarBlackBoxControlClient {
    return new RallarBlackBoxControlClient({
        ...input,
        now: Date.now,
        webSocketFactory: (url) => new WebSocket(url),
        fetch: (request, init) => globalThis.fetch(request, init),
        readBrowserCensus: createDefaultBrowserCensusReader(),
        reconnectBaseMs: DEFAULT_RECONNECT_BASE_MS,
        reconnectMaxMs: DEFAULT_RECONNECT_MAX_MS,
        maxFrameBytes: RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES
    });
}

export class RallarBlackBoxControlClient implements RallarBlackBoxAgentControlClient {
    private readonly options: RallarBlackBoxControlClientOptions;
    private readonly rtcCaptureSupport: RallarBlackBoxRtcCaptureSupport | undefined;
    private readonly unsubscribeRuntime: () => void;
    private readonly snapshotListeners = new Set<RallarBlackBoxControlSnapshotListener>();
    private publishedEvents = new WeakSet<RallarBlackBoxTestEvent>();
    private eventGeneration = 0;
    private visitedEventOrdinal = 0;
    private observedEventOrdinal = 0;
    private publishedHistory: RallarBlackBoxEventHistory | undefined;
    private readonly completedControlCommandIds = new Set<string>();
    private readonly admittedControlCommandIds = new Set<string>();
    private readonly runningControlCommands = new SingleFlight<string, void>();
    private completedControlResults = new WeakSet<RallarBlackBoxTestResult>();
    private frameLimitedResults = new WeakMap<RallarBlackBoxTestResult, RallarBlackBoxTestResult>();
    private assignmentGeneration = 0;
    private readonly recipeEventHistory = new ControlRecipeEventHistory();
    private observedRuntimeGeneration = 0;
    private completedResultHistory = createRuntimeResultHistory();
    private statsEventSequence = 1;
    private reportSequence = 1;
    private lastTerminalReportKey: string | undefined;
    private lastIdentityIssue: string | undefined;
    private connection: RallarBlackBoxControlConnectOptions | undefined;
    private socket: RallarBlackBoxControlWebSocket | undefined;
    private removeSocketListeners: (() => void) | undefined;
    private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    private statsTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    private censusTimer: ReturnType<typeof globalThis.setInterval> | undefined;
    private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    private readonly reconnectBackoff: FailureBackoff;
    private manualClose = false;
    private disposed = false;
    private disconnectReported = false;
    private snapshot: RallarBlackBoxControlSnapshot = {
        state: 'idle',
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0
    };

    constructor(options: RallarBlackBoxControlClientOptions) {
        this.options = Object.freeze({ ...options });
        this.reconnectBackoff = new FailureBackoff({ baseMs: options.reconnectBaseMs, maxMs: options.reconnectMaxMs });
        this.rtcCaptureSupport = decodeRtcCaptureSupport(this.options.runtime.rtcCaptureSupport).right?.support;
        this.observedRuntimeGeneration = this.options.runtime.state().eventHistory.generation;
        this.unsubscribeRuntime = this.options.runtime.subscribe((state) => {
            if (state.eventHistory.generation !== this.observedRuntimeGeneration) {
                this.recipeEventHistory.clear();
                this.observedRuntimeGeneration = state.eventHistory.generation;
                this.completedResultHistory = createRuntimeResultHistory();
            }
            this.sendNewEvents(state);
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
        if (this.disposed) {
            throw new Error('Control client is disposed.');
        }
        if (connection.runId !== this.connection?.runId || connection.agentId !== this.connection?.agentId) {
            this.assignmentGeneration += 1;
            this.recipeEventHistory.restore(connection.recipeExecutions ?? {});
            this.completedControlCommandIds.clear();
            this.completedResultHistory = createRuntimeResultHistory();
            this.completedControlResults = new WeakSet<RallarBlackBoxTestResult>();
            this.frameLimitedResults = new WeakMap<RallarBlackBoxTestResult, RallarBlackBoxTestResult>();
            this.admittedControlCommandIds.clear();
            this.runningControlCommands.clear();
            this.publishedEvents = new WeakSet<RallarBlackBoxTestEvent>();
            this.lastTerminalReportKey = undefined;
            const history = this.options.runtime.state().eventHistory;
            this.eventGeneration = history.generation;
            this.visitedEventOrdinal = history.totalEvents;
            this.observedEventOrdinal = history.totalEvents;
            this.publishedHistory = createEventHistory(history.policy, history, history.capture);
        }
        for (const commandId of connection.completedCommandIds) {
            this.completedControlCommandIds.add(commandId);
        }
        this.connection = Object.freeze({
            url: connection.url,
            runId: connection.runId,
            agentId: connection.agentId,
            token: connection.token,
            finalReportUploadUrl: connection.finalReportUploadUrl,
            completedCommandIds: Object.freeze([...connection.completedCommandIds])
        });
        this.options.runtime.beginEventCapture({ runId: connection.runId, agentId: connection.agentId });
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
        this.publishSnapshotUpdate({ state: 'disconnected', lastError: undefined });
    }

    dispose(): void {
        this.disposed = true;
        for (const root of Object.keys(this.recipeEventHistory.snapshot())) {
            if (this.connection !== undefined) {
                this.options.runtime.releaseRecipeExecution(root, this.connection);
            }
        }
        this.recipeEventHistory.clear();
        this.disconnect();
        this.unsubscribeRuntime();
    }

    private openSocket(state: RallarBlackBoxControlConnectionState): void {
        const connection = this.assertConnection();
        this.closeSocket(1000, 'reopening');
        this.publishSnapshotUpdate({
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
            this.publishSnapshotUpdate({ state: 'failed', lastError: toError(caught).message });
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
        this.reconnectBackoff.recordSuccess();
        this.publishSnapshotUpdate({
            state: 'registered',
            connectedAtEpochMs: this.options.now(),
            reconnectAttempt: 0,
            lastError: undefined
        });
        this.sendRegister();
        this.sendCompletedResults();
        this.sendNewEvents(this.options.runtime.state());
        this.sendHeartbeat();
        this.sendStats(undefined);
        this.startHeartbeat();
        this.startStats();
    };

    private readonly onSocketMessage = (event: RallarBlackBoxControlSocketEvent): void => {
        const connection = this.assertConnection();
        this.publishSnapshotUpdate({
            receivedCount: this.snapshot.receivedCount + 1,
            lastMessageAtEpochMs: this.options.now()
        });

        const identity = { runId: connection.runId, agentId: connection.agentId };
        const release = decodeResultReleaseEnvelope(event.data);
        if (release) {
            if (release.runId === identity.runId && release.agentId === identity.agentId) {
                void this.releaseCapturedResults(release);
            }
            return;
        }
        const barrier = decodeControlBarrierEnvelope(event.data, identity);
        if (barrier.right !== undefined) {
            this.options.runtime.recordEvent(toBarrierResolvedEvent(barrier.right));
            return;
        }
        const parsed = parseControlServerMessage(event.data, identity);
        if (!parsed.ok) {
            this.recordDiagnostic({
                topic: 'rallar.bb.control.protocol_error',
                severity: 'error',
                payload: { error: parsed.error, data: event.data }
            });
            return;
        }

        void this.admitCommand(parsed.envelope);
    };

    private async releaseCapturedResults(request: ResultReleaseRequest): Promise<void> {
        const generation = this.assignmentGeneration;
        const before = this.toControlOwnedState().commandHistory.length;
        const released = await this.options.runtime.releaseResults(request);
        if (generation !== this.assignmentGeneration || this.disposed) {
            return;
        }
        if (released.status === 'released') {
            const after = this.toControlOwnedState().commandHistory.length;
            this.completedResultHistory = {
                ...this.completedResultHistory,
                releasedResults: this.completedResultHistory.releasedResults + before - after
            };
        }
        this.sendEnvelope({
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: request.runId,
            agentId: request.agentId,
            atEpochMs: this.options.now(),
            payload: { topic: 'rallar.bb.results.release', ...released }
        });
    }

    private readonly onSocketClose = (): void => {
        this.stopHeartbeat();
        this.stopStats();
        this.closeSocket();
        if (this.manualClose) {
            return;
        }

        this.publishSnapshotUpdate({ state: 'disconnected' });
        this.startReconnectTimer();
    };

    private readonly onSocketError = (event: RallarBlackBoxControlSocketEvent): void => {
        this.publishSnapshotUpdate({ lastError: event.message ?? String(event) });
        this.recordDiagnostic({ topic: 'rallar.bb.control.socket_error', severity: 'error', payload: { event } });
    };

    private startReconnectTimer(): void {
        if (this.manualClose || !this.connection) {
            return;
        }

        const nowMs = this.options.now();
        const delayMs = this.reconnectBackoff.recordFailure(nowMs) - nowMs;
        this.publishSnapshotUpdate({
            state: 'reconnecting',
            reconnectAttempt: this.reconnectBackoff.getConsecutiveFailures()
        });
        this.reconnectTimer = globalThis.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openSocket('reconnecting');
        }, delayMs);
    }

    /** A redispatch of a command still running joins that execution, which sends the one result on the open socket. */
    private admitCommand(envelope: ControlCommandEnvelope): Promise<void> {
        return this.runningControlCommands.run(envelope.commandId, () => this.runCommand(envelope));
    }

    private async runCommand(envelope: ControlCommandEnvelope): Promise<void> {
        const connection = this.assertConnection();
        const generation = this.assignmentGeneration;
        const identity = { runId: connection.runId, agentId: connection.agentId };
        this.admittedControlCommandIds.add(envelope.commandId);

        this.recordDiagnostic({
            topic: 'rallar.bb.control.command_received',
            severity: 'info',
            payload: { commandId: envelope.commandId, command: envelope.command },
            commandId: envelope.commandId
        });
        const command = toEnvelopeCommand(envelope);
        const history = this.recipeEventHistory.admit(envelope);
        if (command.kind === 'agent.reload' && history.error === undefined) {
            this.startAgentReload(envelope, command.readyTimeoutMs);
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

        const atEpochMs = this.options.now();
        const result: RallarBlackBoxTestResult = history.error === undefined
            ? await this.options.runtime.execute(
                command,
                identity,
                { eventHistorySelection: history.selection, recipeExecution: envelope.recipeExecution }
            )
            : toUnavailableRecipeHistoryResult(envelope, history.error, atEpochMs);

        if (generation !== this.assignmentGeneration || this.disposed) {
            if (envelope.recipeExecution !== undefined) {
                this.options.runtime.releaseRecipeExecution(envelope.recipeExecution.rootCommandId, identity);
            }
            return;
        }
        this.recipeEventHistory.settle(envelope, result);
        this.completedControlCommandIds.add(envelope.commandId);
        if (result.replayed !== true) {
            this.completedControlResults.add(result);
        }
        this.sendResult(result, result.replayed === true);
        if (result.replayed !== true) {
            this.completedResultHistory = computeAppendedResultHistory(
                this.completedResultHistory,
                this.frameLimitedResults.get(result) ?? result
            );
        }
        this.sendTerminalReport(this.options.runtime.state());
    }

    /** The result only buffers on the socket, so the reload waits one macrotask to give that write a turn to flush. */
    private startAgentReload(envelope: ControlCommandEnvelope, readyTimeoutMs: number): void {
        const commandId = envelope.commandId;
        const connection = this.assertConnection();
        if (envelope.recipeExecution?.last) {
            this.options.runtime.releaseRecipeExecution(envelope.recipeExecution.rootCommandId, {
                runId: connection.runId,
                agentId: connection.agentId
            });
            this.recipeEventHistory.clear(envelope.recipeExecution.rootCommandId);
        }
        const written = writeAgentResumeRecord({
            runId: connection.runId,
            agentId: connection.agentId,
            completedCommandIds: this.resolveCompletedCommandIds([commandId]),
            recipeExecutions: this.recipeEventHistory.snapshot()
        });
        const result = toAgentReloadResult({ commandId, readyTimeoutMs, written, atEpochMs: this.options.now() });
        this.recipeEventHistory.settle(envelope, result);
        if (!result.ok && envelope.recipeExecution !== undefined) {
            this.options.runtime.releaseRecipeExecution(envelope.recipeExecution.rootCommandId, {
                runId: connection.runId,
                agentId: connection.agentId
            });
        }
        this.sendResult(result, false);
        if (written === 'written') {
            globalThis.setTimeout(() => globalThis.location.reload(), 0);
        }
    }

    private resolveCompletedCommandIds(extraCommandIds: readonly string[]): readonly string[] {
        return [
            ...new Set([
                ...this.assertConnection().completedCommandIds,
                ...this.completedControlCommandIds,
                ...extraCommandIds
            ])
        ];
    }

    private sendRegister(): void {
        const connection = this.assertConnection();
        const atEpochMs = this.options.now();
        const identity = this.readAgentIdentity(connection.agentId, atEpochMs);
        this.publishSnapshotUpdate({ identity: identity.identity });
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
        const atEpochMs = this.options.now();
        const identity = this.readAgentIdentity(connection.agentId, atEpochMs);
        this.sendEnvelope({
            kind: 'heartbeat',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: connection.runId,
            agentId: connection.agentId,
            atEpochMs,
            status: state.status,
            identity: identity.identity,
            lastCommandId: this.completedResultHistory.lastCommandId,
            lastEventAtEpochMs: state.events.at(-1)?.atEpochMs
        });
        this.publishSnapshotUpdate({ lastHeartbeatAtEpochMs: atEpochMs, identity: identity.identity });
        this.recordIdentityIssue(identity.locationIssue);
    }

    private readAgentIdentity(agentId: string, atEpochMs: number): ControlAgentIdentityReading {
        const config = this.options.runtime.state().currentConfig;
        const location = decodeControlAgentFleetLocation(config);
        return {
            identity: toControlAgentIdentity({
                config,
                rtcCaptureSupport: this.rtcCaptureSupport,
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

    private sendStats(browser: RallarBlackBoxBrowserCensus | undefined): void {
        const connection = this.assertConnection();
        const atEpochMs = this.options.now();
        const stats = toRuntimeStats(this.options.runtime.state(), atEpochMs);
        const event: RallarBlackBoxTestEvent = {
            eventId: `control-stats-${this.statsEventSequence++}`,
            kind: 'stats',
            topic: 'rallar.bb.stats',
            atEpochMs,
            severity: 'info',
            payload: browser === undefined ? stats : { ...stats, browser }
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
        this.publishSnapshotUpdate({ lastStatsAtEpochMs: atEpochMs });
    }

    private startStats(): void {
        this.stopStats();
        if (this.options.statsIntervalMs > 0) {
            this.statsTimer = globalThis.setInterval(() => this.sendStats(undefined), this.options.statsIntervalMs);
        }
        if (this.options.browserCensusIntervalMs > 0) {
            this.censusTimer = globalThis.setInterval(
                () => void this.sendBrowserCensusStats(),
                this.options.browserCensusIntervalMs
            );
        }
    }

    /** A census that settles after the census stopped is dropped. */
    private async sendBrowserCensusStats(): Promise<void> {
        const browser = await this.options.readBrowserCensus();
        if (this.censusTimer !== undefined) {
            this.sendStats(browser);
        }
    }

    private sendFinalReport(reason: string): void {
        const connection = this.connection;
        if (!connection) {
            return;
        }

        const atEpochMs = this.options.now();
        const report = toControlAgentReport({
            runId: connection.runId,
            agentId: connection.agentId,
            reportId: `control-report-${this.reportSequence++}`,
            reason,
            state: this.toControlOwnedState(),
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
        this.publishSnapshotUpdate({ lastReportAtEpochMs: atEpochMs });
    }

    private async writeFinalReport(
        envelope: ControlEventEnvelope,
        uploadUrl: string,
        token: string | undefined
    ): Promise<void> {
        const generation = this.assignmentGeneration;
        const upload = await writeControlFinalReport({ fetch: this.options.fetch, uploadUrl, token, envelope });
        if (generation !== this.assignmentGeneration) {
            return;
        }
        upload.fold(
            (failure) => {
                this.publishSnapshotUpdate({ lastError: failure });
                this.recordDiagnostic({
                    topic: 'rallar.bb.control.report_upload_failed',
                    severity: 'warning',
                    payload: { error: failure, uploadUrl }
                });
            },
            () => this.publishSnapshotUpdate({ lastReportUploadAtEpochMs: this.options.now() })
        );
    }

    private sendCompletedResults(): void {
        const cache = this.options.runtime.state().resultCache;
        for (const commandId of this.completedControlCommandIds) {
            const result = cache[commandId];
            if (result && this.completedControlResults.has(result)) {
                this.sendResult(this.frameLimitedResults.get(result) ?? result, true);
            }
        }
    }

    /** An oversize result is answered by a bounded failed result, which is also what a reconnect replays. */
    private sendResult(result: RallarBlackBoxTestResult, replayed: boolean): void {
        const connection = this.assertConnection();
        const outcome = this.sendEnvelope(toControlResultEnvelope(connection, result, replayed));
        if (outcome.status === 'oversize') {
            const limited = toFrameLimitedResult(result, outcome.frameBytes, this.options.maxFrameBytes);
            this.frameLimitedResults.set(result, limited);
            this.sendEnvelope(toControlResultEnvelope(connection, limited, replayed));
        }
    }

    private sendNewEvents(state: RallarBlackBoxTestState): void {
        const connection = this.connection;
        const generation = this.assignmentGeneration;
        if (!connection) {
            return;
        }
        this.observeEventHistory(state.eventHistory);
        if (!this.isSocketOpen()) {
            return;
        }
        for (let index = this.toFirstUnvisitedEventIndex(state); index < state.events.length; index += 1) {
            if (generation !== this.assignmentGeneration || !this.isSocketOpen()) {
                return;
            }
            const event = state.events[index];
            if (!this.isValidEventSequence(event, state)) {
                this.options.runtime.recordEventCaptureGap('invalid-runtime-event-sequence');
                continue;
            }
            if (event.history.ordinal <= this.visitedEventOrdinal) {
                continue;
            }
            this.visitedEventOrdinal = event.history.ordinal;
            if (this.isEventOwnedAtAddress(event, connection)) {
                this.writeRuntimeEvent(event, connection);
            }
        }
    }

    /** Events append in ordinal order, so everything after the newest visited event is unvisited. */
    private toFirstUnvisitedEventIndex(state: RallarBlackBoxTestState): number {
        let index = state.events.length;
        while (index > 0) {
            const event = state.events[index - 1];
            if (this.isValidEventSequence(event, state) && event.history.ordinal <= this.visitedEventOrdinal) {
                return index;
            }
            index -= 1;
        }
        return index;
    }

    private isValidEventSequence(
        event: RallarBlackBoxTestEvent,
        state: RallarBlackBoxTestState
    ): event is RallarBlackBoxTestEvent & Required<Pick<RallarBlackBoxTestEvent, 'history'>> {
        const sequence = event.history;
        return sequence !== undefined && sequence.runtimeId === state.eventHistory.runtimeId &&
            sequence.generation === this.eventGeneration && Number.isSafeInteger(sequence.ordinal) &&
            sequence.ordinal >= 1;
    }

    private observeEventHistory(history: RallarBlackBoxEventHistory): void {
        if (history.generation !== this.eventGeneration) {
            if (this.visitedEventOrdinal < this.observedEventOrdinal) {
                this.options.runtime.recordEventCaptureGap('unsent-events-reset');
            }
            this.eventGeneration = history.generation;
            this.visitedEventOrdinal = 0;
            this.observedEventOrdinal = 0;
            this.publishedHistory = createEventHistory(history.policy, history, history.capture);
        }
        this.observedEventOrdinal = history.totalEvents;
        if (this.visitedEventOrdinal < history.evictedEvents) {
            this.visitedEventOrdinal = history.evictedEvents;
            this.options.runtime.recordEventCaptureGap('unsent-events-evicted');
        }
    }

    private isEventOwnedAtAddress(
        event: RallarBlackBoxTestEvent,
        connection: RallarBlackBoxControlConnectOptions
    ): boolean {
        if (
            this.assignmentGeneration > 1 && this.admittedControlCommandIds.size === 0 &&
            !event.topic.startsWith('rallar.bb.control.')
        ) {
            return false;
        }
        return event.kind !== 'result' ||
            (event.control?.runId === connection.runId && event.control.agentId === connection.agentId &&
                this.admittedControlCommandIds.has(event.control.rootCommandId));
    }

    private writeRuntimeEvent(event: RallarBlackBoxTestEvent, connection: RallarBlackBoxControlConnectOptions): void {
        const generation = this.assignmentGeneration;
        try {
            const outcome = this.sendEnvelope(toControlEventEnvelope(event, connection.runId, connection.agentId));
            if (generation !== this.assignmentGeneration || outcome.status === 'oversize') {
                return;
            }
            this.publishedEvents.add(event);
            const history = this.publishedHistory;
            if (history) {
                this.publishedHistory = computeCountedEventHistory(history, event);
            }
        }
        catch (caught) {
            if (generation !== this.assignmentGeneration) {
                return;
            }
            this.options.runtime.recordEventCaptureGap('event-publication-failed');
            if (generation === this.assignmentGeneration) {
                this.publishSnapshotUpdate({ lastError: toError(caught).message });
            }
        }
    }

    /** The client owns publication sets; the report core projects their actual admitted facts. */
    private toControlOwnedState(state = this.options.runtime.state()): RallarBlackBoxTestState {
        return toControlOwnedReportState({
            state,
            admittedCommandIds: this.admittedControlCommandIds,
            completedResults: this.completedControlResults,
            resultHistory: this.completedResultHistory,
            frameLimitedResults: this.frameLimitedResults,
            publishedEvents: this.publishedEvents,
            publishedHistory: this.publishedHistory
        });
    }

    private sendTerminalReport(state: RallarBlackBoxTestState): void {
        const owned = this.toControlOwnedState(state);
        if (!TERMINAL_RUNTIME_STATUSES.includes(owned.status)) {
            return;
        }
        const latestCommandId = owned.commandHistory.at(-1)?.commandId;
        if (latestCommandId === undefined) {
            return;
        }
        const reportKey = `${owned.status}:${latestCommandId}:${owned.commandHistory.length}`;
        if (this.lastTerminalReportKey !== reportKey) {
            this.lastTerminalReportKey = reportKey;
            this.sendFinalReport(`runtime-${owned.status}`);
        }
    }

    private recordDiagnostic(diagnostic: ControlClientDiagnostic): void {
        this.options.runtime.recordEvent({ kind: 'diagnostic', ...diagnostic });
    }

    private sendEnvelope(envelope: ControlClientEnvelope): ControlFrameSendOutcome {
        if (!this.socket || !this.isSocketOpen()) {
            return { status: 'socket-closed' };
        }

        const frame = JSON.stringify(envelope);
        const oversizeFrameBytes = toOversizeFrameBytes(frame, this.options.maxFrameBytes);
        if (oversizeFrameBytes !== undefined) {
            this.recordOversizeFrame(envelope, oversizeFrameBytes);
            return { status: 'oversize', frameBytes: oversizeFrameBytes };
        }
        this.socket.send(frame);
        this.publishSnapshotUpdate({ sentCount: this.snapshot.sentCount + 1 });
        return { status: 'sent' };
    }

    /** The server would close the socket on this frame, so a bounded record of it is published instead. */
    private recordOversizeFrame(envelope: ControlClientEnvelope, frameBytes: number): void {
        const commandId = envelope.kind === 'result' ? envelope.commandId : undefined;
        this.options.runtime.recordEventCaptureGap('control-frame-too-large');
        this.recordDiagnostic({
            topic: 'rallar.bb.control.frame_too_large',
            severity: 'error',
            payload: {
                frameKind: envelope.kind,
                commandId,
                eventId: 'eventId' in envelope ? envelope.eventId : undefined,
                agentId: envelope.agentId,
                frameBytes,
                maxFrameBytes: this.options.maxFrameBytes
            },
            commandId
        });
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
        globalThis.clearInterval(this.censusTimer);
        this.censusTimer = undefined;
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

    private publishSnapshotUpdate(patch: Partial<RallarBlackBoxControlSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        this.snapshotListeners.forEach((listener) => listener(this.snapshot));
    }
}

function toControlResultEnvelope(
    connection: RallarBlackBoxControlConnectOptions,
    result: RallarBlackBoxTestResult,
    replayed: boolean
): ControlResultEnvelope {
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: connection.runId,
        agentId: connection.agentId,
        commandId: result.commandId,
        ok: result.ok,
        result: { ...result, replayed },
        error: result.ok
            ? undefined
            : {
                code: result.error?.code ?? 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                message: result.error?.message ?? 'Command failed.',
                details: result.error?.details
            },
        replayed
    };
}

/** The bounded result keeps the verdict of the result it replaces, without that result's value or error details. */
function toFrameLimitedResult(
    result: RallarBlackBoxTestResult,
    frameBytes: number,
    maxFrameBytes: number
): RallarBlackBoxTestResult {
    return {
        commandId: result.commandId,
        kind: result.kind,
        status: 'failed',
        ok: false,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs,
        error: {
            code: 'RALLAR_BLACK_BOX_CONTROL_FRAME_TOO_LARGE',
            message:
                `The result frame of ${frameBytes} bytes exceeds the control frame limit of ${maxFrameBytes} bytes.`,
            details: {
                frameBytes,
                maxFrameBytes,
                oversizeResult: {
                    status: result.status,
                    ok: result.ok,
                    ...(result.error === undefined
                        ? {}
                        : { error: { code: result.error.code, message: result.error.message } })
                }
            }
        }
    };
}

/** UTF-8 spends at most three bytes per UTF-16 unit, so only a frame near the limit is encoded to measure it. */
function toOversizeFrameBytes(frame: string, maxFrameBytes: number): number | undefined {
    if (frame.length * 3 <= maxFrameBytes) {
        return undefined;
    }
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    return frameBytes > maxFrameBytes ? frameBytes : undefined;
}

/** A deadline on the envelope overrides the command's own deadline. */
function toEnvelopeCommand(envelope: ControlCommandEnvelope): RallarBlackBoxTestCommand {
    return {
        ...envelope.command,
        commandId: envelope.commandId,
        deadlineEpochMs: envelope.deadlineEpochMs ?? envelope.command.deadlineEpochMs
    };
}
