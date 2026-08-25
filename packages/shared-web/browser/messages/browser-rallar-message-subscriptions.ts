import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarMessageHandler, RallarMessageTransport } from '@shared-web/browser/rallar-message-contracts.ts';
import {
    matchesRallarMessageSelector,
    normalizeRallarMessageSelector,
    toRallarMessageSelectorKey,
    type RallarMessageSelector,
    type RallarMessageSelectorInput
} from '@shared-web/browser/rallar-message-selectors.ts';
import { toRallarMessage } from '@shared-web/browser/rallar-runtime/message-conversion.ts';
import type { RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

interface BrowserRallarMessageSubscriptionsInput {
    readonly wsInbox: RallarWsInbox;
    readMiddleware(): ApiMiddleware | undefined;
}

type RallarInboundMessageTransport = Extract<RallarMessageTransport, 'rtc' | 'ws'>;

interface RallarMessageSubscription {
    readonly selector: RallarMessageSelector;
    readonly listeners: Set<RallarMessageHandler>;
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
        subscription.listeners.add(listener);
        if (transport === 'rtc') {
            this.registerRtcCallback(selector);
        }
        else {
            this.subscribeWsInbox();
        }

        return () => this.unsubscribe(transport, subscription, listener);
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
        listener: RallarMessageHandler
    ): void {
        subscription.listeners.delete(listener);
        if (subscription.listeners.size > 0) {
            return;
        }

        const registry = this.subscriptionRegistry(transport);
        registry.delete(toRallarMessageSelectorKey(subscription.selector));
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
            listeners: new Set<RallarMessageHandler>()
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

    private async dispatch(
        transport: RallarInboundMessageTransport,
        message: ALMessage
    ): Promise<void> {
        const listeners = this.matchingListeners(transport, message);
        if (listeners.size === 0) {
            return;
        }
        const rallarMessage = toRallarMessage<never>(transport, message);
        await Promise.all(
            [...listeners].map(async (listener) => {
                try {
                    await listener(rallarMessage);
                }
                catch (error) {
                    console.error('Error notifying Rallar message listener', error);
                }
            })
        );
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
            for (const listener of subscription.listeners) {
                listeners.add(listener);
            }
        }
        return listeners;
    }
}
