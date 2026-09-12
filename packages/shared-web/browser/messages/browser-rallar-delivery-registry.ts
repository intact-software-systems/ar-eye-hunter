import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type {
    RallarMessageDeliveryListener,
    RallarMessageDeliveryOutcome,
    RallarMessageHandle,
    RallarMessageWaitOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
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

/** The mutable observation of one message; the handle handed to the sender closes over exactly this object. */
interface DeliveryObservation {
    readonly msgId: string;
    readonly listeners: Set<RallarMessageDeliveryListener>;
    readonly waits: Map<number, DeliveryWait>;
    lifecycle: ALDeliveryLifecycle;
    /** The carrier of the last settlement seen, which is the one a cancel is recorded against. */
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
}

/** Owns the browser's delivery observations: the open handles, their listeners and waits, and retention. */
export class BrowserRallarDeliveryRegistry {
    private readonly entries = new Map<string, DeliveryEntry>();
    private readonly input: BrowserRallarDeliveryRegistry.Input;
    private waitCount = 0;

    constructor(input: BrowserRallarDeliveryRegistry.Input) {
        this.input = input;
    }

    /** Returns the existing handle for the same msgId, because a fallback re-sends the same envelope. */
    open(message: ALMessage, carrier: ALDeliveryCarrier): RallarMessageHandle {
        const existing = this.entries.get(message.id.msgId);
        if (existing !== undefined) {
            return existing.handle;
        }

        const observation = this.createObservation(message, carrier);
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

    /** A msgId the registry never opened is ignored: it observes only the messages it handed a handle for. */
    record(settlement: ALDeliverySettlement): void {
        const entry = this.entries.get(settlement.msgId);
        if (entry === undefined) {
            return;
        }

        entry.observation.carrier = settlement.carrier;
        this.publishLifecycle(
            entry.observation,
            computeALDeliveryLifecycle(entry.observation.lifecycle, settlement)
        );
    }

    /** Ends one observation whose captured transport no longer exists. */
    release(msgId: string): void {
        const observation = this.entries.get(msgId)?.observation;
        if (observation) {
            this.releaseObservation(observation);
        }
    }

    /** Session end/replacement preserves terminal evidence and releases every live observation. */
    releaseAll(): void {
        for (const entry of [...this.entries.values()]) {
            this.releaseObservation(entry.observation);
        }
    }

    size(): number {
        return this.entries.size;
    }

    private createObservation(message: ALMessage, carrier: ALDeliveryCarrier): DeliveryObservation {
        return {
            msgId: message.id.msgId,
            listeners: new Set(),
            waits: new Map(),
            lifecycle: createInitialALDeliveryLifecycle({
                msgId: message.id.msgId,
                typeId: message.payload.typeId,
                ackMode: message.delivery?.ack ?? 'none',
                expiresAtMs: message.constraints?.expiresAtMs,
                submittedAtMs: this.input.nowMs()
            }),
            carrier,
            terminalAtMs: undefined
        };
    }

    private createHandle(observation: DeliveryObservation): RallarMessageHandle {
        return {
            msgId: observation.lifecycle.msgId,
            typeId: observation.lifecycle.typeId,
            lifecycle: () => this.readLifecycle(observation),
            onEvent: (listener) => subscribeToObservation(observation, listener),
            wait: async (options) => await this.wait(observation, options ?? {}),
            cancel: () => this.cancel(observation)
        };
    }

    /** Stores the reduced lifecycle, then settles the waits it satisfies, then notifies the listeners. */
    private publishLifecycle(observation: DeliveryObservation, next: ALDeliveryLifecycle): void {
        observation.lifecycle = next;
        if (observation.terminalAtMs === undefined && isALDeliveryTerminal(next)) {
            observation.terminalAtMs = this.input.nowMs();
        }

        settleReachedWaits(observation, next);
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

    /** Retention runs only here: aged terminal entries, then the oldest terminal, then the oldest live ones. */
    private retainEntries(): void {
        this.dropAgedTerminalEntries();
        this.dropOldestTerminalEntries();
        this.releaseOldestEntries();
    }

    private dropAgedTerminalEntries(): void {
        const nowMs = this.input.nowMs();
        for (const [msgId, entry] of this.entries) {
            const terminalAtMs = entry.observation.terminalAtMs;
            if (terminalAtMs !== undefined && nowMs - terminalAtMs > this.input.retainTerminalMs) {
                this.entries.delete(msgId);
            }
        }
    }

    private dropOldestTerminalEntries(): void {
        for (const [msgId, entry] of this.entries) {
            if (this.entries.size <= this.input.maxEntries) {
                return;
            }
            if (entry.observation.terminalAtMs !== undefined) {
                this.entries.delete(msgId);
            }
        }
    }

    private releaseOldestEntries(): void {
        const evicted: DeliveryObservation[] = [];
        for (const [msgId, entry] of this.entries) {
            if (this.entries.size <= this.input.maxEntries) {
                break;
            }
            this.entries.delete(msgId);
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
