import type {
    RallarMessage,
    RallarMessagePayload,
    RallarMessageReplyOutcome,
    RallarMessageReplyWaitOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { isALDeliveryTerminal, type ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

export namespace BrowserMessageReplySlots {
    export interface Request {
        readonly msgId: string;
        readonly corrId: string;
        /** The unicast's `toPeerId`; absent for an audience request, which any sender may answer. */
        readonly expectedResponderId: string | undefined;
    }

    export type Admission =
        | Readonly<{ kind: 'matched'; }>
        | Readonly<{ kind: 'late'; cause: 'replied' | 'timed-out' | 'unobserved'; }>
        | Readonly<{ kind: 'wrong-responder'; expectedSenderId: string; }>;
}

/** A reply's payload is JSON its sender wrote; only the awaiting caller can say what it should be. */
type ReplyOutcome = RallarMessageReplyOutcome<RallarMessagePayload>;

interface ReplySlot {
    readonly request: BrowserMessageReplySlots.Request;
    state: 'open' | 'replied' | 'timed-out';
    reply: RallarMessage<RallarMessagePayload> | undefined;
    readonly waits: Map<number, ReplyWait>;
}

interface ReplyWaitStart {
    readonly slot: ReplySlot;
    readonly readLifecycle: () => ALDeliveryLifecycle;
    readonly options: RallarMessageReplyWaitOptions;
    resolve(outcome: ReplyOutcome): void;
}

interface ReplyWait {
    readonly readLifecycle: () => ALDeliveryLifecycle;
    /** Drops the wait from its slot, clears its timer and abort listener, then resolves it. */
    end(outcome: ReplyOutcome): void;
}

/** One reply slot per observed request: `open`, then `replied` or `timed-out`; only the registry drops a slot. */
export class BrowserMessageReplySlots {
    private readonly slots = new Map<string, ReplySlot>();
    private waitCount = 0;

    open(request: BrowserMessageReplySlots.Request): void {
        this.slots.set(request.msgId, { request, state: 'open', reply: undefined, waits: new Map() });
    }

    record(reply: RallarMessage<RallarMessagePayload>): BrowserMessageReplySlots.Admission {
        const replyToMsgId = reply.raw.actions?.replyToMsgId;
        const slot = replyToMsgId === undefined ? undefined : this.slots.get(replyToMsgId);
        if (slot === undefined) {
            return { kind: 'late', cause: 'unobserved' };
        }
        const expectedSenderId = slot.request.expectedResponderId;
        if (expectedSenderId !== undefined && expectedSenderId !== reply.senderId) {
            return { kind: 'wrong-responder', expectedSenderId };
        }
        if (slot.state !== 'open') {
            return { kind: 'late', cause: slot.state };
        }
        slot.state = 'replied';
        slot.reply = reply;
        for (const wait of [...slot.waits.values()]) {
            wait.end({ status: 'replied', reply, lifecycle: wait.readLifecycle() });
        }
        return { kind: 'matched' };
    }

    /** The reply payload is unvalidated: `T` is the caller's claim about it. */
    async awaitReply<T>(
        msgId: string,
        readLifecycle: () => ALDeliveryLifecycle,
        options: RallarMessageReplyWaitOptions
    ): Promise<RallarMessageReplyOutcome<T>> {
        return await this.readReply(msgId, readLifecycle, options) as RallarMessageReplyOutcome<T>;
    }

    /** Resolves the request's open waits `undelivered` once its lifecycle is terminal and not delivered. */
    settleLifecycle(msgId: string, lifecycle: ALDeliveryLifecycle): void {
        const slot = this.slots.get(msgId);
        if (slot !== undefined && isReplyUndeliverable(lifecycle)) {
            endWaits(slot, { status: 'undelivered', lifecycle });
        }
    }

    hasOpenWait(msgId: string): boolean {
        return (this.slots.get(msgId)?.waits.size ?? 0) > 0;
    }

    /** The registry dropped the request: open waits resolve `undelivered` and later replies are `unobserved`. */
    release(msgId: string, lifecycle: ALDeliveryLifecycle): void {
        const slot = this.slots.get(msgId);
        if (slot !== undefined) {
            this.slots.delete(msgId);
            endWaits(slot, { status: 'undelivered', lifecycle });
        }
    }

    private async readReply(
        msgId: string,
        readLifecycle: () => ALDeliveryLifecycle,
        options: RallarMessageReplyWaitOptions
    ): Promise<ReplyOutcome> {
        const slot = this.slots.get(msgId);
        const lifecycle = readLifecycle();
        if (slot?.reply !== undefined) {
            return { status: 'replied', reply: slot.reply, lifecycle };
        }
        if (slot?.state === 'timed-out') {
            return { status: 'timeout', lifecycle };
        }
        if (slot === undefined || isReplyUndeliverable(lifecycle)) {
            return { status: 'undelivered', lifecycle };
        }
        if (options.signal?.aborted === true) {
            return { status: 'aborted', lifecycle };
        }
        return await new Promise<ReplyOutcome>((resolve) => {
            this.startWait({ slot, readLifecycle, options, resolve });
        });
    }

    /** The only place a timer exists: one for the caller's timeout, besides one abort listener. */
    private startWait(start: ReplyWaitStart): void {
        const { slot, readLifecycle, options, resolve } = start;
        this.waitCount += 1;
        const waitId = this.waitCount;
        const armed = new AbortController();
        const timerId = setTimeout(() => {
            slot.state = 'timed-out';
            for (const wait of [...slot.waits.values()]) {
                wait.end({ status: 'timeout', lifecycle: wait.readLifecycle() });
            }
        }, options.timeoutMs);
        const end = (outcome: ReplyOutcome): void => {
            slot.waits.delete(waitId);
            armed.abort();
            clearTimeout(timerId);
            resolve(outcome);
        };
        slot.waits.set(waitId, { readLifecycle, end });
        options.signal?.addEventListener('abort', () => {
            end({ status: 'aborted', lifecycle: readLifecycle() });
        }, { signal: armed.signal });
    }
}

/** `acknowledged` is the one terminal state in which the request reached its addressee. */
function isReplyUndeliverable(lifecycle: ALDeliveryLifecycle): boolean {
    return isALDeliveryTerminal(lifecycle) && lifecycle.state !== 'acknowledged';
}

function endWaits(slot: ReplySlot, outcome: ReplyOutcome): void {
    for (const wait of [...slot.waits.values()]) {
        wait.end(outcome);
    }
}
