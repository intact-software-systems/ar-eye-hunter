import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';

/** One browser-wide bound matches the existing shared session/carrier work owner. */
export const BROWSER_DELIVERY_RETENTION = { retainTerminalMs: 60_000, maxEntries: 512 } as const;

const nowMs = Date.now;
const deliveries = new BrowserRallarDeliveryRegistry({
    nowMs,
    ...BROWSER_DELIVERY_RETENTION,
    cancel: (msgId) => {
        const middleware = browserTransportRuntime.readMiddleware()?.middleware;
        try {
            middleware?.rtcRxStreamer.cancelOutbox(msgId);
        }
        finally {
            middleware?.webSocketQueueBox.cancelOutbox(msgId);
        }
    }
});
const sessionDeliveries = new BrowserSessionDeliveries(deliveries, browserTransportRuntime);

export const browserDeliveryComposition = { nowMs, deliveries, sessionDeliveries };
