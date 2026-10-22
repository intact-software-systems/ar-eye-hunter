import { createDefaultTimers, type Timers } from '../../resilience/timers.ts';

/**
 * A waiter with a live completion subscription re-reads on a wake, or on this tick when a wake was lost. Well below
 * any caller's HTTP allowance (the native fixtures allow 5 s), so one lost wake costs a tick, not the request.
 */
export const RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS = 1_000;

export namespace ResourceInboxCompletionNotifications {
    export interface Identity {
        readonly topicId: string;
        readonly resourceId: string;
        readonly contextId: string | undefined;
    }

    /**
     * Why a wait ended: a completion of the subscribed identity since the last read began, the instance-wide safety
     * tick, its own delay because the tick was not due within it, or the subscription's close.
     */
    export type WakeReason = 'completion' | 'tick' | 'delay' | 'closed';

    export interface Subscription {
        beginRead(): void;
        /** Ends on a wake, at the instance-wide safety tick when it is due within the delay, or after the delay. */
        wait(delayMsecs: number): Promise<WakeReason>;
        close(): void;
    }

    /** Carries a completion no waiter in this process observed to the other processes sharing the queue. */
    export type Relay = (identity: Identity) => void;

    /** Whether any caller can wait for the completion; a fire-and-forget one has no waiter in another process. */
    export type Awaitability = 'awaitable' | 'fire-and-forget';
}

interface ResourceInboxCompletionWait {
    readonly resolve: (reason: ResourceInboxCompletionNotifications.WakeReason) => void;
    cancel: (() => void) | undefined;
}

/** How the safety tick ended a wait it scheduled. */
type ResourceInboxSafetyTickEnd = 'tick' | 'delay';

interface ResourceInboxSafetyTickRound {
    readonly dueAtMs: number;
    cancel: (() => void) | undefined;
}

export class ResourceInboxCompletionNotifications {
    private readonly subscriptions = new Map<string, Set<ResourceInboxCompletionSubscription>>();
    private readonly safetyTick: ResourceInboxSafetyTick;
    private readonly relay: ResourceInboxCompletionNotifications.Relay | undefined;

    /** Without a relay the process is the queue's only reader, so every waiter it could wake is its own. */
    constructor(timers: Timers, relay?: ResourceInboxCompletionNotifications.Relay) {
        this.safetyTick = new ResourceInboxSafetyTick(timers);
        this.relay = relay;
    }

    static createDefault(relay?: ResourceInboxCompletionNotifications.Relay): ResourceInboxCompletionNotifications {
        return new ResourceInboxCompletionNotifications(createDefaultTimers(), relay);
    }

    subscribe(
        identity: ResourceInboxCompletionNotifications.Identity
    ): ResourceInboxCompletionNotifications.Subscription {
        const key = toResourceInboxCompletionKey(identity);
        const subscriptions = this.subscriptions.get(key) ?? new Set<ResourceInboxCompletionSubscription>();
        const subscription = new ResourceInboxCompletionSubscription(this.safetyTick, (closed) => {
            subscriptions.delete(closed);
            if (subscriptions.size === 0) {
                this.subscriptions.delete(key);
            }
        });
        subscriptions.add(subscription);
        this.subscriptions.set(key, subscriptions);
        return subscription;
    }

    /**
     * A completion committed here; an awaitable one with no local waiter may be awaited by another process, so it is
     * relayed. A duplicate request waiting on a second instance while a local waiter exists reads on its safety tick.
     */
    publish(
        key: ResourceInboxCompletionNotifications.Identity,
        awaitability: ResourceInboxCompletionNotifications.Awaitability
    ): void {
        if (!this.notifyLocal(key) && awaitability === 'awaitable') {
            this.relay?.(key);
        }
    }

    /** A completion another process committed and relayed; it wakes local waiters and is never relayed again. */
    acceptRelayed(key: ResourceInboxCompletionNotifications.Identity): void {
        this.notifyLocal(key);
    }

    private notifyLocal(key: ResourceInboxCompletionNotifications.Identity): boolean {
        const subscriptions = this.subscriptions.get(toResourceInboxCompletionKey(key));
        for (const subscription of subscriptions ?? []) {
            subscription.notify();
        }
        return subscriptions !== undefined;
    }
}

/**
 * One timer for every pending wait of the instance, so their safety re-reads land in one turn and can share one read.
 * It runs only while a wait is parked on it; a wait that must end before the next tick keeps its own timer.
 */
class ResourceInboxSafetyTick {
    private readonly timers: Timers;
    private readonly parked = new Set<(end: ResourceInboxSafetyTickEnd) => void>();
    private round: ResourceInboxSafetyTickRound | undefined;

    constructor(timers: Timers) {
        this.timers = timers;
    }

    /** Runs `settle` once, at the tick when it is due within `delayMs`, otherwise after `delayMs`; answers its cancel. */
    schedule(settle: (end: ResourceInboxSafetyTickEnd) => void, delayMs: number): () => void {
        const nowMs = this.timers.nowMs();
        const dueInMs = this.round === undefined
            ? RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS
            : this.round.dueAtMs - nowMs;
        if (delayMs < dueInMs) {
            return this.timers.schedule(() => settle('delay'), delayMs);
        }
        this.parked.add(settle);
        try {
            if (this.round === undefined) {
                this.startRound(nowMs);
            }
        }
        catch (error) {
            this.unpark(settle);
            throw error;
        }
        return () => this.unpark(settle);
    }

    private startRound(nowMs: number): void {
        const round: ResourceInboxSafetyTickRound = {
            dueAtMs: nowMs + RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS,
            cancel: undefined
        };
        this.round = round;
        round.cancel = this.timers.schedule(() => this.runRound(round), RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS);
        if (this.round !== round) {
            cancelQuietly(round.cancel);
        }
    }

    private runRound(round: ResourceInboxSafetyTickRound): void {
        if (this.round !== round) {
            return;
        }
        this.round = undefined;
        const settles = [...this.parked];
        this.parked.clear();
        settles.forEach((settle) => settle('tick'));
    }

    private unpark(settle: (end: ResourceInboxSafetyTickEnd) => void): void {
        const round = this.round;
        if (!this.parked.delete(settle) || this.parked.size > 0 || round === undefined) {
            return;
        }
        this.round = undefined;
        if (round.cancel !== undefined) {
            cancelQuietly(round.cancel);
        }
    }
}

class ResourceInboxCompletionSubscription implements ResourceInboxCompletionNotifications.Subscription {
    private readonly safetyTick: ResourceInboxSafetyTick;
    private readonly unsubscribe: (subscription: ResourceInboxCompletionSubscription) => void;
    private generation = 0;
    private readGeneration = 0;
    private pending: ResourceInboxCompletionWait | undefined;
    private closed = false;

    constructor(
        safetyTick: ResourceInboxSafetyTick,
        unsubscribe: (subscription: ResourceInboxCompletionSubscription) => void
    ) {
        this.safetyTick = safetyTick;
        this.unsubscribe = unsubscribe;
    }

    beginRead(): void {
        this.readGeneration = this.generation;
    }

    wait(delayMsecs: number): Promise<ResourceInboxCompletionNotifications.WakeReason> {
        if (this.closed || this.generation !== this.readGeneration) {
            this.readGeneration = this.generation;
            return Promise.resolve(this.closed ? 'closed' : 'completion');
        }
        return new Promise<ResourceInboxCompletionNotifications.WakeReason>((resolve) => {
            const pending: ResourceInboxCompletionWait = { resolve, cancel: undefined };
            this.pending = pending;
            try {
                pending.cancel = this.safetyTick.schedule((end) => this.settle(end, pending), delayMsecs);
            }
            catch (error) {
                if (this.pending === pending) {
                    this.pending = undefined;
                }
                throw error;
            }
            if (this.pending !== pending) {
                cancelQuietly(pending.cancel);
            }
            else if (this.closed) {
                this.settle('closed', pending);
            }
            else if (this.generation !== this.readGeneration) {
                this.settle('completion', pending);
            }
        });
    }

    notify(): void {
        if (this.closed) {
            return;
        }
        this.generation += 1;
        this.settle('completion');
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.settle('closed');
        this.unsubscribe(this);
    }

    private settle(
        reason: ResourceInboxCompletionNotifications.WakeReason,
        pending: ResourceInboxCompletionWait | undefined = this.pending
    ): void {
        if (pending === undefined || this.pending !== pending) {
            return;
        }
        this.pending = undefined;
        this.readGeneration = this.generation;
        if (pending.cancel !== undefined) {
            cancelQuietly(pending.cancel);
        }
        pending.resolve(reason);
    }
}

function cancelQuietly(cancel: () => void): void {
    try {
        cancel();
    }
    catch {
        // Failed cancellation leaves only a stale expiry; advisory completion still succeeds.
    }
}

/** The full identity of a completion as one string; distinct identities, separators included, never collide. */
export function toResourceInboxCompletionKey(identity: ResourceInboxCompletionNotifications.Identity): string {
    return JSON.stringify([
        identity.topicId,
        identity.resourceId,
        identity.contextId === undefined ? [] : [identity.contextId]
    ]);
}
