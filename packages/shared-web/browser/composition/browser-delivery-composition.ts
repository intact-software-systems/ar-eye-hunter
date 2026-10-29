import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { BrowserPublicationStages } from '@shared-web/browser/messages/publication/browser-publication-stages.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { readSession } from '@shared/api/auth.ts';

/** One browser-wide bound matches the existing shared session/carrier work owner. */
export const BROWSER_DELIVERY_RETENTION = { retainTerminalMs: 60_000, maxEntries: 512 } as const;

export interface CreateBrowserDeliveryCancelInput {
    readonly publicationStages: BrowserPublicationStages;
    readonly readMiddleware: () => ApiMiddleware | undefined;
}

/**
 * The registry's cancel (D479): a staged live value has reached no carrier, so its stage settles it `cancelled` and
 * no carrier is asked; any other message is each carrier's to cancel, and a carrier that held it settles it.
 */
export function createBrowserDeliveryCancel(
    input: CreateBrowserDeliveryCancelInput
): BrowserRallarDeliveryRegistry.Input['cancel'] {
    return (msgId, traceId) => {
        if (input.publicationStages.cancel(msgId)) {
            return;
        }
        const middleware = input.readMiddleware()?.middleware;
        try {
            middleware?.rtcRxStreamer.cancelOutbox(msgId, traceId);
        }
        finally {
            middleware?.webSocketQueueBox.cancelOutbox(msgId, traceId);
        }
    };
}

const nowMs = Date.now;
const publicationStages = new BrowserPublicationStages({ nowMs });
const deliveries = new BrowserRallarDeliveryRegistry({
    nowMs,
    ...BROWSER_DELIVERY_RETENTION,
    cancel: createBrowserDeliveryCancel({
        publicationStages,
        readMiddleware: () => browserTransportRuntime.readMiddleware()
    })
});
const sessionDeliveries = new BrowserSessionDeliveries(deliveries, browserTransportRuntime, readSession);

export const browserDeliveryComposition = { nowMs, publicationStages, deliveries, sessionDeliveries };
