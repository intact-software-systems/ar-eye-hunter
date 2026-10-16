import { createDefaultTimers, type Timers } from '../../resilience/timers.ts';

export namespace ResourceInboxCompletionNotifications {
    export interface Identity {
        readonly topicId: string;
        readonly resourceId: string;
        readonly contextId: string | undefined;
    }

    export interface Subscription {
        beginRead(): void;
        wait(delayMsecs: number): Promise<void>;
        close(): void;
    }

    /** Carries a completion no waiter in this process observed to the other processes sharing the queue. */
    export type Relay = (identity: Identity) => void;

    /** Whether any caller can wait for the completion; a fire-and-forget one has no waiter in another process. */
    export type Awaitability = 'awaitable' | 'fire-and-forget';
}

interface ResourceInboxCompletionWait {
    readonly resolve: () => void;
    cancel: (() => void) | undefined;
}

export class ResourceInboxCompletionNotifications {
    private readonly subscriptions = new Map<string, Set<ResourceInboxCompletionSubscription>>();
    private readonly timers: Timers;
    private readonly relay: ResourceInboxCompletionNotifications.Relay | undefined;

    /** Without a relay the process is the queue's only reader, so every waiter it could wake is its own. */
    constructor(timers: Timers, relay?: ResourceInboxCompletionNotifications.Relay) {
        this.timers = timers;
        this.relay = relay;
    }

    static createDefault(relay?: ResourceInboxCompletionNotifications.Relay): ResourceInboxCompletionNotifications {
        return new ResourceInboxCompletionNotifications(createDefaultTimers(), relay);
    }

    subscribe(
        identity: ResourceInboxCompletionNotifications.Identity
    ): ResourceInboxCompletionNotifications.Subscription {
        const key = toCompletionKey(identity);
        const subscriptions = this.subscriptions.get(key) ?? new Set<ResourceInboxCompletionSubscription>();
        const subscription = new ResourceInboxCompletionSubscription(this.timers, (closed) => {
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
        const subscriptions = this.subscriptions.get(toCompletionKey(key));
        for (const subscription of subscriptions ?? []) {
            subscription.notify();
        }
        return subscriptions !== undefined;
    }
}

class ResourceInboxCompletionSubscription implements ResourceInboxCompletionNotifications.Subscription {
    private readonly timers: Timers;
    private readonly unsubscribe: (subscription: ResourceInboxCompletionSubscription) => void;
    private generation = 0;
    private readGeneration = 0;
    private pending: ResourceInboxCompletionWait | undefined;
    private closed = false;

    constructor(
        timers: Timers,
        unsubscribe: (subscription: ResourceInboxCompletionSubscription) => void
    ) {
        this.timers = timers;
        this.unsubscribe = unsubscribe;
    }

    beginRead(): void {
        this.readGeneration = this.generation;
    }

    wait(delayMsecs: number): Promise<void> {
        if (this.closed || this.generation !== this.readGeneration) {
            this.readGeneration = this.generation;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const pending: ResourceInboxCompletionWait = { resolve, cancel: undefined };
            this.pending = pending;
            try {
                pending.cancel = this.timers.schedule(() => this.settle(pending), delayMsecs);
            }
            catch (error) {
                if (this.pending === pending) {
                    this.pending = undefined;
                }
                throw error;
            }
            if (this.pending !== pending) {
                this.cancelTimer(pending.cancel);
            }
            else if (this.closed || this.generation !== this.readGeneration) {
                this.settle(pending);
            }
        });
    }

    notify(): void {
        if (this.closed) {
            return;
        }
        this.generation += 1;
        this.settle();
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.settle();
        this.unsubscribe(this);
    }

    private settle(pending: ResourceInboxCompletionWait | undefined = this.pending): void {
        if (pending === undefined || this.pending !== pending) {
            return;
        }
        this.pending = undefined;
        this.readGeneration = this.generation;
        if (pending.cancel !== undefined) {
            this.cancelTimer(pending.cancel);
        }
        pending.resolve();
    }

    private cancelTimer(cancel: () => void): void {
        try {
            cancel();
        }
        catch {
            // Failed cancellation leaves only a stale expiry; advisory completion still succeeds.
        }
    }
}

function toCompletionKey(identity: ResourceInboxCompletionNotifications.Identity): string {
    return JSON.stringify([
        identity.topicId,
        identity.resourceId,
        identity.contextId === undefined ? [] : [identity.contextId]
    ]);
}
