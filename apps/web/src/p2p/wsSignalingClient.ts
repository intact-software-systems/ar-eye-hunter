import {
    P2pRole,
    WsChannel,
    P2pWsClientMsgType,
    P2pWsServerMsgType,
    P2pSignalType,
    type P2pSessionId,
    type P2pToken,
    type P2pWsServerMessage,
    type P2pWsClientMessage,
} from "@shared/mod";

export enum WsSigStatus {
    Closed = "Closed",
    Connecting = "Connecting",
    Open = "Open",
}

export type WsSigHandlers = {
    onOpen: () => void;
    onWelcome: (role: P2pRole) => void;
    onSignal: (m: { fromRole: P2pRole; signalType: P2pSignalType; payload: unknown }) => void;
    onError: (message: string) => void;
    onClose: () => void;
};

export type P2pSignalHandler = (signalType: P2pSignalType, payload: unknown) => void;

export type SignalTransport = {
    send: (signalType: P2pSignalType, payload: unknown) => void;
    onSignal: (handler: P2pSignalHandler) => void;
};

function wsUrl(): string {
    const env = (import.meta as any).env;
    const base = (env?.VITE_API_BASE_URL as string) || "";
    if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}/api/ws`;
    if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}/api/ws`;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/api/ws`;
}

export class WsSignalingClient {
    private status: WsSigStatus = WsSigStatus.Closed;
    private ws: WebSocket | undefined = undefined;

    private sessionId: P2pSessionId | undefined = undefined;
    private token: P2pToken | undefined = undefined;

    private transportHandler: P2pSignalHandler = () => {};

    private pending: Array<{ signalType: P2pSignalType; payload: unknown }> = [];

    constructor(private readonly handlers: WsSigHandlers) {}

    getStatus(): WsSigStatus {
        return this.status;
    }

    onSignal(handler: P2pSignalHandler): void {
        this.transportHandler = handler;
    }

    asTransport(): SignalTransport {
        return {
            send: (signalType, payload) => this.send(signalType, payload),
            onSignal: (handler) => this.onSignal(handler),
        };
    }

    connect(sessionId: P2pSessionId, token: P2pToken): void {
        this.close();

        this.sessionId = sessionId;
        this.token = token;

        this.status = WsSigStatus.Connecting;
        const ws = new WebSocket(wsUrl());
        this.ws = ws;

        ws.addEventListener("open", () => {
            this.status = WsSigStatus.Open;
            this.handlers.onOpen();

            const hello: P2pWsClientMessage = {
                channel: WsChannel.P2pSignal,
                type: P2pWsClientMsgType.Hello,
                sessionId,
                token,
            };
            ws.send(JSON.stringify(hello));

            // Flush any signals queued before the socket opened
            const queued = [...this.pending];
            this.pending = [];
            for (const q of queued) {
                this.send(q.signalType, q.payload);
            }
        });

        ws.addEventListener("message", (ev) => {
            const raw = typeof ev.data === "string" ? ev.data : "";
            let msg: P2pWsServerMessage;
            try {
                msg = JSON.parse(raw) as P2pWsServerMessage;
            } catch {
                return;
            }

            if (msg.channel !== WsChannel.P2pSignal) return;

            if (msg.type === P2pWsServerMsgType.Welcome) {
                this.handlers.onWelcome(msg.role);
                return;
            }

            if (msg.type === P2pWsServerMsgType.Signal) {
                this.handlers.onSignal({ fromRole: msg.fromRole, signalType: msg.signalType, payload: msg.payload });
                this.transportHandler(msg.signalType, msg.payload);
                return;
            }

            if (msg.type === P2pWsServerMsgType.Error) {
                this.handlers.onError(msg.message);
                return;
            }
        });

        ws.addEventListener("close", () => {
            this.status = WsSigStatus.Closed;
            this.handlers.onClose();
        });

        ws.addEventListener("error", () => {
            this.handlers.onError("WebSocket error");
        });
    }

    send(signalType: P2pSignalType, payload: unknown): void {
        // If we are not connected yet, queue the signal.
        if (!this.ws || this.status !== WsSigStatus.Open) {
            this.pending.push({ signalType, payload });
            return;
        }

        const sessionId = this.sessionId;
        const token = this.token;
        if (!sessionId || !token) {
            // Not connected / not authenticated
            return;
        }

        const msg: P2pWsClientMessage = {
            channel: WsChannel.P2pSignal,
            type: P2pWsClientMsgType.Signal,
            sessionId,
            token,
            signalType,
            payload,
        };
        this.ws.send(JSON.stringify(msg));
    }

    close(): void {
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
        }
        this.ws = undefined;
        this.sessionId = undefined;
        this.token = undefined;
        this.pending = [];
        this.status = WsSigStatus.Closed;
    }
}