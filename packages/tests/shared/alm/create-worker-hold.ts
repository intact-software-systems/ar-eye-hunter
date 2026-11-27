export interface WorkerHold {
    readonly arrived: Promise<void>;
    arrive(): Promise<void>;
    release(): void;
}

/**
 * A hold any worker arrives at: `arrive()` resolves `arrived` and waits until `release()`, so a test can act while the
 * worker that arrived waits there.
 */
export function createWorkerHold(): WorkerHold {
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    return {
        arrived: arrived.promise,
        arrive: async () => {
            arrived.resolve();
            await released.promise;
        },
        release: () => released.resolve()
    };
}
