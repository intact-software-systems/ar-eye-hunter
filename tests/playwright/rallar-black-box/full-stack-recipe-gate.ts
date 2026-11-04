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
    readonly timeoutMs: number;
}

/**
 * Returns once the gate's command passed, or at once when the run that holds it already ended, so the held recipe
 * then starts; a gate that does neither within its timeout fails before the held recipe starts.
 */
export async function waitForRecipeGate(run: RecipeRun, gate: RecipeGate): Promise<void> {
    const read = await readControlRunUntil(run, {
        timeoutMs: gate.timeoutMs,
        select: (snapshot) =>
            hasPassedCommandEvent(snapshot, gate.commandId) ||
            findControlResult(snapshot, gate.gatingRun.commandId) !== undefined,
        accept: (passed) => passed
    });
    if (read.kind === 'accepted') {
        return;
    }
    throw new Error(`${gate.commandId}: the gate did not pass within ${gate.timeoutMs} ms.`);
}
