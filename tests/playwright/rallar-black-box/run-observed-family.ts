import type { TestInfo } from '@playwright/test';

import { toError } from '@shared/resilience/to-error.ts';

import type { ALMObservationCellOutcome } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/observation/compute-alm-observation-regime.ts';
import type { StartedRecipeRun } from './full-stack-helpers.ts';
import { readStartedRecipeRunOutcomes } from './read-started-recipe-run-outcomes.ts';

export interface RunObservedFamilyInput {
    /** The run the body started its roots on; a copy of it shares `startedRoots` with it. */
    readonly run: Readonly<{ close(): Promise<void>; startedRoots: readonly StartedRecipeRun[]; }>;
    readonly testInfo: Pick<TestInfo, 'errors'>;
    /** Runs the family's cells. */
    readonly body: () => Promise<void>;
    /**
     * Records the family's observation; it reads the run's pages, so it runs while they are open. Today's only caller
     * never throws (the observation is a non-blocking diagnostic), so the failing-observation outcomes are for any
     * `observe` that does.
     */
    readonly observe: (cellOutcome: ALMObservationCellOutcome) => Promise<void>;
}

/**
 * The order of every family's run, stated once: the body; the end of the roots the body started, so no page is read
 * while a root still runs on it; the observation, which needs the live pages; the close. Each step runs whatever the
 * ones before it did. The test reports the body's failure, else the first of the others: an observation that fails
 * never hides the scenario's failure. The wait for the roots ends by the roots' own deadline plus grace, not by the
 * test's remaining time: a late body failure can still end as a Playwright timeout without an observation, and
 * bounding it by the remaining time would leave none for the observation and the close.
 */
export async function runObservedFamily(input: RunObservedFamilyInput): Promise<void> {
    const body = await captureFailure(input.body);
    const roots = await captureFailure(() => readStartedRecipeRunOutcomes(input.run.startedRoots));
    const observation = await captureFailure(() => input.observe(toCellOutcome(input.testInfo, body.length > 0)));
    const close = await captureFailure(() => input.run.close());
    const failures = [...body, ...roots, ...observation, ...close];
    if (failures.length > 1) {
        console.warn('A family run failed in more than one step; the first failure is reported.', {
            unreported: failures.slice(1)
        });
    }
    if (failures.length > 0) {
        throw failures[0];
    }
}

/** The failure of the work as a list of at most one, so a thrown `undefined` is still a failure. */
async function captureFailure(work: () => Promise<void>): Promise<readonly Error[]> {
    try {
        await work();
        return [];
    }
    catch (failure) {
        return [toError(failure)];
    }
}

/** Soft assertions record their failures on `testInfo` the moment they fire, before the cell ends. */
function toCellOutcome(testInfo: Pick<TestInfo, 'errors'>, bodyFailed: boolean): ALMObservationCellOutcome {
    return bodyFailed || testInfo.errors.length > 0 ? 'failed' : 'passed';
}
