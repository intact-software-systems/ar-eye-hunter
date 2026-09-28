import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    isALDeliveryFallbackPastDeadline,
    resolveALDeliveryFallbackTrigger
} from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';

/**
 * The admitted RTC leg of an `rtc-with-ws-fallback` send: what a hand-over needs, and the dispatch's own
 * admission of the same envelope on WS, so the dispatch stays the one place that admits (Q2).
 */
export interface BrowserMessageFallbackCandidate {
    /** The envelope the RTC admission returned: its frozen audience and its deadline travel to WS unchanged. */
    readonly message: ALMessage;
    /** The middleware whose RTC owner hands the message over. */
    readonly context: ApiMiddleware;
    /** Admits `message` on WS with `canFallback: false` in the epoch the first leg captured; never rejects. */
    readonly readmit: () => Promise<void>;
}

/** One watched RTC leg and the consecutive `not-ready` attempts counted on it so far. */
interface BrowserMessageFallbackWatch {
    readonly candidate: BrowserMessageFallbackCandidate;
    notReadyRun: number;
}

export namespace BrowserMessageFallbackController {
    export interface Input {
        readonly nowMs: () => number;
    }
}

/**
 * Post-admission fallback for `rtc-with-ws-fallback` (D56). The registry hands it every settlement it
 * records; on a declared retryable outcome of a watched RTC leg inside the unchanged deadline it hands the
 * message to WS once: the RTC owner ends its own work without a `cancelled`, and the dispatch admits the
 * same envelope on WS. A durable message resumed after a reload has no handle, so it is never watched (Q9).
 */
export class BrowserMessageFallbackController {
    private readonly input: BrowserMessageFallbackController.Input;
    private readonly watches = new Map<string, BrowserMessageFallbackWatch>();

    constructor(input: BrowserMessageFallbackController.Input) {
        this.input = input;
    }

    /** The first registration of a msgId wins: a fallback re-sends the same envelope. */
    watch(candidate: BrowserMessageFallbackCandidate): void {
        const msgId = candidate.message.id.msgId;
        if (!this.watches.has(msgId)) {
            this.watches.set(msgId, { candidate, notReadyRun: 0 });
        }
    }

    release(msgId: string): void {
        this.watches.delete(msgId);
    }

    /**
     * Starts the hand-over and the WS re-admission when this settlement ends a watched RTC leg inside the
     * deadline. Returns what the registry records for it: the settlement itself, or the `carrier-fallback`
     * beside it -- instead of it for a `receipt-exhausted`, which would otherwise end a message the WS leg
     * now owns.
     */
    recordSettlement(settlement: ALDeliverySettlement): readonly ALDeliverySettlement[] {
        const watch = this.watches.get(settlement.msgId);
        if (watch === undefined) {
            return [settlement];
        }
        const trigger = resolveALDeliveryFallbackTrigger({
            settlement,
            leg: 'rtc',
            notReadyRun: watch.notReadyRun
        });
        if (trigger.kind === 'continue') {
            watch.notReadyRun = trigger.notReadyRun;
            return [settlement];
        }
        this.watches.delete(settlement.msgId);
        const atMs = this.input.nowMs();
        if (isALDeliveryFallbackPastDeadline(watch.candidate.message.constraints?.expiresAtMs, atMs)) {
            return [settlement];
        }
        void this.writeFallback(watch.candidate);
        const fallback: ALDeliverySettlement = {
            kind: 'carrier-fallback',
            msgId: settlement.msgId,
            carrier: 'rtc',
            atMs,
            to: 'ws',
            reason: trigger.reason,
            detail: trigger.detail
        };
        return settlement.kind === 'receipt-exhausted' ? [fallback] : [settlement, fallback];
    }

    /** A hand-over that fails leaves the WS leg to try anyway: the RTC owner is gone or disposed. */
    private async writeFallback(candidate: BrowserMessageFallbackCandidate): Promise<void> {
        const msgId = candidate.message.id.msgId;
        await candidate.context.middleware.rtcRxStreamer.handOverOutbox(msgId).catch(
            (error: unknown) => {
                console.error(
                    `AL RTC hand-over of ${msgId} failed; admitting it on WS anyway`,
                    error
                );
            }
        );
        await candidate.readmit();
    }
}
