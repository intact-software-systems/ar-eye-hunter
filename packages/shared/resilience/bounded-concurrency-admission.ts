export namespace BoundedConcurrencyAdmission {
    export interface Config {
        readonly maxConcurrent: number;
    }

    /** A preferred run takes a freed slot ahead of every waiting in-turn run. */
    export type Priority = 'preferred' | 'in-turn';

    export interface PromotableAdmission<T> {
        readonly result: Promise<T>;
        /**
         * Moves the run, while it still waits in turn, behind the preferred runs already waiting; once it waits
         * preferred or holds a slot, does nothing.
         */
        prefer(): void;
    }
}

/**
 * Admits runs with at most the bound in flight; a run keeps its slot until it settles. Waiting runs of one priority
 * are admitted in arrival order, and a waiting preferred run, whether it asked to be preferred or was promoted while
 * waiting in turn, goes before every waiting in-turn run. Nothing ages an in-turn run: while preferred runs keep
 * arriving faster than slots free, in-turn runs wait, so a caller that prefers or promotes runs must bound how many it
 * prefers at once.
 */
export class BoundedConcurrencyAdmission {
    private readonly maxConcurrent: number;
    private inFlight = 0;
    private readonly waiting: Readonly<Record<BoundedConcurrencyAdmission.Priority, Array<() => void>>> = {
        preferred: [],
        'in-turn': []
    };

    constructor(config: BoundedConcurrencyAdmission.Config) {
        if (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1) {
            throw new TypeError('Bounded concurrency admission requires a bound of at least one');
        }
        this.maxConcurrent = config.maxConcurrent;
    }

    async admit<T>(run: () => Promise<T>, priority: BoundedConcurrencyAdmission.Priority = 'in-turn'): Promise<T> {
        return await this.admitPromotable(run, priority).result;
    }

    admitPromotable<T>(
        run: () => Promise<T>,
        priority: BoundedConcurrencyAdmission.Priority
    ): BoundedConcurrencyAdmission.PromotableAdmission<T> {
        // The executor runs synchronously, so takeSlot is the resolving closure before anything can call it.
        let takeSlot = () => {};
        const admitted = new Promise<void>((resolve) => {
            takeSlot = () => {
                this.inFlight += 1;
                resolve();
            };
        });
        if (this.inFlight < this.maxConcurrent) {
            takeSlot();
        }
        else {
            this.waiting[priority].push(takeSlot);
        }
        return {
            result: admitted.then(() => this.runInSlot(run)),
            prefer: () => this.preferWaiting(takeSlot)
        };
    }

    private preferWaiting(takeSlot: () => void): void {
        const inTurn = this.waiting['in-turn'];
        const index = inTurn.indexOf(takeSlot);
        if (index >= 0) {
            inTurn.splice(index, 1);
            this.waiting.preferred.push(takeSlot);
        }
    }

    private async runInSlot<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        }
        finally {
            this.releaseSlot();
        }
    }

    private releaseSlot(): void {
        this.inFlight -= 1;
        (this.waiting.preferred.shift() ?? this.waiting['in-turn'].shift())?.();
    }
}
