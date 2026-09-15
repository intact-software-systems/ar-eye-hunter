import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

export namespace BrowserDeliverySettlements {
    export interface Carriers {
        readonly ws: ALDeliverySettlementSink;
        readonly rtc: ALDeliverySettlementSink;
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

    open(observers: BrowserDeliverySettlements.Carriers): BrowserDeliverySettlements.Epoch {
        this.close();
        let open = true;
        const sink: ALDeliverySettlementSink = (event) => {
            if (!open) {
                return;
            }
            observers[event.carrier](event);
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
