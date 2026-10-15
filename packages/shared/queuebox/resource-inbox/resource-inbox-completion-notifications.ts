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
}

interface ResourceInboxCompletionWait {
    readonly resolve: () => void;
    cancel: (() => void) | undefined;
}

export class ResourceInboxCompletionNotifications {
    private readonly subscriptions = new Map<string, Set<ResourceInboxCompletionSubscription>>();
    private readonly timers: Timers;

    constructor(timers: Timers) {
        this.timers = timers;
    }

    static createDefault(): ResourceInboxCompletionNotifications {
        return new ResourceInboxCompletionNotifications(createDefaultTimers());
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

    publish(key: ResourceInboxCompletionNotifications.Identity): void {
        for (const subscription of this.subscriptions.get(toCompletionKey(key)) ?? []) {
            subscription.notify();
        }
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
