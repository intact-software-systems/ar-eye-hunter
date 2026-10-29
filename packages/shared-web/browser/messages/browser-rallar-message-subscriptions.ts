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
import { toRallarMessage, type RallarMessageReplySender } from '@shared-web/browser/messages/to-rallar-message.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { AsyncNotifications, notifyConcurrentListeners } from '@shared/cache/async-notifications.ts';

interface BrowserRallarMessageSubscriptionsInput {
    readonly wsInbox: BrowserWebSocketInbox;
    readonly sendReply: RallarMessageReplySender;
    readMiddleware(): ApiMiddleware | undefined;
    readInboundDiagnostics(): ALInboundRuntimeDiagnosticsSink;
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

    public constructor(input: BrowserRallarMessageSubscriptionsInput) {
        this.input = input;
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
        const listeners = this.matchingListeners(transport, message);
        if (listeners.size === 0) {
            return;
        }
        const rallarMessage = toRallarMessage<never>(transport, message, this.input.sendReply);
        await notifyConcurrentListeners(listeners, rallarMessage, (error) => {
            console.error('Error notifying Rallar message listener', error);
        });
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
