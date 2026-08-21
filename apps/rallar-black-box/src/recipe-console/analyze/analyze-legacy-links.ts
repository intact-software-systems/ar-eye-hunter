import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { setOptionalString, toSearch } from '../routing/url-state-helpers.ts';

const RUN_ID_FIELDS = [
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId'
] as const satisfies readonly (keyof RecipeConsoleUrlState)[];

const LEGACY_PROVIDER_VALUES = new Set([
    'simulated',
    'browser-rallar'
]);

export function createAnalyzeLegacyRunsHref(
    state: RecipeConsoleUrlState,
    sourceSearch = ''
): string {
    const params = legacyParams(
        'workspace=black-box-runner&tab=runs',
        sourceSearch
    );
    for (const field of RUN_ID_FIELDS) {
        setOptionalString(params, field, state[field]);
    }
    return `/${toSearch(params)}`;
}

export function createAnalyzeLegacySharedTestHref(
    sourceSearch = ''
): string {
    const params = legacyParams(
        'workspace=black-box-runner&tab=advanced&advancedSurface=shared-test',
        sourceSearch
    );
    return `/${toSearch(params)}`;
}

function legacyParams(route: string, sourceSearch: string): URLSearchParams {
    const params = new URLSearchParams(`experience=legacy&${route}`);
    const provider = new URLSearchParams(sourceSearch).get('provider')?.trim();
    if (provider && LEGACY_PROVIDER_VALUES.has(provider)) {
        params.set('provider', provider);
    }
    return params;
}
