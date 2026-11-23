import type { WorkerHold } from './postgres-worker-hold.ts';

export interface PastHeldCommitRace<Held, Raced> {
    readonly hold: WorkerHold;
    /** Starts the operation whose commit `hold` keeps open; it must reach the hold before it settles. */
    readonly startHeld: () => Promise<Held>;
    /** Starts the operation that runs while the held one is written but uncommitted. */
    readonly startRaced: () => Promise<Raced>;
    /** Far longer than the raced operation takes uncontended: still running after it, it is waiting on a lock. */
    readonly blockedAfterMs: number;
}

export interface PastHeldCommitOutcome<Held, Raced> {
    /** `finished` when the raced operation settled while the held one was still uncommitted. */
    readonly raced: 'finished' | 'blocked';
    readonly heldResult: Held;
    readonly racedResult: Raced;
}

/**
 * Starts the held operation and waits until its write has run, then races the second operation against a timeout,
 * releases the hold and awaits both, so neither can commit after the test has cleaned up. A held operation that
 * fails or settles before it reaches the hold fails the race instead of waiting for the test's timeout.
 */
export async function racePastHeldCommit<Held, Raced>(
    race: PastHeldCommitRace<Held, Raced>
): Promise<PastHeldCommitOutcome<Held, Raced>> {
    const held = race.startHeld();
    let raced: Promise<Raced> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await awaitHoldArrival(race.hold, held);
        raced = race.startRaced();
        const blocked = new Promise<'blocked'>((resolve) => {
            timer = setTimeout(() => resolve('blocked'), race.blockedAfterMs);
        });
        const outcome = await Promise.race([raced.then(() => 'finished' as const), blocked]);
        race.hold.release();
        return { raced: outcome, heldResult: await held, racedResult: await raced };
    }
    finally {
        clearTimeout(timer);
        race.hold.release();
        await Promise.allSettled([held, raced]);
    }
}

/** Waits until `held` reaches `hold`; a held operation that fails or settles first fails the wait at once. */
export async function awaitHoldArrival(hold: WorkerHold, held: Promise<unknown>): Promise<void> {
    await Promise.race([
        hold.arrived,
        held.then(() => Promise.reject(new Error('The held operation settled before it reached its hold')))
    ]);
}
