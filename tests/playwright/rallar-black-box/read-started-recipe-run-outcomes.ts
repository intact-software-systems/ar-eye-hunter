import type { StartedRecipeRun } from './full-stack-helpers.ts';

/**
 * Waits for the outcome of every started root. Each root's outcome is read once, within the deadline it captured when
 * it started, so a root read already answers at once and one nobody read ends or is cancelled by its own deadline.
 * Rejects with the first root that stays live after its cancellation, once every root settled.
 */
export async function readStartedRecipeRunOutcomes(startedRoots: readonly StartedRecipeRun[]): Promise<void> {
    const settled = await Promise.allSettled(startedRoots.map((started) => started.readOutcome()));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected !== undefined) {
        throw rejected.reason;
    }
}
