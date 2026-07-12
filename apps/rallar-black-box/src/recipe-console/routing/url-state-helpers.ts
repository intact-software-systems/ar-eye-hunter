import {
    RECIPE_CONSOLE_FLEET_MAP_LAYERS,
    RECIPE_CONSOLE_NON_SHAREABLE_URL_KEYS,
    RECIPE_CONSOLE_SENSITIVE_URL_KEYS,
    type RecipeConsoleFleetMapLayer,
    type RecipeConsoleUrlIssue,
    type RecipeConsoleUrlState,
} from './url-state-contract.ts';

export const OPTIONAL_STRING_FIELDS = [
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId',
    'historyQuery',
    'compareLeft',
    'compareRight',
    'fleetRegion',
] as const satisfies readonly (keyof RecipeConsoleUrlState)[];

const SENSITIVE_KEYS = new Set(
    [
        ...RECIPE_CONSOLE_SENSITIVE_URL_KEYS,
        ...RECIPE_CONSOLE_NON_SHAREABLE_URL_KEYS,
    ].map(key => key.toLowerCase()),
);

export function toSearch(params: URLSearchParams): string {
    const value = params.toString();
    return value ? `?${value}` : '';
}

export function deleteSensitiveUrlKeys(params: URLSearchParams): void {
    for (const key of [...params.keys()]) {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
            params.delete(key);
        }
    }
}

function addIssue(
    issues: RecipeConsoleUrlIssue[],
    field: string,
    code: RecipeConsoleUrlIssue['code'],
    message: string,
    value?: string,
): void {
    issues.push({ field, code, value, message });
}

export function firstValue(
    params: URLSearchParams,
    field: string,
    issues: RecipeConsoleUrlIssue[],
): string | undefined {
    const values = params.getAll(field);
    for (const duplicate of values.slice(1)) {
        addIssue(
            issues,
            field,
            'duplicate',
            `Ignored a duplicate ${field} value.`,
            duplicate,
        );
    }
    return values[0];
}

export function requiredValue(
    params: URLSearchParams,
    field: string,
    issues: RecipeConsoleUrlIssue[],
): string | undefined {
    const value = firstValue(params, field, issues);
    if (value === undefined) {
        addIssue(
            issues,
            field,
            'missing',
            `${field} was missing and its Recipe Console default was used.`,
        );
    }
    return value;
}

export function readString(
    params: URLSearchParams,
    field: string,
    issues: RecipeConsoleUrlIssue[],
): string | undefined {
    const value = firstValue(params, field, issues);
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.trim();
    if (!normalized) {
        addIssue(issues, field, 'invalid', `${field} must not be empty.`, value);
        return undefined;
    }
    if (normalized !== value) {
        addIssue(issues, field, 'normalized', `${field} was trimmed.`, value);
    }
    return normalized;
}

export function readEnum<const Value extends string>(
    params: URLSearchParams,
    field: string,
    allowed: readonly Value[],
    issues: RecipeConsoleUrlIssue[],
): Value | undefined {
    const value = firstValue(params, field, issues);
    if (value === undefined) {
        return undefined;
    }
    if (!(allowed as readonly string[]).includes(value)) {
        addIssue(
            issues,
            field,
            'invalid',
            `${field} has an unsupported value.`,
            value,
        );
        return undefined;
    }
    return value as Value;
}

export function readEpoch(
    params: URLSearchParams,
    field: 'from' | 'to',
    issues: RecipeConsoleUrlIssue[],
): number | undefined {
    const value = firstValue(params, field, issues);
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.trim();
    const parsed = Number(normalized);
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < 0) {
        addIssue(
            issues,
            field,
            'invalid',
            `${field} must be a safe nonnegative integer epoch millisecond.`,
            value,
        );
        return undefined;
    }
    if (String(parsed) !== value) {
        addIssue(
            issues,
            field,
            'normalized',
            `${field} was normalized to canonical integer form.`,
            value,
        );
    }
    return parsed;
}

export function readFleetLayers(
    params: URLSearchParams,
    issues: RecipeConsoleUrlIssue[],
): readonly RecipeConsoleFleetMapLayer[] | undefined {
    const value = firstValue(params, 'fleetMapLayers', issues);
    if (value === undefined) {
        return undefined;
    }
    if (value === 'none') {
        return [];
    }
    const requested = value.split(',').map(entry => entry.trim());
    if (requested.some(entry => !(
        RECIPE_CONSOLE_FLEET_MAP_LAYERS as readonly string[]
    ).includes(entry))) {
        addIssue(
            issues,
            'fleetMapLayers',
            'invalid',
            'fleetMapLayers contains an unsupported layer.',
            value,
        );
        return [];
    }
    const selected = new Set(requested);
    const normalized = RECIPE_CONSOLE_FLEET_MAP_LAYERS.filter(
        layer => selected.has(layer),
    );
    if (normalized.join(',') !== value) {
        addIssue(
            issues,
            'fleetMapLayers',
            'normalized',
            'fleetMapLayers was deduplicated and placed in canonical order.',
            value,
        );
    }
    return normalized;
}

export function setOptionalString(
    params: URLSearchParams,
    field: typeof OPTIONAL_STRING_FIELDS[number] | 'legacySurface',
    value: unknown,
): void {
    if (typeof value === 'string' && value.trim()) {
        params.set(field, value.trim());
    }
}

export function safeEpoch(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}
