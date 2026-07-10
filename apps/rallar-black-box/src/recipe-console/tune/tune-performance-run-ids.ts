import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export function tunePerformanceRunIds(
    state: RecipeConsoleUrlState,
): readonly string[] {
    const ids = new Set<string>();
    if (state.compareLeft) ids.add(state.compareLeft);
    const focus = state.compareRight ?? state.distributedRunId;
    if (focus) ids.add(focus);
    return [...ids].slice(0, 2);
}
