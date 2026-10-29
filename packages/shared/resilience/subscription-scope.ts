import { toError } from './to-error.ts';

export namespace SubscriptionScope {
    export type Cleanup = () => void;
}

/** Owns idempotent teardown; additions to a closed scope are cleaned immediately. */
export class SubscriptionScope {
    private readonly cleanups = new Set<SubscriptionScope.Cleanup>();
    private closed = false;

    add(cleanup?: SubscriptionScope.Cleanup | null): this {
        if (cleanup) {
            if (this.closed) {
                cleanup();
            }
            else {
                this.cleanups.add(cleanup);
            }
        }
        return this;
    }

    unsubscribe(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const cleanups = [...this.cleanups];
        this.cleanups.clear();
        const failures: Error[] = [];
        for (const cleanup of cleanups) {
            try {
                cleanup();
            }
            catch (error) {
                failures.push(toError(error));
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, 'Subscription cleanup failed.');
        }
    }

    size(): number {
        return this.cleanups.size;
    }
}
