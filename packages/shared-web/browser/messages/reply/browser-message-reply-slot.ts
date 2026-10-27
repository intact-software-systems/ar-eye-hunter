import type {
    RallarMessage,
    RallarMessagePayload,
    RallarMessageReplyOutcome,
    RallarMessageReplyWaitOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { isALDeliveryTerminal, type ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

export namespace BrowserMessageReplySlot {
    export type Admission =
        | Readonly<{ kind: 'matched'; }>
        | Readonly<{ kind: 'late'; cause: 'replied' | 'timed-out' | 'unobserved'; }>
        | Readonly<{ kind: 'wrong-responder'; expectedSenderId: string; }>;
}

/** A reply's payload is JSON its sender wrote; only the awaiting caller can say what it should be. */
type ReplyOutcome = RallarMessageReplyOutcome<RallarMessagePayload>;

interface ReplyWait {
    readonly readLifecycle: () => ALDeliveryLifecycle;
    end(outcome: ReplyOutcome): void;
}

/**
 * The reply side of one registry entry: `open`, then `replied` or `timed-out`, and `released` once the registry drops
 * the entry. The entry owns it, so a slot never outlives the observation it answers.
 */
export class BrowserMessageReplySlot {
    private readonly expectedResponderId: string | undefined;
    private readonly waits = new Set<ReplyWait>();
    private state: 'open' | 'replied' | 'timed-out' | 'released' = 'open';
    private reply: RallarMessage<RallarMessagePayload> | undefined;

    /** `expectedResponderId` is a unicast's `toPeerId`; absent for an audience request, which any sender may answer. */
    constructor(expectedResponderId: string | undefined) {
        this.expectedResponderId = expectedResponderId;
    }

    holdsReply(): boolean {
        return this.reply !== undefined;
    }

    getWaitCount(): number {
        return this.waits.size;
    }

    record(reply: RallarMessage<RallarMessagePayload>): BrowserMessageReplySlot.Admission {
        if (this.expectedResponderId !== undefined && this.expectedResponderId !== reply.senderId) {
            return { kind: 'wrong-responder', expectedSenderId: this.expectedResponderId };
        }
        if (this.state !== 'open') {
            return { kind: 'late', cause: this.state === 'released' ? 'unobserved' : this.state };
        }
        this.state = 'replied';
        this.reply = reply;
        for (const wait of [...this.waits]) {
            wait.end({ status: 'replied', reply, lifecycle: wait.readLifecycle() });
        }
        return { kind: 'matched' };
    }

    /** The reply payload is unvalidated: `T` is the caller's claim about it. */
    async awaitReply<T>(
        readLifecycle: () => ALDeliveryLifecycle,
        options: RallarMessageReplyWaitOptions
    ): Promise<RallarMessageReplyOutcome<T>> {
        return await this.readReply(readLifecycle, options) as RallarMessageReplyOutcome<T>;
    }

    /**
     * Resolves the open waits `undelivered` once the request's lifecycle is terminal and not delivered. A slot a reply
     * or a timeout already closed is left alone: reading a wait's lifecycle while delivering that outcome can apply a
     * lapsed deadline and land here.
     */
    settleLifecycle(lifecycle: ALDeliveryLifecycle): void {
        if (this.state === 'open' && isReplyUndeliverable(lifecycle)) {
            this.endWaits(lifecycle);
        }
    }

    /** Session end: the open waits resolve `undelivered`, and the slot keeps any reply while its entry is retained. */
    endWaits(lifecycle: ALDeliveryLifecycle): void {
        for (const wait of [...this.waits]) {
            wait.end({ status: 'undelivered', lifecycle });
        }
    }

    /** The registry dropped the entry: open waits resolve `undelivered`, and so does every later wait. */
    release(lifecycle: ALDeliveryLifecycle): void {
        this.state = 'released';
        this.endWaits(lifecycle);
    }

    private async readReply(
        readLifecycle: () => ALDeliveryLifecycle,
        options: RallarMessageReplyWaitOptions
    ): Promise<ReplyOutcome> {
        const lifecycle = readLifecycle();
        if (this.state === 'released') {
            return { status: 'undelivered', lifecycle };
        }
        if (this.reply !== undefined) {
            return { status: 'replied', reply: this.reply, lifecycle };
        }
        if (this.state === 'timed-out') {
            return { status: 'timeout', lifecycle };
        }
        if (isReplyUndeliverable(lifecycle)) {
            return { status: 'undelivered', lifecycle };
        }
        if (options.signal?.aborted === true) {
            return { status: 'aborted', lifecycle };
        }
        return await new Promise<ReplyOutcome>((resolve) => {
            this.startWait(readLifecycle, options, resolve);
        });
    }

    private startWait(
        readLifecycle: () => ALDeliveryLifecycle,
        options: RallarMessageReplyWaitOptions,
        resolve: (outcome: ReplyOutcome) => void
    ): void {
        const armed = new AbortController();
        const timerId = setTimeout(() => this.timeOut(), options.timeoutMs);
        const wait: ReplyWait = {
            readLifecycle,
            end: (outcome) => {
                this.waits.delete(wait);
                armed.abort();
                clearTimeout(timerId);
                resolve(outcome);
            }
        };
        this.waits.add(wait);
        options.signal?.addEventListener('abort', () => {
            wait.end({ status: 'aborted', lifecycle: readLifecycle() });
        }, { signal: armed.signal });
    }

    private timeOut(): void {
        this.state = 'timed-out';
        for (const wait of [...this.waits]) {
            wait.end({ status: 'timeout', lifecycle: wait.readLifecycle() });
        }
    }
}

/** A request terminal `acknowledged`, or `transport-accepted` without a receipt to wait for, reached its addressee. */
function isReplyUndeliverable(lifecycle: ALDeliveryLifecycle): boolean {
    return isALDeliveryTerminal(lifecycle) && lifecycle.state !== 'acknowledged' &&
        lifecycle.state !== 'transport-accepted';
}
