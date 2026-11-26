import { EdgeOrderArrivals } from '@shared-web/browser/messages/edge-order/edge-order-arrivals.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import type {
    RallarMessage,
    RallarMessageHandler,
    RallarMessageTransport
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    matchesRallarMessageSelector,
    normalizeRallarMessageSelector,
    toRallarMessageSelectorKey,
    type RallarMessageSelector,
    type RallarMessageSelectorInput
} from '@shared-web/browser/messages/rallar-message-selectors.ts';
import { toBrowserReplyDropDiagnostic } from '@shared-web/browser/messages/reply/to-browser-reply-drop-diagnostic.ts';
import {
    toEdgeOrderedRallarMessage,
    toRallarMessage,
    type RallarMessageReplySender
} from '@shared-web/browser/messages/to-rallar-message.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { AsyncNotifications, notifyConcurrentListeners } from '@shared/cache/async-notifications.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { readBrowserServerExpiryEpochMs } from '../connection/server-clock/browser-server-clock-session.ts';

interface BrowserRallarMessageSubscriptionsInput {
    readonly wsInbox: BrowserWebSocketInbox;
    readonly sendReply: RallarMessageReplySender;
    readMiddleware(): ApiMiddleware | undefined;
    readInboundDiagnostics(): ALInboundRuntimeDiagnosticsSink;
    /** The bounds of what the page holds for edge order, and the timers that release it. */
    readonly edgeOrderLimits: EdgeOrderReceiverLimits;
    readonly timers: Pick<Timers, 'schedule'>;
}

type RallarInboundMessageTransport = Extract<RallarMessageTransport, 'rtc' | 'ws'>;

interface RallarMessageSubscription {
    readonly selector: RallarMessageSelector;
    readonly listeners: AsyncNotifications<RallarMessage>;
}

export class BrowserRallarMessageSubscriptions {
    private readonly rtcSubscriptions = new Map<string, RallarMessageSubscription>();
    private readonly wsSubscriptions = new Map<string, RallarMessageSubscription>();
    private readonly registeredRtcMessageTypes = new Set<string>();
    private stopWsInbox: RallarUnsubscribe | undefined;
    private readonly input: BrowserRallarMessageSubscriptionsInput;
    private readonly edgeOrderArrivals: EdgeOrderArrivals;

    public constructor(input: BrowserRallarMessageSubscriptionsInput) {
        this.input = input;
        this.edgeOrderArrivals = new EdgeOrderArrivals({
            limits: input.edgeOrderLimits,
            timers: { nowMs: () => this.readConnectExpiryEpochMs(), schedule: input.timers.schedule },
            readInboundDiagnostics: input.readInboundDiagnostics,
            handOver: async (handOver) =>
                await this.notifyListeners(
                    this.matchingListeners(handOver.carrier, handOver.message),
                    toEdgeOrderedRallarMessage<never>(handOver, input.sendReply)
                )
        });
    }

    /**
     * From here every message of the channel's topic and type is sorted before a handler sees it. One sender's
     * stream can arrive over both carriers, so the page listens on both, whichever the application handles.
     */
    public declareEdgeOrder(
        route: EdgeOrderArrivals.Route,
        onOrderGap: EdgeOrderArrivals.GapHandler | undefined
    ): void {
        this.edgeOrderArrivals.declare(route, onOrderGap);
        this.subscribe('rtc', route, ignoreMessage);
        this.subscribe('ws', route, ignoreMessage);
    }

    /** What the page's edge-ordered channels keep on their receive side now, and what they did not hand over. */
    public readEdgeOrderUsage(): EdgeOrderArrivals.Usage {
        return this.edgeOrderArrivals.readUsage();
    }

    /** The connect is going away: what edge order holds was judged by its clock, and is memory only. */
    public dropHeldEdgeOrderMessages(): void {
        this.edgeOrderArrivals.dropHeldMessages();
    }

    public subscribe<T>(
        transport: RallarInboundMessageTransport,
        selectorInput: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe {
        const selector = normalizeRallarMessageSelector(selectorInput);
        if (transport === 'rtc' && !selector.typeId) {
            throw new Error('RTC message subscriptions require a typeId.');
        }

        const subscription = this.readOrCreateSubscription(transport, selector);
        const listener = handler as RallarMessageHandler;
        const registration = subscription.listeners.subscribe(listener);
        if (transport === 'rtc') {
            this.registerRtcCallback(selector);
        }
        else {
            this.subscribeWsInbox();
        }

        return () => this.unsubscribe(transport, subscription, registration.unsubscribe);
    }

    public attachRtc(context = this.input.readMiddleware()): void {
        if (!context) {
            return;
        }
        for (const subscription of this.rtcSubscriptions.values()) {
            this.registerRtcCallback(subscription.selector, context);
        }
    }

    public detachRtc(context = this.input.readMiddleware()): void {
        if (context) {
            for (const typeId of this.registeredRtcMessageTypes) {
                context.middleware.rtcRxStreamer.removeInboxMessageCallback(typeId);
            }
        }
        this.registeredRtcMessageTypes.clear();
    }

    private unsubscribe(
        transport: RallarInboundMessageTransport,
        subscription: RallarMessageSubscription,
        unsubscribe: RallarUnsubscribe
    ): void {
        unsubscribe();
        if (subscription.listeners.size > 0) {
            return;
        }

        const registry = this.subscriptionRegistry(transport);
        const key = toRallarMessageSelectorKey(subscription.selector);
        if (registry.get(key) !== subscription) {
            return;
        }
        registry.delete(key);
        if (transport === 'rtc' && subscription.selector.typeId) {
            if (!this.hasRtcSubscriptionsForTypeId(subscription.selector.typeId)) {
                this.unregisterRtcCallback(subscription.selector.typeId);
            }
            return;
        }
        if (transport === 'ws' && this.wsSubscriptions.size === 0) {
            this.stopWsInbox?.();
            this.stopWsInbox = undefined;
        }
    }

    private readOrCreateSubscription(
        transport: RallarInboundMessageTransport,
        selector: RallarMessageSelector
    ): RallarMessageSubscription {
        const registry = this.subscriptionRegistry(transport);
        const key = toRallarMessageSelectorKey(selector);
        const existing = registry.get(key);
        if (existing) {
            return existing;
        }
        const created: RallarMessageSubscription = {
            selector,
            listeners: new AsyncNotifications<RallarMessage>()
        };
        registry.set(key, created);
        return created;
    }

    private subscriptionRegistry(
        transport: RallarInboundMessageTransport
    ): Map<string, RallarMessageSubscription> {
        return transport === 'rtc' ? this.rtcSubscriptions : this.wsSubscriptions;
    }

    private subscribeWsInbox(): void {
        if (this.stopWsInbox || this.wsSubscriptions.size === 0) {
            return;
        }
        this.stopWsInbox = this.input.wsInbox.subscribe({
            id: 'messages',
            order: 20,
            onMessage: async (message) => {
                await this.dispatch('ws', message);
            }
        });
    }

    private registerRtcCallback(
        selector: RallarMessageSelector,
        context = this.input.readMiddleware()
    ): void {
        const typeId = selector.typeId;
        if (!context || !typeId || this.registeredRtcMessageTypes.has(typeId)) {
            return;
        }
        context.middleware.rtcRxStreamer.onInboxMessageDo(typeId, {
            onMessage: async (message: ALMessage) => {
                await this.dispatch('rtc', message);
            }
        });
        this.registeredRtcMessageTypes.add(typeId);
    }

    private unregisterRtcCallback(typeId: string): void {
        const context = this.input.readMiddleware();
        context?.middleware.rtcRxStreamer.removeInboxMessageCallback(typeId);
        this.registeredRtcMessageTypes.delete(typeId);
    }

    private hasRtcSubscriptionsForTypeId(typeId: string): boolean {
        for (const subscription of this.rtcSubscriptions.values()) {
            if (subscription.selector.typeId === typeId) {
                return true;
            }
        }
        return false;
    }

    /**
     * A reply belongs to the request that awaits it: the WS reply inbox hands it to the delivery registry. Replies
     * travel over WS only, so one that arrives over RTC is never matched and is dropped with a diagnostic.
     */
    private async dispatch(
        transport: RallarInboundMessageTransport,
        message: ALMessage
    ): Promise<void> {
        const replyToMsgId = message.actions?.replyToMsgId;
        if (replyToMsgId !== undefined) {
            if (transport === 'rtc') {
                recordALInboundDiagnostic(
                    this.input.readInboundDiagnostics(),
                    toBrowserReplyDropDiagnostic({
                        message,
                        replyToMsgId,
                        carrier: 'rtc',
                        admission: { kind: 'late', cause: 'unobserved' }
                    })
                );
            }
            return;
        }
        if (this.edgeOrderArrivals.isDeclared(message)) {
            await this.edgeOrderArrivals.accept(transport, message);
            return;
        }
        const listeners = this.matchingListeners(transport, message);
        if (listeners.size > 0) {
            await this.notifyListeners(listeners, toRallarMessage<never>(transport, message, this.input.sendReply));
        }
    }

    private async notifyListeners(listeners: Set<RallarMessageHandler>, message: RallarMessage): Promise<void> {
        await notifyConcurrentListeners(listeners, message, (error) => {
            console.error('Error notifying Rallar message listener', error);
        });
    }

    /** The clock the inbound runtime judges a hand-over deadline by; it throws once the connect is gone. */
    private readConnectExpiryEpochMs(): number {
        const context = this.input.readMiddleware();
        if (context === undefined) {
            throw new Error('Edge order reads the server clock of a connect, and none is attached.');
        }
        return readBrowserServerExpiryEpochMs(context.serverTime);
    }

    private matchingListeners(
        transport: RallarInboundMessageTransport,
        message: ALMessage
    ): Set<RallarMessageHandler> {
        const listeners = new Set<RallarMessageHandler>();
        for (const subscription of this.subscriptionRegistry(transport).values()) {
            if (!matchesRallarMessageSelector(subscription.selector, message)) {
                continue;
            }
            for (const listener of subscription.listeners.getListeners()) {
                listeners.add(listener);
            }
        }
        return listeners;
    }
}

function ignoreMessage(): void {}
