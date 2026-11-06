import type { SubscribeViewRecovery } from '@shared-web/browser/api/subscribe-view-recovery.ts';
import type { RallarMessage, RallarMessageTransport } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { matchesRallarMessageSelector, normalizeRallarMessageSelector } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';

export class ViewPushBrowser implements SubscribeViewRecovery.Browser {
    private readonly frames = new SynchronousNotifications<RallarMessage<ApiJsonValue>>((error) => {
        throw error;
    });
    private readonly lifecycle = new SynchronousNotifications<RallarWsLifecycleEvent>((error) => {
        throw error;
    });

    readonly messages: SubscribeViewRecovery.Browser['messages'] = {
        ws: {
            onMessage: (selector, handler) => {
                const match = normalizeRallarMessageSelector(selector);
                return this.frames.subscribe((message) => {
                    if (matchesRallarMessageSelector(match, message.raw)) {
                        return handler(message);
                    }
                }).unsubscribe;
            }
        }
    };
    readonly ws: SubscribeViewRecovery.Browser['ws'] = {
        onLifecycle: (listener) => this.lifecycle.subscribe(listener).unsubscribe
    };

    readonly session: () => AuthSession | undefined;

    constructor(session: () => AuthSession | undefined) {
        this.session = session;
    }

    deliver(raw: ALMessage, transport: RallarMessageTransport = 'ws'): void {
        this.frames.publishLatest({
            raw,
            transport,
            payload: JSON.parse(raw.payload.resource),
            senderId: raw.id.senderId,
            typeId: raw.payload.typeId,
            topicId: raw.route.topicId,
            contextId: raw.route.contextId,
            resourceId: raw.route.resourceId,
            traceId: raw.id.traceId,
            receivedAtEpochMs: 1,
            reply: () => Promise.reject(new Error('Invalidation has no reply'))
        });
    }

    reopen(kind: RallarWsLifecycleEvent['kind'] = 'open'): void {
        this.lifecycle.publishLatest({
            kind,
            atEpochMs: 2,
            status: {
                connectState: 'connected',
                readyState: 'open',
                isOpen: true,
                reconnecting: false,
                reconnectEnabled: true,
                reconnectAttempts: 0,
                maxReconnectAttempts: 10,
                reconnectExhausted: false
            }
        });
    }
}
