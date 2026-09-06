/**
 * A one-shot rendezvous for parallel groups.
 *
 * `runBoundedParallel` starts workers as slots free, so a "race" recipe can
 * have its first group finish before its last one starts — which asserts a
 * timing coincidence rather than a race. A rendezvous makes every group arrive
 * before any is released, so the contention the recipe claims to test is the
 * contention that actually happens.
 *
 * The participant count must be the number of workers that will actually run,
 * not the number of items: a count higher than that releases nobody and the
 * step hangs instead of failing.
 */
export interface ParallelRendezvous {
    /** Resolves once every participant has arrived. */
    arrive(): Promise<void>;
}

export function createParallelRendezvous(participantCount: number): ParallelRendezvous {
    if (participantCount <= 1) {
        return { arrive: () => Promise.resolve() };
    }

    const waiting: Array<() => void> = [];

    return {
        arrive: () => {
            const arrival = new Promise<void>((resolve) => {
                waiting.push(resolve);
            });

            if (waiting.length >= participantCount) {
                waiting.splice(0).forEach((resolve) => resolve());
            }

            return arrival;
        }
    };
}
