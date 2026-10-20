export interface WorkerHold {
    readonly arrived: Promise<void>;
    arrive(): Promise<void>;
    release(): void;
}

/** Holds one AppInbox worker after its read and compute, just before its mutation transaction opens. */
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
