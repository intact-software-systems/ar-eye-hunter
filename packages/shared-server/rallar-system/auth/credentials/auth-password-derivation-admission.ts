import { BoundedConcurrencyAdmission } from '@shared/resilience/bounded-concurrency-admission.ts';

export namespace AuthPasswordDerivationAdmission {
    export interface Config {
        readonly maxConcurrentDerivations: number;
    }
}

/** PBKDF2 derivations run off the main thread, but too many at once starve the API's single JS thread. */
export class AuthPasswordDerivationAdmission {
    private readonly admission: BoundedConcurrencyAdmission;

    constructor(config: AuthPasswordDerivationAdmission.Config) {
        this.admission = new BoundedConcurrencyAdmission({ maxConcurrent: config.maxConcurrentDerivations });
    }

    async admit<T>(derive: () => Promise<T>): Promise<T> {
        return await this.admission.admit(derive);
    }
}
