import {
    RECIPE_CONSOLE_URL_STRING_MAX_BYTES,
    type RecipeConsoleUrlState,
} from '../routing/url-state-contract.ts';
import { isRecipeConsoleUrlString } from '../routing/url-state-helpers.ts';

export const ANALYZE_SEARCH_ERROR_ID = 'analyze-search-form-error';

export type AnalyzeSearchFormError = Readonly<{
    field: 'historyQuery' | 'agentId' | 'recipeId' | 'commandId';
    message: string;
}>;

export type AnalyzeSearchFormResult =
    | Readonly<{
        ok: true;
        patch: Pick<RecipeConsoleUrlState,
            'historyQuery' | 'agentId' | 'recipeId' | 'commandId'>;
    }>
    | Readonly<{ ok: false; error: AnalyzeSearchFormError }>;

export function readAnalyzeSearchForm(data: FormData): AnalyzeSearchFormResult {
    const patch = {
        historyQuery: value(data, 'query'),
        agentId: value(data, 'agentId'),
        recipeId: value(data, 'recipeId'),
        commandId: value(data, 'commandId'),
    };
    const fields = [
        ['historyQuery', 'Search evidence'],
        ['agentId', 'Agent'],
        ['recipeId', 'Recipe'],
        ['commandId', 'Command'],
    ] as const;
    for (const [field, label] of fields) {
        const submitted = patch[field];
        if (submitted !== undefined && !isRecipeConsoleUrlString(submitted)) {
            return {
                ok: false,
                error: {
                    field,
                    message: `${label} exceeds the ${RECIPE_CONSOLE_URL_STRING_MAX_BYTES}-byte limit. The prior evidence remains unchanged.`,
                },
            };
        }
    }
    return { ok: true, patch };
}

function value(data: FormData, name: string): string | undefined {
    const entry = data.get(name);
    if (typeof entry !== 'string') return undefined;
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
