export namespace BoundedConcurrencyAdmission {
    export interface Config {
        readonly maxConcurrent: number;
    }

    /** A preferred run takes a freed slot ahead of every waiting in-turn run. */
    export type Priority = 'preferred' | 'in-turn';
}

/**
 * Admits runs with at most the bound in flight; a run keeps its slot until it settles. Waiting runs of one priority
 * are admitted in arrival order, and a waiting preferred run goes before every waiting in-turn run. Nothing ages an
 * in-turn run: while preferred runs keep arriving faster than slots free, in-turn runs wait, so a caller that prefers
 * runs bounds their supply.
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
        await this.waitForSlot(priority);
        try {
            return await run();
        }
        finally {
            this.releaseSlot();
        }
    }

    private waitForSlot(priority: BoundedConcurrencyAdmission.Priority): Promise<void> {
        if (this.inFlight < this.maxConcurrent) {
            this.inFlight += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.waiting[priority].push(() => {
                this.inFlight += 1;
                resolve();
            });
        });
    }

    private releaseSlot(): void {
        this.inFlight -= 1;
        (this.waiting.preferred.shift() ?? this.waiting['in-turn'].shift())?.();
    }
}
