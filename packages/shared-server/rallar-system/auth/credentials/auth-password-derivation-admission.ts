export namespace AuthPasswordDerivationAdmission {
    export interface Config {
        readonly maxConcurrentDerivations: number;
    }
}

export class AuthPasswordDerivationAdmission {
    private readonly maxConcurrentDerivations: number;
    private inFlightDerivations = 0;
    private readonly waitingDerivations: Array<() => void> = [];

    constructor(config: AuthPasswordDerivationAdmission.Config) {
        if (!Number.isInteger(config.maxConcurrentDerivations) || config.maxConcurrentDerivations < 1) {
            throw new TypeError('Auth password derivation admission requires a bound of at least one');
        }
        this.maxConcurrentDerivations = config.maxConcurrentDerivations;
    }

    async admit<T>(derive: () => Promise<T>): Promise<T> {
        await this.waitForSlot();
        try {
            return await derive();
        }
        finally {
            this.releaseSlot();
        }
    }

    private waitForSlot(): Promise<void> {
        if (this.inFlightDerivations < this.maxConcurrentDerivations) {
            this.inFlightDerivations += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.waitingDerivations.push(() => {
                this.inFlightDerivations += 1;
                resolve();
            });
        });
    }

    private releaseSlot(): void {
        this.inFlightDerivations -= 1;
        this.waitingDerivations.shift()?.();
    }
}
