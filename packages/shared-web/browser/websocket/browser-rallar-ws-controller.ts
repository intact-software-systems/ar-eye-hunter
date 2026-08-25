import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/rallar-wait-timeout.ts';
import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { RallarConnectStatus } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarWsFacade,
    RallarWsLifecycleKind,
    RallarWsLifecycleListener,
    RallarWsStatus,
    RallarWsStatusListener,
    RallarWsWaitForOpenResult
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarWaitForOpenOptions, RallarWaitForOpenStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarOnChangeOptions, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { WebSocketClientCallbacks } from '@shared/websocket/JsonWebSocketClient.ts';

const RALLAR_WS_STATUS_CALLBACK_ID = 'rallar:ws:status';

interface RallarWsStatusSubscription {
    readonly listener: RallarWsStatusListener;
    readonly options: RallarOnChangeOptions;
}

interface RallarWsLifecycleSubscription {
    readonly listener: RallarWsLifecycleListener;
    readonly options: RallarOnChangeOptions;
}

interface RallarWsLifecycleEventDetails {
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
    readonly eventType?: string;
    readonly intentional?: boolean;
}

export interface BrowserRallarWsControllerInput {
    readMiddleware(): ApiMiddleware | undefined;
    readSession(): AuthSession | undefined;
    readConnectState(): RallarConnectStatus;
}

export interface RallarWsController {
    readonly facade: RallarWsFacade;
    attach(ctx?: ApiMiddleware): void;
    connected(): void;
    detach(ctx?: ApiMiddleware): void;
    disconnected(): void;
}

export class BrowserRallarWsController implements RallarWsController {
    private readonly wsStatusListeners = new Set<RallarWsStatusSubscription>();
    private readonly wsLifecycleListeners = new Set<RallarWsLifecycleSubscription>();

    private readonly options: BrowserRallarWsControllerInput;

    constructor(options: BrowserRallarWsControllerInput) {
        this.options = options;
    }

    readonly facade: RallarWsFacade = {
        status: (): RallarWsStatus => this.toWsStatus(),
        onStatus: (
            listener: RallarWsStatusListener,
            options: RallarOnChangeOptions = {}
        ): RallarUnsubscribe => {
            const subscription: RallarWsStatusSubscription = { listener, options };
            this.wsStatusListeners.add(subscription);
            this.registerWsStatusCallbacks();
            if (options.emitCurrent ?? true) {
                notifyListener(listener, this.toWsStatus());
            }
            return () => {
                this.wsStatusListeners.delete(subscription);
                this.unregisterWsStatusCallbacksIfUnused();
            };
        },
        onLifecycle: (
            listener: RallarWsLifecycleListener,
            options: RallarOnChangeOptions = {}
        ): RallarUnsubscribe => {
            const subscription: RallarWsLifecycleSubscription = {
                listener,
                options
            };
            this.wsLifecycleListeners.add(subscription);
            this.registerWsStatusCallbacks();
            if (options.emitCurrent ?? true) {
                this.notifyWsLifecycleSubscription(subscription, 'snapshot');
            }
            return () => {
                this.wsLifecycleListeners.delete(subscription);
                this.unregisterWsStatusCallbacksIfUnused();
            };
        },
        waitForOpen: async (
            options: RallarWaitForOpenOptions = {}
        ): Promise<RallarWsWaitForOpenResult> => await this.waitForWsOpen(options)
    };

    attach(ctx = this.options.readMiddleware()): void {
        this.registerWsStatusCallbacks(ctx);
    }

    connected(): void {
        this.emitWsLifecycle('connected');
    }

    detach(ctx = this.options.readMiddleware()): void {
        this.unregisterWsStatusCallbacks(ctx);
    }

    disconnected(): void {
        this.emitWsLifecycle('disconnected', {
            code: 1000,
            reason: 'rallar-disconnect',
            intentional: true
        });
    }

    private toWsStatus(): RallarWsStatus {
        const ctx = this.options.readMiddleware();
        if (!ctx) {
            return {
                sessionId: this.options.readSession()?.sessionId,
                connectState: this.options.readConnectState(),
                readyState: 'missing',
                isOpen: false,
                reconnecting: false,
                reconnectEnabled: false,
                reconnectAttempts: 0,
                maxReconnectAttempts: 0,
                reconnectExhausted: false
            };
        }

        const health = ctx.middleware.webSocketQueueBox.readHealth();
        return {
            sessionId: health.sessionId,
            url: toPublicWsStatusUrl(health.url),
            connectState: this.options.readConnectState(),
            readyState: health.readyState,
            readyStateCode: health.readyStateCode,
            isOpen: health.isOpen,
            reconnecting: health.reconnecting,
            reconnectEnabled: health.reconnectEnabled,
            reconnectAttempts: health.reconnectAttempts,
            maxReconnectAttempts: health.maxReconnectAttempts,
            reconnectExhausted: health.reconnectExhausted
        };
    }

    private waitForWsOpen(
        options: RallarWaitForOpenOptions = {}
    ): Promise<RallarWsWaitForOpenResult> {
        const current = this.toWsStatus();
        const immediate = this.readImmediateWaitResult(current, options);
        if (immediate) {
            return Promise.resolve(immediate);
        }
        return this.waitForWsLifecycle(current, options);
    }

    private readImmediateWaitResult(
        current: RallarWsStatus,
        options: RallarWaitForOpenOptions
    ): RallarWsWaitForOpenResult | undefined {
        if (current.isOpen) {
            return toWsWaitForOpenResult('open', current);
        }
        if (options.signal?.aborted) {
            return toWsWaitForOpenResult('aborted', current);
        }
        if (!this.options.readMiddleware()) {
            return toWsWaitForOpenResult('not-connected', current);
        }
        if (isTerminalClosedWsStatus(current)) {
            return toWsWaitForOpenResult('closed', current);
        }
        const timeoutMs = normalizeWaitTimeoutMs(options.timeoutMs);
        if (timeoutMs <= 0) {
            return toWsWaitForOpenResult('timeout', current);
        }
        return undefined;
    }

    private waitForWsLifecycle(
        current: RallarWsStatus,
        options: RallarWaitForOpenOptions
    ): Promise<RallarWsWaitForOpenResult> {
        const timeoutMs = normalizeWaitTimeoutMs(options.timeoutMs);
        return new Promise<RallarWsWaitForOpenResult>((resolve) => {
            let settled = false;
            let latest = current;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe: RallarUnsubscribe = () => {
            };

            const finish = (
                status: RallarWaitForOpenStatus,
                wsStatus: RallarWsStatus = latest
            ): void => {
                if (settled) {
                    return;
                }

                settled = true;
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
                options.signal?.removeEventListener('abort', onAbort);
                unsubscribe();
                resolve(toWsWaitForOpenResult(status, wsStatus));
            };

            const onAbort = (): void => finish('aborted');

            unsubscribe = this.facade.onStatus(
                (status) => {
                    latest = status;
                    if (status.isOpen) {
                        finish('open', status);
                        return;
                    }

                    if (isTerminalClosedWsStatus(status)) {
                        finish('closed', status);
                    }
                },
                {
                    emitCurrent: false
                }
            );
            options.signal?.addEventListener('abort', onAbort, { once: true });
            timeout = setTimeout(() => finish('timeout'), timeoutMs);
        });
    }

    private registerWsStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.options.readMiddleware()
    ): void {
        if (!ctx || !this.hasWsStatusSubscriptions()) {
            return;
        }

        ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo(
            RALLAR_WS_STATUS_CALLBACK_ID,
            this.toWsLifecycleCallbacks()
        );
    }

    private toWsLifecycleCallbacks(): WebSocketClientCallbacks {
        return {
            onOpen: (event) => {
                this.emitWsLifecycle('open', {
                    eventType: event.type
                });
            },
            onClose: (event) => {
                this.emitWsLifecycle('close', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean,
                    eventType: event.type,
                    intentional: false
                });
            },
            onError: (event) => {
                this.emitWsLifecycle('error', {
                    eventType: event.type,
                    intentional: false
                });
            }
        };
    }

    private unregisterWsStatusCallbacksIfUnused(): void {
        if (this.hasWsStatusSubscriptions()) {
            return;
        }

        this.unregisterWsStatusCallbacks();
    }

    private unregisterWsStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.options.readMiddleware()
    ): void {
        ctx?.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById(
            RALLAR_WS_STATUS_CALLBACK_ID
        );
    }

    private hasWsStatusSubscriptions(): boolean {
        return this.wsStatusListeners.size > 0 ||
            this.wsLifecycleListeners.size > 0;
    }

    private emitWsLifecycle(
        kind: RallarWsLifecycleKind,
        input: RallarWsLifecycleEventDetails = {}
    ): void {
        this.emitWsStatus();
        for (const subscription of this.wsLifecycleListeners) {
            this.notifyWsLifecycleSubscription(subscription, kind, input);
        }
    }

    private emitWsStatus(): void {
        for (const subscription of this.wsStatusListeners) {
            notifyListener(subscription.listener, this.toWsStatus());
        }
    }

    private notifyWsLifecycleSubscription(
        subscription: RallarWsLifecycleSubscription,
        kind: RallarWsLifecycleKind,
        input: RallarWsLifecycleEventDetails = {}
    ): void {
        notifyListener(subscription.listener, {
            kind,
            atEpochMs: Date.now(),
            status: this.toWsStatus(),
            code: input.code,
            reason: input.reason,
            wasClean: input.wasClean,
            eventType: input.eventType,
            intentional: input.intentional
        });
    }
}

function isTerminalClosedWsStatus(status: RallarWsStatus): boolean {
    return (status.readyState === 'closing' || status.readyState === 'closed') &&
        !status.reconnecting &&
        !status.reconnectEnabled;
}

function toPublicWsStatusUrl(url: string | undefined): string | undefined {
    if (!url) {
        return url;
    }

    try {
        const parsed = new URL(url);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    }
    catch {
        return url.split(/[?#]/, 1)[0];
    }
}

function toWsWaitForOpenResult(
    status: RallarWaitForOpenStatus,
    wsStatus: RallarWsStatus
): RallarWsWaitForOpenResult {
    return {
        transport: 'ws',
        status,
        wsStatus
    };
}
