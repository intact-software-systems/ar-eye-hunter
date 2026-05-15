import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
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
    lastMessageAtEpochMs?: number;
    reconnectAttempt: number;
    sentCount: number;
    receivedCount: number;
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

export type RallarBlackBoxControlClientOptions = Readonly<{
    runtime: RallarBlackBoxTestRuntime;
    webSocketFactory?: RallarBlackBoxControlWebSocketFactory;
    heartbeatIntervalMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    onSnapshot?: (snapshot: RallarBlackBoxControlSnapshot) => void;
}>;

export type RallarBlackBoxControlConnectOptions = Readonly<{
    url: string;
    runId: string;
    agentId: string;
}>;

const OPEN_STATE = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
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

export class RallarBlackBoxControlClient {
    private readonly runtime: RallarBlackBoxTestRuntime;
    private readonly webSocketFactory: RallarBlackBoxControlWebSocketFactory;
    private readonly heartbeatIntervalMs: number;
    private readonly reconnectBaseMs: number;
    private readonly reconnectMaxMs: number;
    private readonly onSnapshot: ((snapshot: RallarBlackBoxControlSnapshot) => void) | undefined;
    private readonly unsubscribeRuntime: () => void;
    private readonly sentEventIds = new Set<string>();
    private socket: WebSocketLike | undefined;
    private disposers: Array<() => void> = [];
    private heartbeatTimer: number | undefined;
    private reconnectTimer: number | undefined;
    private manualClose = false;
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
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ??
            DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
        this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
        this.onSnapshot = options.onSnapshot;
        this.unsubscribeRuntime = this.runtime.subscribe(state => {
            this.streamNewEvents(state);
        });
    }

    currentSnapshot(): RallarBlackBoxControlSnapshot {
        return this.snapshot;
    }

    connect(options: RallarBlackBoxControlConnectOptions): void {
        this.options = options;
        this.manualClose = false;
        this.clearReconnect();
        this.openSocket('connecting');
    }

    disconnect(): void {
        this.manualClose = true;
        this.clearHeartbeat();
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
        this.startHeartbeat();
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

        const result = await this.runtime.execute(command);
        this.sendResult(result);
    }

    private sendRegister(): void {
        const options = this.requireOptions();
        this.sendEnvelope({
            kind: 'register',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            atEpochMs: Date.now(),
            resume: {
                completedCommandIds: Object.keys(this.runtime.state().resultCache),
            },
        });
    }

    private sendHeartbeat(): void {
        const options = this.requireOptions();
        const state = this.runtime.state();
        this.sendEnvelope({
            kind: 'heartbeat',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: options.runId,
            agentId: options.agentId,
            atEpochMs: Date.now(),
            status: state.status,
            lastCommandId: state.commandHistory.at(-1)?.commandId,
            lastEventAtEpochMs: state.events.at(-1)?.atEpochMs,
        });
        this.setSnapshot({
            lastHeartbeatAtEpochMs: Date.now(),
        });
    }

    private startHeartbeat(): void {
        this.clearHeartbeat();
        this.heartbeatTimer = window.setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
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
