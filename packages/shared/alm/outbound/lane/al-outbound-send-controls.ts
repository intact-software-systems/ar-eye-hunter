import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';

/** What a `cancel` call decided: a message the owner never saw still moves the set and returns `cancelled`. */
export type ALOutboundCancelOutcome = 'cancelled' | 'already-cancelled';

/** What a `handOver` call decided: only the first call for a message not already ended hands it over. */
export type ALOutboundHandOverOutcome = 'handed-over' | 'already-ended';

/** One message's live transport controller, shared by its concurrent attempts, and how many hold it open. */
interface ALOutboundLiveSendControl {
    readonly controller: AbortController;
    liveAttempts: number;
}

/**
 * The transport signals of one outbound owner, shared by every store lane it routes to: `cancel` must
 * reach a message whichever lane admitted it, and disposal must abort every live attempt.
 */
export class ALOutboundSendControls {
    private readonly sendAbortController = new AbortController();
    /** Held for the owner's lifetime (README "Transport attempt settlement"): never drained, never persisted. */
    private readonly cancelledMsgIds = new Set<string>();
    /** Held for the owner's lifetime, as cancellations are: another carrier's owner took these messages (D56). */
    private readonly handedOverMsgIds = new Set<string>();
    private readonly liveMessageSendControllers = new Map<string, ALOutboundLiveSendControl>();

    /** Aborts with the owner, so an aborted signal is exactly a disposed owner. */
    get signal(): AbortSignal {
        return this.sendAbortController.signal;
    }

    /** Remembers the id for the owner's lifetime and aborts a live attempt; the caller states the settlement. */
    cancel(msgId: string): ALOutboundCancelOutcome {
        if (this.cancelledMsgIds.has(msgId)) {
            return 'already-cancelled';
        }
        this.cancelledMsgIds.add(msgId);
        this.liveMessageSendControllers.get(msgId)?.controller.abort();
        return 'cancelled';
    }

    /**
     * Remembers the id for the owner's lifetime and aborts a live attempt, as `cancel` does, but the caller
     * states nothing: the message is not cancelled, another carrier took it (D56).
     */
    handOver(msgId: string): ALOutboundHandOverOutcome {
        if (this.isEnded(msgId)) {
            return 'already-ended';
        }
        this.handedOverMsgIds.add(msgId);
        this.liveMessageSendControllers.get(msgId)?.controller.abort();
        return 'handed-over';
    }

    /** A cancelled or handed-over message: every later effect of it completes without sending. */
    isEnded(msgId: string): boolean {
        return this.cancelledMsgIds.has(msgId) || this.handedOverMsgIds.has(msgId);
    }

    /**
     * One controller per message, shared by concurrent attempts on it -- the RTC owner commits one
     * `send-prepared` row per next-hop peer, and `cancel` must abort all of them together.
     */
    acquire(msgId: string): AbortSignal {
        const live = this.liveMessageSendControllers.get(msgId);
        if (live) {
            live.liveAttempts += 1;
            return live.controller.signal;
        }
        const controller = new AbortController();
        this.liveMessageSendControllers.set(msgId, { controller, liveAttempts: 1 });
        return controller.signal;
    }

    /** A retained attempt keeps its message controller open until the transport truly settles it. */
    releaseWhenSettled(msgId: string, result: ALWorkAttemptResult): void {
        if (result.status !== 'retained') {
            this.release(msgId);
            return;
        }
        const release = () => this.release(msgId);
        void result.settled.then(release, release);
    }

    release(msgId: string): void {
        const live = this.liveMessageSendControllers.get(msgId);
        if (!live) {
            return;
        }
        live.liveAttempts -= 1;
        if (live.liveAttempts <= 0) {
            this.liveMessageSendControllers.delete(msgId);
        }
    }

    /**
     * Aborts every live message controller, then the owner-wide signal. Disposal ends local transport
     * work as cancellation does, but states no `cancelled` fact of its own: each interrupted attempt
     * still terminates through its own `attempt-settled cancelled`.
     */
    dispose(): void {
        for (const live of this.liveMessageSendControllers.values()) {
            live.controller.abort();
        }
        this.sendAbortController.abort();
    }
}
