import { toError } from '../resilience/to-error.ts';

import type { Unsubscribe } from './RepositoryInterfaces.ts';

export namespace SynchronousNotifications {
    /** A captured batch, published synchronously at most once after its owner commits. */
    export interface Publication {
        publish(): void;
    }
}

/** Same-turn event delivery with listener snapshots and an isolated error-reporting boundary. */
export class SynchronousNotifications<T> {
    private readonly listeners = new Set<(event: T) => void | Promise<void>>();
    private readonly reportError: (error: Error) => void | Promise<void>;

    constructor(reportError: (error: Error) => void | Promise<void>) {
        this.reportError = reportError;
    }

    subscribe(listener: (event: T) => void | Promise<void>): Unsubscribe {
        this.listeners.add(listener);
        return { unsubscribe: () => this.listeners.delete(listener) };
    }

    capture(events: readonly T[]): SynchronousNotifications.Publication {
        const capturedEvents = [...events];
        const listeners = [...this.listeners];
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

    private notify(listener: (event: T) => void | Promise<void>, event: T): void {
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
