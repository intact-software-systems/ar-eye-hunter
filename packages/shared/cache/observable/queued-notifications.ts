import { toError } from '../../resilience/to-error.ts';
import type { Unsubscribe } from '../RepositoryInterfaces.ts';

export namespace QueuedNotifications {
    export type Listener<T> = (event: T) => void | Promise<void>;
    export type ErrorHandler<T> = (error: Error, event: T) => void | Promise<void>;
}

/** Captures each event's audience and awaits its observers before delivering the next event. */
export class QueuedNotifications<T extends { readonly type: string; }> {
    private readonly listenersByType = new Map<T['type'] | undefined, Map<QueuedNotifications.Listener<T>, number>>();
    private registrationGeneration = 0;
    private queue: Promise<void> = Promise.resolve();
    private readonly onObserverError: QueuedNotifications.ErrorHandler<T> | undefined;

    constructor(onObserverError?: QueuedNotifications.ErrorHandler<T>) {
        this.onObserverError = onObserverError;
    }

    /** A snapshot used by cache owners to check for new delivery after their refresh/entry work settles. */
    get completion(): Promise<void> {
        return this.queue;
    }

    subscribe(listener: QueuedNotifications.Listener<T>): Unsubscribe {
        return this.register(undefined, listener);
    }

    subscribeType(type: T['type'], listener: QueuedNotifications.Listener<T>): Unsubscribe {
        return this.register(type, listener);
    }

    publish(event: T): void {
        const listeners = [
            ...(this.listenersByType.get(event.type)?.keys() ?? []),
            ...(this.listenersByType.get(undefined)?.keys() ?? [])
        ];
        if (listeners.length === 0) {
            return;
        }
        this.queue = this.queue.then(async () => {
            await Promise.all(listeners.map((listener) => this.notify(listener, event)));
        });
    }

    async whenIdle(): Promise<void> {
        let pending: Promise<void>;
        do {
            pending = this.queue;
            await pending;
        }
        while (pending !== this.queue);
    }

    private register(type: T['type'] | undefined, listener: QueuedNotifications.Listener<T>): Unsubscribe {
        let listeners = this.listenersByType.get(type);
        if (!listeners) {
            listeners = new Map();
            this.listenersByType.set(type, listeners);
        }
        const registration = listeners.get(listener) ?? ++this.registrationGeneration;
        listeners.set(listener, registration);
        return {
            unsubscribe: () => {
                if (listeners.get(listener) === registration) {
                    listeners.delete(listener);
                    if (listeners.size === 0) {
                        this.listenersByType.delete(type);
                    }
                }
            }
        };
    }

    private async notify(listener: QueuedNotifications.Listener<T>, event: T): Promise<void> {
        try {
            await listener(event);
        }
        catch (error) {
            try {
                const normalized = toError(error);
                if (this.onObserverError) {
                    await this.onObserverError(normalized, event);
                }
                else {
                    console.error('Error notifying queued observer', normalized);
                }
            }
            catch (reportError) {
                try {
                    console.error('Error reporting queued observer failure', toError(reportError));
                }
                catch {
                    // Diagnostics cannot reject delivery of an already committed event.
                }
            }
        }
    }
}
