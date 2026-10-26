import { toError } from '../resilience/to-error.ts';
import type { Unsubscribe } from './RepositoryInterfaces.ts';

export namespace SynchronousNotifications {
    export type Listener<T> = (event: T) => void | Promise<void>;

    /** A captured batch, published synchronously at most once after its owner commits. */
    export interface Publication {
        publish(): void;
    }
}

/** Same-turn event and latest-state delivery with an isolated error-reporting boundary. */
export class SynchronousNotifications<T> {
    private readonly listeners = new Map<SynchronousNotifications.Listener<T>, number>();
    private registrationGeneration = 0;
    private publicationGeneration = 0;
    private readonly reportError: (error: Error) => void | Promise<void>;

    constructor(reportError: (error: Error) => void | Promise<void>) {
        this.reportError = reportError;
    }

    get size(): number {
        return this.listeners.size;
    }

    clear(): void {
        ++this.publicationGeneration;
        this.listeners.clear();
    }

    subscribe(listener: SynchronousNotifications.Listener<T>): Unsubscribe {
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

    /** Renews registration before replay so an in-progress publication cannot deliver the same state again. */
    subscribeAndNotify(listener: SynchronousNotifications.Listener<T>, current: T): Unsubscribe {
        this.listeners.delete(listener);
        const subscription = this.subscribe(listener);
        this.notify(listener, current);
        return subscription;
    }

    /** Returns false when nested publication or clear supersedes this value, so owners can stop related delivery. */
    publishLatest(event: T): boolean {
        const publication = ++this.publicationGeneration;
        for (const [listener, registration] of [...this.listeners]) {
            if (this.publicationGeneration !== publication) {
                return false;
            }
            if (this.listeners.get(listener) === registration) {
                this.notify(listener, event);
            }
        }
        return this.publicationGeneration === publication;
    }

    capture(events: readonly T[]): SynchronousNotifications.Publication {
        const capturedEvents = [...events];
        const listeners = [...this.listeners.keys()];
        let published = false;
        return {
            publish: () => {
                if (published) {
                    return;
                }
                published = true;
                for (const event of capturedEvents) {
                    for (const listener of listeners) {
                        this.notify(listener, event);
                    }
                }
            }
        };
    }

    private notify(listener: SynchronousNotifications.Listener<T>, event: T): void {
        try {
            const result = listener(event);
            if (result !== undefined) {
                void Promise.resolve(result).catch((error) => this.report(error));
            }
        }
        catch (error) {
            this.report(error);
        }
    }

    private report(error: unknown): void {
        try {
            const result = this.reportError(toError(error));
            if (result !== undefined) {
                void Promise.resolve(result).catch(() => {});
            }
        }
        catch {
            // Reporting cannot interrupt delivery of an already committed change.
        }
    }
}
