import { toError } from '../resilience/to-error.ts';
import type { Unsubscribe } from './RepositoryInterfaces.ts';

export namespace AsyncNotifications {
    export type Listener<T> = (event: T) => void | Promise<void>;
    export type ErrorReporter = (error: Error) => void | Promise<void>;
}

/** Awaited delivery: sequential publication uses the live audience; concurrent publication captures it. */
export class AsyncNotifications<T> {
    private readonly listeners = new Map<AsyncNotifications.Listener<T>, number>();

    private registrationGeneration = 0;

    get size(): number {
        return this.listeners.size;
    }

    subscribe(listener: AsyncNotifications.Listener<T>): Unsubscribe {
        const registration = this.listeners.get(listener) ?? ++this.registrationGeneration;
        this.listeners.set(listener, registration);
        return {
            unsubscribe: () => {
                if (this.listeners.get(listener) === registration) {
                    this.listeners.delete(listener);
                }
            }
        };
    }

    getListeners(): Iterable<AsyncNotifications.Listener<T>> {
        return this.listeners.keys();
    }

    /** A failure rejects publication before later listeners run. */
    async publishSequential(event: T): Promise<void> {
        for (const listener of this.listeners.keys()) {
            await listener(event);
        }
    }

    async publishConcurrent(event: T, reportError: AsyncNotifications.ErrorReporter): Promise<void> {
        await notifyConcurrentListeners(this.listeners.keys(), event, reportError);
    }
}

/** Captures the selected audience, starts all observers, and isolates observer/reporting failures. */
export async function notifyConcurrentListeners<T>(
    listeners: Iterable<AsyncNotifications.Listener<T>>,
    event: T,
    reportError: AsyncNotifications.ErrorReporter
): Promise<void> {
    await Promise.all([...listeners].map(async (listener) => {
        try {
            await listener(event);
        }
        catch (error) {
            try {
                await reportError(toError(error));
            }
            catch {
                // A diagnostic failure cannot interrupt another observer or reject a delivered event.
            }
        }
    }));
}
