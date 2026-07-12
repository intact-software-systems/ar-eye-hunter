import {
    LEGACY_APP_URL_ALIAS_KEYS,
    RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES,
    RECIPE_CONSOLE_FAILURE_CATEGORIES,
    RECIPE_CONSOLE_FLEET_MAP_LAYERS,
    RECIPE_CONSOLE_OWNED_URL_KEYS,
    RECIPE_CONSOLE_RUN_STATUSES,
    RECIPE_CONSOLE_TIMING_METRICS,
    RECIPE_CONSOLE_TRANSPORTS,
    RECIPE_CONSOLE_URL_VERSION,
    RECIPE_CONSOLE_VIEWS,
    type ParsedRecipeConsoleUrl,
    type RecipeConsoleUrlIssue,
    type RecipeConsoleUrlState,
} from './url-state-contract.ts';
import {
    OPTIONAL_STRING_FIELDS,
    deleteSensitiveUrlKeys,
    readEnum,
    readEpoch,
    readFleetLayers,
    readString,
    requiredValue,
    safeEpoch,
    setOptionalString,
    toSearch,
} from './url-state-helpers.ts';

type MutableState = {
    -readonly [Key in keyof RecipeConsoleUrlState]: RecipeConsoleUrlState[Key];
};

export function serializeRecipeConsoleUrl(
    state: RecipeConsoleUrlState,
    baseSearch = '',
): string {
    const params = new URLSearchParams(baseSearch);
    deleteSensitiveUrlKeys(params);
    for (const key of RECIPE_CONSOLE_OWNED_URL_KEYS) {
        params.delete(key);
    }
    for (const key of LEGACY_APP_URL_ALIAS_KEYS) {
        params.delete(key);
    }

    params.set('v', String(RECIPE_CONSOLE_URL_VERSION));
    params.set('experience', 'recipe-console');
    params.set(
        'view',
        (RECIPE_CONSOLE_VIEWS as readonly string[]).includes(state.view)
            ? state.view
            : 'execute',
    );
    for (const field of OPTIONAL_STRING_FIELDS) {
        setOptionalString(params, field, state[field]);
    }
    if (state.diagnosticSeverity && RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES.includes(state.diagnosticSeverity)) {
        params.set('diagnosticSeverity', state.diagnosticSeverity);
    }
    if (state.transport && RECIPE_CONSOLE_TRANSPORTS.includes(state.transport)) {
        params.set('transport', state.transport);
    }
    if (state.status && RECIPE_CONSOLE_RUN_STATUSES.includes(state.status)) {
        params.set('status', state.status);
    }
    if (
        state.failureCategory &&
        RECIPE_CONSOLE_FAILURE_CATEGORIES.includes(state.failureCategory)
    ) {
        params.set('failureCategory', state.failureCategory);
    }
    if (state.timingMetric && RECIPE_CONSOLE_TIMING_METRICS.includes(state.timingMetric)) {
        params.set('timingMetric', state.timingMetric);
    }

    let from = safeEpoch(state.from);
    let to = safeEpoch(state.to);
    if (from !== undefined && to !== undefined && from > to) {
        [from, to] = [to, from];
    }
    if (from !== undefined) {
        params.set('from', String(from));
    }
    if (to !== undefined) {
        params.set('to', String(to));
    }

    if (state.fleetMapLayers) {
        const selected = new Set(state.fleetMapLayers);
        const layers = RECIPE_CONSOLE_FLEET_MAP_LAYERS.filter(layer => selected.has(layer));
        params.set('fleetMapLayers', layers.length > 0 ? layers.join(',') : 'none');
    }
    if (state.view === 'advanced') {
        setOptionalString(params, 'legacySurface', state.legacySurface);
    }
    return toSearch(params);
}

export function parseRecipeConsoleUrl(search: string): ParsedRecipeConsoleUrl {
    const params = new URLSearchParams(search);
    deleteSensitiveUrlKeys(params);
    const issues: RecipeConsoleUrlIssue[] = [];
    const state: MutableState = {
        v: RECIPE_CONSOLE_URL_VERSION,
        experience: 'recipe-console',
        view: 'execute',
    };

    const version = requiredValue(params, 'v', issues);
    if (version !== undefined && version !== String(RECIPE_CONSOLE_URL_VERSION)) {
        issues.push({
            field: 'v',
            code: 'invalid',
            value: version,
            message: 'v is not a supported Recipe Console URL version.',
        });
    }
    const experience = requiredValue(params, 'experience', issues);
    if (experience !== undefined && experience !== 'recipe-console') {
        issues.push({
            field: 'experience',
            code: 'invalid',
            value: experience,
            message: 'experience must select recipe-console.',
        });
    }
    const view = requiredValue(params, 'view', issues);
    if (view !== undefined) {
        if ((RECIPE_CONSOLE_VIEWS as readonly string[]).includes(view)) {
            state.view = view as RecipeConsoleUrlState['view'];
        } else {
            issues.push({
                field: 'view',
                code: 'invalid',
                value: view,
                message: 'view is not a supported Recipe Console view.',
            });
        }
    }

    for (const field of OPTIONAL_STRING_FIELDS) {
        const value = readString(params, field, issues);
        if (value !== undefined) {
            (state as Record<string, unknown>)[field] = value;
        }
    }
    state.diagnosticSeverity = readEnum(
        params,
        'diagnosticSeverity',
        RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES,
        issues,
    );
    state.transport = readEnum(params, 'transport', RECIPE_CONSOLE_TRANSPORTS, issues);
    state.status = readEnum(params, 'status', RECIPE_CONSOLE_RUN_STATUSES, issues);
    state.failureCategory = readEnum(
        params,
        'failureCategory',
        RECIPE_CONSOLE_FAILURE_CATEGORIES,
        issues,
    );
    state.timingMetric = readEnum(
        params,
        'timingMetric',
        RECIPE_CONSOLE_TIMING_METRICS,
        issues,
    );
    state.from = readEpoch(params, 'from', issues);
    state.to = readEpoch(params, 'to', issues);
    if (state.from !== undefined && state.to !== undefined && state.from > state.to) {
        [state.from, state.to] = [state.to, state.from];
        issues.push({
            field: 'from,to',
            code: 'normalized',
            message: 'The reversed time range was placed in ascending order.',
        });
    }
    state.fleetMapLayers = readFleetLayers(params, issues);

    const legacySurface = readString(params, 'legacySurface', issues);
    if (legacySurface !== undefined) {
        if (state.view === 'advanced') {
            state.legacySurface = legacySurface;
        } else {
            issues.push({
                field: 'legacySurface',
                code: 'inapplicable',
                value: legacySurface,
                message: 'legacySurface applies only to the Advanced view.',
            });
        }
    }

    for (const key of Object.keys(state) as (keyof MutableState)[]) {
        if (state[key] === undefined) {
            delete state[key];
        }
    }
    const canonicalSearch = serializeRecipeConsoleUrl(state, toSearch(params));
    const inputSearch = toSearch(new URLSearchParams(search));
    return {
        state,
        issues,
        canonicalSearch,
        needsReplace: canonicalSearch !== inputSearch,
    };
}

export function scrubRecipeConsoleHash(hash: string): string {
    if (!hash) {
        return hash;
    }
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    deleteSensitiveUrlKeys(params);
    if (!hash.includes('=') && !hash.includes('&')) {
        return params.toString() ? hash : '';
    }
    const value = params.toString();
    return value ? `#${value}` : '';
}

export function createRecipeConsoleShareHref(
    location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>,
    state: RecipeConsoleUrlState,
): string {
    return `${location.origin}${location.pathname}${
        serializeRecipeConsoleUrl(state, location.search)
    }${scrubRecipeConsoleHash(location.hash)}`;
}
