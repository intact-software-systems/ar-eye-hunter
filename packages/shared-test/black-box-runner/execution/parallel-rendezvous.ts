/**
 * A one-shot rendezvous for parallel groups.
 *
 * `runBoundedParallel` starts workers as slots free, so a "race" recipe can
 * have its first group finish before its last one starts — which asserts a
 * timing coincidence rather than a race. A rendezvous makes every group arrive
 * before any is released, so the contention the recipe claims to test is the
 * contention that actually happens.
 */
export interface ParallelRendezvous {
    /** Resolves once every participant has arrived. */
    arrive(): Promise<void>;
}

export function createParallelRendezvous(participantCount: number): ParallelRendezvous {
    if (participantCount <= 1) {
        return { arrive: () => Promise.resolve() };
    }

    let arrived = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });

    return {
        arrive: () => {
            arrived += 1;
            if (arrived >= participantCount) {
                release();
            }

            return released;
        }
    };
}
