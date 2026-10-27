import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type {
    RallarMessage,
    RallarMessageDeliveryListener,
    RallarMessageDeliveryOutcome,
    RallarMessageHandle,
    RallarMessagePayload,
    RallarMessageWaitOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALCorrId } from '@shared/al-contracts/reply/to-al-reply-actions.ts';
import {
    createInitialALDeliveryLifecycle,
    isALDeliveryTerminal,
    type ALDeliveryCarrier,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    computeALDeliveryDeadline,
    computeALDeliveryLifecycle,
    computeALDeliveryUnobservable
} from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import {
    BrowserMessageFallbackController,
    type BrowserMessageFallbackCandidate
} from './browser-message-fallback-controller.ts';
import { BrowserMessageReplySlot } from './reply/browser-message-reply-slot.ts';

/** The mutable observation of one message; the handle handed to the sender closes over exactly this object. */
interface DeliveryObservation {
    readonly rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
    readonly msgId: string;
    readonly corrId: string;
    readonly replyToMsgId: string | undefined;
    readonly listeners: Set<RallarMessageDeliveryListener>;
    readonly waits: Map<number, DeliveryWait>;
    readonly replySlot: BrowserMessageReplySlot;
    lifecycle: ALDeliveryLifecycle;
    /**
     * The carrier of the last settlement seen, which is the one a cancel is recorded against; after a
     * `carrier-fallback` row it names the carrier the message left until the WS admission settles.
     */
    carrier: ALDeliveryCarrier;
    /** When the lifecycle first became terminal; retention ages a terminal entry from it. */
    terminalAtMs: number | undefined;
}

interface DeliveryWait {
    readonly until: readonly ALDeliveryState[] | undefined;
    resolve(outcome: RallarMessageDeliveryOutcome): void;
    /** Drops the wait from its observation and clears the timers and abort listener it armed. */
    release(): void;
    updateDeadline(): void;
}

interface DeliveryEntry {
    readonly observation: DeliveryObservation;
    readonly handle: RallarMessageHandle;
}

/** What one wait's deadline timer needs to fire, publish, and re-arm itself. */
interface DeliveryDeadlineTimer {
    readonly observation: DeliveryObservation;
    timerId: ReturnType<typeof setTimeout> | undefined;
}

export namespace BrowserRallarDeliveryRegistry {
    export interface Input {
        readonly nowMs: () => number;
        /** Terminal entries are kept this long so a late `wait()` still reads its evidence. */
        readonly retainTerminalMs: number;
        readonly maxEntries: number;
        /** Reaches every carrier owner the message was admitted to; the registry records the `cancelled` settlement itself. */
        cancel(msgId: string): void;
    }

    export interface ReplyCounts {
        readonly repliesHeld: number;
        readonly replyWaitsOpen: number;
    }
}

/** Owns the browser's delivery observations: the open handles, their listeners and waits, and retention. */
export class BrowserRallarDeliveryRegistry {
    private readonly entries = new Map<string, DeliveryEntry>();
    private readonly input: BrowserRallarDeliveryRegistry.Input;
    private readonly fallback: BrowserMessageFallbackController;
    private waitCount = 0;

    constructor(input: BrowserRallarDeliveryRegistry.Input) {
        this.input = input;
        this.fallback = new BrowserMessageFallbackController({ nowMs: input.nowMs });
    }

    /** Returns the existing handle for the same msgId, because a fallback re-sends the same envelope. */
    open(
        message: ALMessage,
        carrier: ALDeliveryCarrier,
        rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt> = Object.freeze({
            status: 'unavailable',
            reason: 'absent'
        })
    ): RallarMessageHandle {
        const existing = this.entries.get(message.id.msgId);
        if (existing !== undefined) {
            return existing.handle;
        }

        const observation = this.createObservation(message, carrier, rtcCapture);
        const entry: DeliveryEntry = { observation, handle: this.createHandle(observation) };
        this.entries.set(observation.msgId, entry);
        this.retainEntries();
        return entry.handle;
    }

    updateDeadline(message: ALMessage): void {
        const observation = this.entries.get(message.id.msgId)?.observation;
        const expiresAtMs = message.constraints?.expiresAtMs;
        if (
            !observation || expiresAtMs === undefined ||
            (observation.lifecycle.expiresAtMs !== undefined && expiresAtMs >= observation.lifecycle.expiresAtMs)
        ) {
            return;
        }
        this.publishLifecycle(
            observation,
            computeALDeliveryDeadline({ ...observation.lifecycle, expiresAtMs }, this.input.nowMs())
        );
        for (const wait of observation.waits.values()) {
            wait.updateDeadline();
        }
    }

    /** The dispatch hands the admitted RTC leg of an `rtc-with-ws-fallback` send to the one fallback owner (D56). */
    watchFallback(candidate: BrowserMessageFallbackCandidate): void {
        const observation = this.entries.get(candidate.message.id.msgId)?.observation;
        if (observation !== undefined && !isALDeliveryTerminal(observation.lifecycle)) {
            this.fallback.watch(candidate);
        }
    }

    /** A msgId the registry never opened is ignored: it observes only the messages it handed a handle for. */
    record(settlement: ALDeliverySettlement): void {
        const entry = this.entries.get(settlement.msgId);
        if (entry === undefined) {
            return;
        }

        for (const recorded of this.fallback.recordSettlement(settlement)) {
            entry.observation.carrier = recorded.carrier;
            this.publishLifecycle(
                entry.observation,
                computeALDeliveryLifecycle(entry.observation.lifecycle, recorded)
            );
        }
    }

    /** A reply to a msgId the registry no longer retains is `unobserved`: it has no entry, so it has no slot. */
    recordReply(reply: RallarMessage<RallarMessagePayload>): BrowserMessageReplySlot.Admission {
        const replyToMsgId = reply.raw.actions?.replyToMsgId;
        const entry = replyToMsgId === undefined ? undefined : this.entries.get(replyToMsgId);
        return entry === undefined
            ? { kind: 'late', cause: 'unobserved' }
            : entry.observation.replySlot.record(reply);
    }

    getReplyCounts(): BrowserRallarDeliveryRegistry.ReplyCounts {
        const slots = [...this.entries.values()].map(({ observation }) => observation.replySlot);
        return {
            repliesHeld: slots.filter((slot) => slot.holdsReply()).length,
            replyWaitsOpen: slots.reduce((waits, slot) => waits + slot.getWaitCount(), 0)
        };
    }

    /** Ends one observation whose captured transport no longer exists. */
    release(msgId: string): void {
        const observation = this.entries.get(msgId)?.observation;
        if (observation) {
            this.releaseObservation(observation);
        }
    }

    /** Session end/replacement preserves terminal evidence, releases every live observation and ends every reply wait. */
    releaseAll(): void {
        for (const { observation } of [...this.entries.values()]) {
            this.releaseObservation(observation);
            observation.replySlot.endWaits(observation.lifecycle);
        }
    }

    /** Undefined once retention removed the entry, so a caller holds no observation beyond the registry bounds. */
    getHandle(msgId: string): RallarMessageHandle | undefined {
        return this.entries.get(msgId)?.handle;
    }

    size(): number {
        return this.entries.size;
    }

    private createObservation(
        message: ALMessage,
        carrier: ALDeliveryCarrier,
        rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>
    ): DeliveryObservation {
        return {
            rtcCapture,
            msgId: message.id.msgId,
            corrId: toALCorrId(message),
            replyToMsgId: message.actions?.replyToMsgId,
            listeners: new Set(),
            waits: new Map(),
            lifecycle: createInitialALDeliveryLifecycle({
                msgId: message.id.msgId,
                typeId: message.payload.typeId,
                ackMode: message.delivery?.ack ?? 'none',
                receiptAlgo: resolveALDeliveryReceiptAlgo(message),
                expiresAtMs: message.constraints?.expiresAtMs,
                submittedAtMs: this.input.nowMs()
            }),
            carrier,
            terminalAtMs: undefined,
            replySlot: new BrowserMessageReplySlot(
                message.targets?.mode === 'unicast' ? message.targets.toPeerId : undefined
            )
        };
    }

    private createHandle(observation: DeliveryObservation): RallarMessageHandle {
        return {
            msgId: observation.lifecycle.msgId,
            typeId: observation.lifecycle.typeId,
            corrId: observation.corrId,
            replyToMsgId: observation.replyToMsgId,
            rtcCapture: () => observation.rtcCapture,
            lifecycle: () => this.readLifecycle(observation),
            onEvent: (listener) => subscribeToObservation(observation, listener),
            wait: async (options) => await this.wait(observation, options ?? {}),
            awaitReply: async (options) =>
                await observation.replySlot.awaitReply(() => this.readLifecycle(observation), options),
            cancel: () => this.cancel(observation)
        };
    }

    /** Stores the reduced lifecycle, then settles the waits it satisfies, then notifies the listeners. */
    private publishLifecycle(observation: DeliveryObservation, next: ALDeliveryLifecycle): void {
        observation.lifecycle = next;
        if (observation.terminalAtMs === undefined && isALDeliveryTerminal(next)) {
            observation.terminalAtMs = this.input.nowMs();
            this.fallback.release(observation.msgId);
        }

        settleReachedWaits(observation, next);
        observation.replySlot.settleLifecycle(next);
        notifyObservationListeners(observation, next);
    }

    /** No owner emits the deadline, so a read applies it before answering. */
    private readLifecycle(observation: DeliveryObservation): ALDeliveryLifecycle {
        const deadlined = computeALDeliveryDeadline(observation.lifecycle, this.input.nowMs());
        if (deadlined !== observation.lifecycle) {
            this.publishLifecycle(observation, deadlined);
        }
        return observation.lifecycle;
    }

    /** Ends an observation the registry can no longer follow: eviction, session end, or replacement. */
    private releaseObservation(observation: DeliveryObservation): void {
        const released = computeALDeliveryUnobservable(observation.lifecycle);
        if (released !== observation.lifecycle) {
            this.publishLifecycle(observation, released);
        }
    }

    private cancel(observation: DeliveryObservation): void {
        // The deadline decides terminality here too, so an elapsed message ends `expired` and
        // reaches no owner, whether or not anything read the handle first.
        if (isALDeliveryTerminal(this.readLifecycle(observation))) {
            return;
        }

        this.input.cancel(observation.msgId);
        // An owner that held the message emits its own `cancelled` synchronously inside that call.
        if (isALDeliveryTerminal(observation.lifecycle)) {
            return;
        }

        this.record({
            kind: 'cancelled',
            msgId: observation.msgId,
            carrier: observation.carrier,
            atMs: this.input.nowMs()
        });
    }

    private async wait(
        observation: DeliveryObservation,
        options: RallarMessageWaitOptions
    ): Promise<RallarMessageDeliveryOutcome> {
        const current = this.readLifecycle(observation);
        if (isDeliveryWaitSatisfied(current, options.until)) {
            return { status: 'settled', lifecycle: current };
        }
        if (options.signal?.aborted === true) {
            return { status: 'aborted', lifecycle: current };
        }

        return await new Promise<RallarMessageDeliveryOutcome>((resolve) => {
            this.startWait(observation, options, resolve);
        });
    }

    /** The only place a timer exists: one for the caller's timeout, one for the message deadline. */
    private startWait(
        observation: DeliveryObservation,
        options: RallarMessageWaitOptions,
        resolve: (outcome: RallarMessageDeliveryOutcome) => void
    ): void {
        this.waitCount += 1;
        const waitId = this.waitCount;
        const armed = new AbortController();
        const timerIds: ReturnType<typeof setTimeout>[] = [];
        const deadline: DeliveryDeadlineTimer = { observation, timerId: undefined };
        const release = (): void => {
            observation.waits.delete(waitId);
            armed.abort();
            clearTimeout(deadline.timerId);
            for (const timerId of timerIds) {
                clearTimeout(timerId);
            }
        };

        const updateDeadline = (): void => {
            clearTimeout(deadline.timerId);
            this.scheduleDeadlineTimer(deadline);
        };
        observation.waits.set(waitId, { until: options.until, resolve, release, updateDeadline });
        options.signal?.addEventListener('abort', () => {
            release();
            resolve({ status: 'aborted', lifecycle: this.readLifecycle(observation) });
        }, { signal: armed.signal });

        if (options.timeoutMs !== undefined) {
            timerIds.push(setTimeout(() => {
                release();
                resolve({ status: 'timeout', lifecycle: this.readLifecycle(observation) });
            }, options.timeoutMs));
        }

        updateDeadline();
    }

    /** Re-read the current deadline if a timer fires before the wall clock reaches it. */
    private scheduleDeadlineTimer(deadline: DeliveryDeadlineTimer): void {
        const expiresAtMs = deadline.observation.lifecycle.expiresAtMs;
        if (expiresAtMs === undefined) {
            return;
        }
        deadline.timerId = setTimeout(() => {
            if (!isALDeliveryTerminal(this.readLifecycle(deadline.observation))) {
                this.scheduleDeadlineTimer(deadline);
            }
        }, Math.max(1, expiresAtMs - this.input.nowMs()));
    }

    /**
     * Retention runs only here: aged terminal entries without an open reply wait, then the oldest terminal, then the
     * oldest live ones. Every dropped entry releases its reply slot.
     */
    private retainEntries(): void {
        this.dropAgedTerminalEntries();
        this.dropOldestTerminalEntries();
        this.releaseOldestEntries();
    }

    private dropAgedTerminalEntries(): void {
        const nowMs = this.input.nowMs();
        for (const entry of this.entries.values()) {
            const terminalAtMs = entry.observation.terminalAtMs;
            if (
                terminalAtMs !== undefined && nowMs - terminalAtMs > this.input.retainTerminalMs &&
                entry.observation.replySlot.getWaitCount() === 0
            ) {
                this.dropTerminalEntry(entry.observation);
            }
        }
    }

    private dropOldestTerminalEntries(): void {
        for (const entry of this.entries.values()) {
            if (this.entries.size <= this.input.maxEntries) {
                return;
            }
            if (entry.observation.terminalAtMs !== undefined) {
                this.dropTerminalEntry(entry.observation);
            }
        }
    }

    private dropTerminalEntry(observation: DeliveryObservation): void {
        this.entries.delete(observation.msgId);
        observation.replySlot.release(observation.lifecycle);
    }

    private releaseOldestEntries(): void {
        const evicted: DeliveryObservation[] = [];
        for (const [msgId, entry] of this.entries) {
            if (this.entries.size <= this.input.maxEntries) {
                break;
            }
            this.entries.delete(msgId);
            entry.observation.replySlot.release(computeALDeliveryUnobservable(entry.observation.lifecycle));
            evicted.push(entry.observation);
        }

        // Listeners run only once the map has settled: one that re-sends on `unobservable`
        // re-enters `open()`, and it must not do that inside a live eviction.
        for (const observation of evicted) {
            this.releaseObservation(observation);
        }
    }
}

function subscribeToObservation(
    observation: DeliveryObservation,
    listener: RallarMessageDeliveryListener
): RallarUnsubscribe {
    observation.listeners.add(listener);
    return () => {
        observation.listeners.delete(listener);
    };
}

function settleReachedWaits(observation: DeliveryObservation, lifecycle: ALDeliveryLifecycle): void {
    for (const wait of [...observation.waits.values()]) {
        if (isDeliveryWaitSatisfied(lifecycle, wait.until)) {
            wait.release();
            wait.resolve({ status: 'settled', lifecycle });
        }
    }
}

function notifyObservationListeners(
    observation: DeliveryObservation,
    lifecycle: ALDeliveryLifecycle
): void {
    for (const listener of [...observation.listeners]) {
        notifyListener(listener, lifecycle);
    }
}

function isDeliveryWaitSatisfied(
    lifecycle: ALDeliveryLifecycle,
    until: readonly ALDeliveryState[] | undefined
): boolean {
    return isALDeliveryTerminal(lifecycle) || until?.includes(lifecycle.state) === true;
}
