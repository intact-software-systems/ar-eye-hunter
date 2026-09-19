import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';

/** Owns volatile delivery observation for the browser's shared authenticated session. */
export class BrowserSessionDeliveries {
    readonly settle: ALDeliverySettlementSink;
    private sessionKey: string | undefined;
    private readonly deliveries: BrowserRallarDeliveryRegistry;
    private readonly transport: Pick<BrowserTransportRuntimePort, 'deliverySettlements' | 'readMiddleware'>;

    constructor(
        deliveries: BrowserRallarDeliveryRegistry,
        transport: Pick<BrowserTransportRuntimePort, 'deliverySettlements' | 'readMiddleware'>
    ) {
        this.deliveries = deliveries;
        this.transport = transport;
        this.settle = (event) => deliveries.record(event);
    }

    beginSession(session: AuthSession): void {
        if (this.matches(session)) {
            return;
        }
        this.deliveries.releaseAll();
        this.sessionKey = toAuthSessionKey(session);
    }

    endSession(session: AuthSession): void {
        if (!this.matches(session)) {
            return;
        }
        this.deliveries.releaseAll();
        this.sessionKey = undefined;
    }

    capture(context: ApiMiddleware): BrowserDeliverySettlements.Epoch | undefined {
        if (this.transport.readMiddleware() !== context) {
            return undefined;
        }
        return this.transport.deliverySettlements.capture();
    }

    private matches(session: AuthSession): boolean {
        return this.sessionKey === toAuthSessionKey(session);
    }
}
