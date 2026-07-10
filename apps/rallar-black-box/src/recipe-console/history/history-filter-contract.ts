import {
    RECIPE_CONSOLE_FAILURE_CATEGORIES,
    RECIPE_CONSOLE_RUN_STATUSES,
    type RecipeConsoleFailureCategory,
    type RecipeConsoleRunStatus,
    type RecipeConsoleUrlState,
} from '../routing/url-state-contract.ts';

export const HISTORY_FILTER_PRESET_LIMITS = {
    count: 12,
    name: 64,
    query: 512,
    string: 256,
} as const;

export const HISTORY_FILTER_KEYS = [
    'historyQuery',
    'historyGroup',
    'historyRecipeId',
    'historyProfile',
    'failureCategory',
    'status',
    'from',
    'to',
] as const;

export type HistoryFilterValues = Readonly<{
    historyQuery?: string;
    historyGroup?: string;
    historyRecipeId?: string;
    historyProfile?: string;
    failureCategory?: RecipeConsoleFailureCategory;
    status?: RecipeConsoleRunStatus;
    from?: number;
    to?: number;
}>;

export type HistoryFilterPreset = Readonly<{
    name: string;
    filters: HistoryFilterValues;
}>;

type DataRecord = Readonly<Record<string, unknown>>;

const PRESET_KEYS = ['name', 'filters'] as const;
const FILTER_KEY_SET = new Set<string>(HISTORY_FILTER_KEYS);
const PRESET_KEY_SET = new Set<string>(PRESET_KEYS);

export function createHistoryFilterPreset(
    name: string,
    committedUrlState: RecipeConsoleUrlState,
): HistoryFilterPreset | undefined {
    const normalizedName = normalizeHistoryFilterPresetName(name);
    const filters = historyFiltersFromCommittedUrlState(committedUrlState);
    return normalizedName && filters
        ? { name: normalizedName, filters }
        : undefined;
}

export function historyFiltersFromCommittedUrlState(
    state: RecipeConsoleUrlState,
): HistoryFilterValues | undefined {
    const candidate: Record<string, unknown> = {};
    for (const key of HISTORY_FILTER_KEYS) {
        const value = state[key];
        if (value !== undefined) candidate[key] = value;
    }
    return parseHistoryFilterValues(candidate);
}

export function parseHistoryFilterPreset(
    value: unknown,
): HistoryFilterPreset | undefined {
    const record = exactDataRecord(value, PRESET_KEY_SET);
    if (!record || !hasOwnData(record, 'name') || !hasOwnData(record, 'filters')) {
        return undefined;
    }
    const nameValue = ownDataValue(record, 'name');
    const normalizedName = typeof nameValue === 'string'
        ? normalizeHistoryFilterPresetName(nameValue)
        : undefined;
    const filters = parseHistoryFilterValues(ownDataValue(record, 'filters'));
    return normalizedName && filters
        ? { name: normalizedName, filters }
        : undefined;
}

export function parseHistoryFilterValues(
    value: unknown,
): HistoryFilterValues | undefined {
    const record = exactDataRecord(value, FILTER_KEY_SET);
    if (!record) return undefined;

    const historyQuery = readOptionalBoundedString(
        record,
        'historyQuery',
        HISTORY_FILTER_PRESET_LIMITS.query,
    );
    const historyGroup = readOptionalBoundedString(
        record,
        'historyGroup',
        HISTORY_FILTER_PRESET_LIMITS.string,
    );
    const historyRecipeId = readOptionalBoundedString(
        record,
        'historyRecipeId',
        HISTORY_FILTER_PRESET_LIMITS.string,
    );
    const historyProfile = readOptionalBoundedString(
        record,
        'historyProfile',
        HISTORY_FILTER_PRESET_LIMITS.string,
    );
    const failureCategory = readOptionalEnum(
        record,
        'failureCategory',
        RECIPE_CONSOLE_FAILURE_CATEGORIES,
    );
    const status = readOptionalEnum(
        record,
        'status',
        RECIPE_CONSOLE_RUN_STATUSES,
    );
    const from = readOptionalEpoch(record, 'from');
    const to = readOptionalEpoch(record, 'to');
    if (
        historyQuery === INVALID || historyGroup === INVALID ||
        historyRecipeId === INVALID || historyProfile === INVALID ||
        failureCategory === INVALID || status === INVALID ||
        from === INVALID || to === INVALID ||
        (from !== undefined && to !== undefined && from > to)
    ) {
        return undefined;
    }

    return {
        ...(historyQuery === undefined ? {} : { historyQuery }),
        ...(historyGroup === undefined ? {} : { historyGroup }),
        ...(historyRecipeId === undefined ? {} : { historyRecipeId }),
        ...(historyProfile === undefined ? {} : { historyProfile }),
        ...(failureCategory === undefined ? {} : { failureCategory }),
        ...(status === undefined ? {} : { status }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
    };
}

export function canonicalizeHistoryFilterPresets(
    values: readonly unknown[],
): readonly HistoryFilterPreset[] {
    let presets: readonly HistoryFilterPreset[] = [];
    for (const value of values) {
        const parsed = parseHistoryFilterPreset(value);
        if (parsed) presets = appendNewest(presets, parsed);
    }
    return presets;
}

export function upsertHistoryFilterPreset(
    current: readonly HistoryFilterPreset[],
    next: HistoryFilterPreset,
): readonly HistoryFilterPreset[] {
    const parsed = parseHistoryFilterPreset(next);
    const canonical = canonicalizeHistoryFilterPresets(current);
    return parsed ? appendNewest(canonical, parsed) : canonical;
}

export function removeHistoryFilterPreset(
    current: readonly HistoryFilterPreset[],
    name: string,
): readonly HistoryFilterPreset[] {
    const normalizedName = normalizeHistoryFilterPresetName(name);
    const canonical = canonicalizeHistoryFilterPresets(current);
    return normalizedName
        ? canonical.filter(entry => entry.name !== normalizedName)
        : canonical;
}

export function historyFilterPresetApplyPatch(
    preset: HistoryFilterPreset,
): Partial<RecipeConsoleUrlState> {
    return {
        historyQuery: preset.filters.historyQuery,
        historyGroup: preset.filters.historyGroup,
        historyRecipeId: preset.filters.historyRecipeId,
        historyProfile: preset.filters.historyProfile,
        failureCategory: preset.filters.failureCategory,
        status: preset.filters.status,
        from: preset.filters.from,
        to: preset.filters.to,
    };
}

export function normalizeHistoryFilterPresetName(
    value: string,
): string | undefined {
    const normalized = value.trim();
    return normalized && normalized.length <= HISTORY_FILTER_PRESET_LIMITS.name
        ? normalized
        : undefined;
}

const INVALID = Symbol('invalid-history-filter-value');

function appendNewest(
    current: readonly HistoryFilterPreset[],
    next: HistoryFilterPreset,
): readonly HistoryFilterPreset[] {
    return [
        ...current.filter(entry => entry.name !== next.name),
        next,
    ].slice(-HISTORY_FILTER_PRESET_LIMITS.count);
}

function exactDataRecord(
    value: unknown,
    allowedKeys: ReadonlySet<string>,
): DataRecord | undefined {
    if (
        !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length > 0
    ) {
        return undefined;
    }
    const record = value as DataRecord;
    for (const key of Object.getOwnPropertyNames(record)) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (
            !allowedKeys.has(key) || !descriptor ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            !descriptor.enumerable
        ) {
            return undefined;
        }
    }
    return record;
}

function hasOwnData(record: DataRecord, key: string): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return Boolean(
        descriptor && descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, 'value'),
    );
}

function ownDataValue(record: DataRecord, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function readOptionalBoundedString(
    record: DataRecord,
    key: string,
    maxLength: number,
): string | undefined | typeof INVALID {
    if (!hasOwnData(record, key)) return undefined;
    const value = ownDataValue(record, key);
    if (typeof value !== 'string') return INVALID;
    const normalized = value.trim();
    return normalized && normalized.length <= maxLength
        ? normalized
        : INVALID;
}

function readOptionalEnum<const Value extends string>(
    record: DataRecord,
    key: string,
    allowed: readonly Value[],
): Value | undefined | typeof INVALID {
    if (!hasOwnData(record, key)) return undefined;
    const value = ownDataValue(record, key);
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? value as Value
        : INVALID;
}

function readOptionalEpoch(
    record: DataRecord,
    key: string,
): number | undefined | typeof INVALID {
    if (!hasOwnData(record, key)) return undefined;
    const value = ownDataValue(record, key);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : INVALID;
}
