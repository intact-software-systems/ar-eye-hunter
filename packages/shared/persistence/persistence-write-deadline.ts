/** Execution eligibility is separate from the retention timestamps on stored facts. */
export interface PersistenceWriteDeadline {
    readonly expiresAtMs: number;
    readonly nowMs: () => number;
}

export class PersistenceWriteExpiredError extends Error {
    constructor() {
        super('Persistence execution deadline elapsed');
        this.name = 'PersistenceWriteExpiredError';
    }
}

export function requireLivePersistenceWrite(expiresAtMs: number | null, nowMs: number): void {
    if (expiresAtMs !== null && expiresAtMs <= nowMs) {
        throw new PersistenceWriteExpiredError();
    }
}
