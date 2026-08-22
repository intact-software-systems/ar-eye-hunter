import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { setOptionalString, toSearch } from '../routing/url-state-helpers.ts';

const LEGACY_MONITOR_ROUTE = 'experience=legacy&workspace=black-box-runner&tab=runs';

const LEGACY_MONITOR_ID_FIELDS = [
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

export function createLegacyMonitorHref(
    state: RecipeConsoleUrlState,
    sourceSearch = ''
): string {
    const source = new URLSearchParams(sourceSearch);
    const params = new URLSearchParams(LEGACY_MONITOR_ROUTE);
    const provider = source.get('provider')?.trim();
    if (provider && LEGACY_PROVIDER_VALUES.has(provider)) {
        params.set('provider', provider);
    }
    for (const field of LEGACY_MONITOR_ID_FIELDS) {
        setOptionalString(params, field, state[field]);
    }
    return `/${toSearch(params)}`;
}
