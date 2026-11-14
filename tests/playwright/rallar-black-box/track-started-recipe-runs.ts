import type { StartedRecipeRun } from './full-stack-helpers.ts';

const STARTED_RUNS_BY_RUN = new WeakMap<WeakKey, StartedRecipeRun[]>();

/** Remembers a started root against its run, so the family's owner can wait for the roots a failed body left. */
export function trackStartedRecipeRun(run: WeakKey, started: StartedRecipeRun): void {
    STARTED_RUNS_BY_RUN.set(run, [...STARTED_RUNS_BY_RUN.get(run) ?? [], started]);
}

/**
 * Waits for the outcome of every root the run started. Each root's outcome is read once, within the deadline it
 * captured when it started, so a root read already answers at once and one nobody read ends or is cancelled by its
 * own deadline. Rejects with the first root that stays live after its cancellation, once every root settled.
 */
export async function readStartedRecipeRunOutcomes(run: WeakKey): Promise<void> {
    const settled = await Promise.allSettled(
        (STARTED_RUNS_BY_RUN.get(run) ?? []).map((started) => started.readOutcome())
    );
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected !== undefined) {
        throw rejected.reason;
    }
}
