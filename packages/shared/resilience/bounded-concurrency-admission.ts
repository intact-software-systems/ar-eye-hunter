export namespace BoundedConcurrencyAdmission {
    export interface Config {
        readonly maxConcurrent: number;
    }
}

/** Admits runs in arrival order with at most the bound in flight; a run keeps its slot until it settles. */
export class BoundedConcurrencyAdmission {
    private readonly maxConcurrent: number;
    private inFlight = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(config: BoundedConcurrencyAdmission.Config) {
        if (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1) {
            throw new TypeError('Bounded concurrency admission requires a bound of at least one');
        }
        this.maxConcurrent = config.maxConcurrent;
    }

    async admit<T>(run: () => Promise<T>): Promise<T> {
        await this.waitForSlot();
        try {
            return await run();
        }
        finally {
            this.releaseSlot();
        }
    }

    private waitForSlot(): Promise<void> {
        if (this.inFlight < this.maxConcurrent) {
            this.inFlight += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.waiting.push(() => {
                this.inFlight += 1;
                resolve();
            });
        });
    }

    private releaseSlot(): void {
        this.inFlight -= 1;
        this.waiting.shift()?.();
    }
}
