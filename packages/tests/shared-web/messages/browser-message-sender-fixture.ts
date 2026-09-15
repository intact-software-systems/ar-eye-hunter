import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALBroadcastMessage, newALMulticastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { vi, type Mock } from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
interface BrowserMessageSenderFixture {
    readonly sender: BrowserRallarMessageSender;
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly middleware: ApiMiddleware;
    readonly connect: Mock<() => Promise<ApiMiddleware>>;
    replaceTransport(): void;
}

export function createBrowserMessageSenderFixture(maxPayloadBytes = 64 * 1024): BrowserMessageSenderFixture {
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const middleware = createDefaultApiMiddlewareTestDouble();
    let activeMiddleware = middleware;
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => activeMiddleware });
    sessionDeliveries.beginSession(middleware.session);
    feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
    const connect = vi.fn<() => Promise<ApiMiddleware>>().mockResolvedValue(middleware);
    const sender = new BrowserRallarMessageSender({
        creation: {
            createUnicast: newALUnicastMessage,
            createMulticast: newALMulticastMessage,
            createBroadcast: newALBroadcastMessage,
            newResourceId: crypto.randomUUID.bind(crypto)
        },
        deliveries: registry,
        dispatch: new BrowserRallarMessageDispatch({ deliveries: registry, sessionDeliveries, nowMs: Date.now }),
        inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => maxPayloadBytes }),
        connect,
        requireSession: () => middleware.session,
        resolveDefaultRoom: () => roomRef,
        resolveCurrentRoomRef: () => roomRef,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: () => roomRef,
        resolveRoomMinSnapshotVersion: (_room, explicit) => explicit
    });
    return {
        sender,
        connect,
        registry,
        middleware,
        replaceTransport: () => {
            activeMiddleware = createDefaultApiMiddlewareTestDouble();
            feed.close();
            feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
        }
    };
}

export function toQueuedMessageAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return { status: 'enqueued', verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }, message, entries: [] };
}
