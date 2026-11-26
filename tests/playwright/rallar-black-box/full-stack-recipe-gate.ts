import type { ScenarioRoots } from './create-scenario-roots.ts';
import {
    findControlResult,
    hasPassedCommandEvent,
    readControlRunUntil,
    type RecipeRun,
    type StartedRecipeRun
} from './full-stack-helpers.ts';

/** A command of a running recipe, after which the lane starts a recipe it holds back. */
export interface RecipeGate {
    readonly commandId: string;
    /** The run whose recipe holds the command: once it ended, the gate passes whatever the command did. */
    readonly gatingRun: StartedRecipeRun;
    /** The scenario the gating run is a root of, which reads its outcome once it ended. */
    readonly scenario: ScenarioRoots;
    readonly timeoutMs: number;
}

/**
 * Returns once the gate's command passed, or once the run that holds it ended and the scenario read its outcome, so a
 * failure that ended it is the scenario's before the held recipe starts; a gate that does neither within its timeout
 * fails before the held recipe starts.
 */
export async function waitForRecipeGate(run: RecipeRun, gate: RecipeGate): Promise<void> {
    const read = await readControlRunUntil(run, {
        timeoutMs: gate.timeoutMs,
        select: (snapshot) => ({
            passed: hasPassedCommandEvent(snapshot, gate.commandId),
            ended: findControlResult(snapshot, gate.gatingRun.commandId) !== undefined
        }),
        accept: ({ passed, ended }) => passed || ended
    });
    if (read.kind === 'timed-out') {
        throw new Error(`${gate.commandId}: the gate did not pass within ${gate.timeoutMs} ms.`);
    }
    if (!read.value.passed) {
        await gate.scenario.readOutcome(gate.gatingRun);
    }
}
