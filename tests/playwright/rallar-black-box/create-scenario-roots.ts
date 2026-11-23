import type { RecipeRunOutcome, StartedRecipeRun } from './full-stack-helpers.ts';

/**
 * The roots of one scenario, whose roles run side by side and wait for one another: once one role's recipe failed, the
 * waits of the others are for steps that cannot come.
 */
export interface ScenarioRoots {
    /**
     * Reads a root's outcome. One that ends not ok cancels every other root of the scenario still running; a root read
     * after that is cancelled at once unless its read finds its result.
     */
    readonly readOutcome: (root: StartedRecipeRun) => Promise<RecipeRunOutcome>;
    /** The first root of the scenario that ended not ok; undefined while none did. */
    readonly getFailure: () => RecipeRunOutcome | undefined;
}

export function createScenarioRoots(): ScenarioRoots {
    const roots = new Set<StartedRecipeRun>();
    let failure: RecipeRunOutcome | undefined;
    return {
        readOutcome: async (root) => {
            roots.add(root);
            if (failure !== undefined) {
                root.cancelAfter(failure);
            }
            const outcome = await root.readOutcome();
            if (!outcome.ok) {
                failure ??= outcome;
                for (const peer of roots) {
                    if (peer !== root) {
                        peer.cancelAfter(failure);
                    }
                }
            }
            return outcome;
        },
        getFailure: () => failure
    };
}
