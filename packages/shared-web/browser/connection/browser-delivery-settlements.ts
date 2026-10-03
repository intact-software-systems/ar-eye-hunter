import type { ALDeliverySettlement, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

export namespace BrowserDeliverySettlements {
    export interface Carriers {
        readonly ws: ALDeliverySettlementSink;
        readonly rtc: ALDeliverySettlementSink;
    }

    /** This tab's observers of the settlements its carriers state. */
    export interface Observers extends Carriers {
        /** Whether this tab holds the handle of the message a settlement reports on. */
        holds(msgId: string): boolean;
    }

    /** The session's other tabs, for one connect. */
    export interface Relay {
        relaySettlement(settlement: ALDeliverySettlement): void;
    }

    export interface Epoch {
        readonly settlements: Carriers;
        isOpen(): boolean;
        close(): void;
    }
}

/** Fences the shared queue owner; each middleware epoch fences its own late events. */
export class BrowserDeliverySettlements {
    private current: BrowserDeliverySettlements.Epoch | undefined;

    /**
     * Another tab of the session may hold the handle of a durable message this tab's carriers settle: the
     * owner tab dispatches every tab's durable sends, and any tab may admit the control that acknowledges
     * one. A durable or checkpoint lane's settlement this tab holds no handle for is relayed once; the
     * receiving tab records it through its own observers, never through an epoch, so it is not relayed
     * again. A volatile lane's settlement stays in the tab that admitted the message, so none is relayed.
     */
    open(
        observers: BrowserDeliverySettlements.Observers,
        relay: BrowserDeliverySettlements.Relay
    ): BrowserDeliverySettlements.Epoch {
        this.close();
        let open = true;
        const sink: ALDeliverySettlementSink = (event) => {
            if (!open) {
                return;
            }
            observers[event.carrier](event);
            if ((event.lane === 'durable' || event.lane === 'checkpoint') && !observers.holds(event.msgId)) {
                relay.relaySettlement(event);
            }
        };
        const epoch: BrowserDeliverySettlements.Epoch = {
            settlements: { ws: sink, rtc: sink },
            isOpen: () => open,
            close: () => {
                open = false;
            }
        };
        this.current = epoch;
        return epoch;
    }

    capture(): BrowserDeliverySettlements.Epoch | undefined {
        return this.current?.isOpen() ? this.current : undefined;
    }

    close(): void {
        this.current?.close();
        this.current = undefined;
    }
}
