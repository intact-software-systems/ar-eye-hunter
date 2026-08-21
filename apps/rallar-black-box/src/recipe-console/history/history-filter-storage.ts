import {
    canonicalizeHistoryFilterPresets,
    parseHistoryFilterPreset,
    type HistoryFilterPreset
} from './history-filter-contract.ts';

export const HISTORY_FILTER_PRESET_STORAGE_KEY = 'rallar-black-box.ui.recipe-console.history-filter-presets.v1';
export const HISTORY_FILTER_PRESET_MAX_SERIALIZED_LENGTH = 128 * 1024;
export const HISTORY_FILTER_PRESET_MAX_INPUT_COUNT = 1024;

export type HistoryFilterStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type HistoryFilterPresetReadStatus =
    | 'ready'
    | 'invalid'
    | 'unsupported'
    | 'unavailable';

export type HistoryFilterPresetReadResult = Readonly<{
    status: HistoryFilterPresetReadStatus;
    presets: readonly HistoryFilterPreset[];
}>;

const EMPTY_INVALID: HistoryFilterPresetReadResult = {
    status: 'invalid',
    presets: []
};

export function parseHistoryFilterPresetEnvelope(
    value: unknown
): HistoryFilterPresetReadResult {
    const envelope = exactEnvelope(value);
    if (!envelope) {
        return EMPTY_INVALID;
    }
    const version = ownDataValue(envelope, 'version');
    if (version !== 1) {
        return typeof version === 'number' && Number.isSafeInteger(version) && version > 1
            ? { status: 'unsupported', presets: [] }
            : EMPTY_INVALID;
    }
    const entries = exactArrayValues(ownDataValue(envelope, 'presets'));
    if (!entries) {
        return EMPTY_INVALID;
    }

    const valid: HistoryFilterPreset[] = [];
    for (const entry of entries) {
        const parsed = parseHistoryFilterPreset(entry);
        if (parsed) {
            valid.push(parsed);
        }
    }
    return {
        status: 'ready',
        presets: canonicalizeHistoryFilterPresets(valid)
    };
}

export function deserializeHistoryFilterPresets(
    serialized: string
): HistoryFilterPresetReadResult {
    if (serialized.length > HISTORY_FILTER_PRESET_MAX_SERIALIZED_LENGTH) {
        return EMPTY_INVALID;
    }
    try {
        return parseHistoryFilterPresetEnvelope(JSON.parse(serialized) as unknown);
    }
    catch {
        return EMPTY_INVALID;
    }
}

export function serializeHistoryFilterPresets(
    presets: readonly HistoryFilterPreset[]
): string {
    return JSON.stringify({
        version: 1,
        presets: canonicalizeHistoryFilterPresets(presets)
    });
}

export function readHistoryFilterPresets(
    storage: HistoryFilterStorage | undefined
): HistoryFilterPresetReadResult {
    if (!storage) {
        return { status: 'unavailable', presets: [] };
    }
    try {
        const value = storage.getItem(HISTORY_FILTER_PRESET_STORAGE_KEY);
        return value === null
            ? { status: 'ready', presets: [] }
            : deserializeHistoryFilterPresets(value);
    }
    catch {
        return { status: 'unavailable', presets: [] };
    }
}

export function writeHistoryFilterPresets(
    storage: HistoryFilterStorage | undefined,
    presets: readonly HistoryFilterPreset[]
): boolean {
    if (!storage) {
        return false;
    }
    try {
        const canonical = canonicalizeHistoryFilterPresets(presets);
        if (canonical.length === 0) {
            storage.removeItem(HISTORY_FILTER_PRESET_STORAGE_KEY);
        }
        else {
            storage.setItem(
                HISTORY_FILTER_PRESET_STORAGE_KEY,
                serializeHistoryFilterPresets(canonical)
            );
        }
        return true;
    }
    catch {
        return false;
    }
}

type DataRecord = Readonly<Record<string, unknown>>;

function exactEnvelope(value: unknown): DataRecord | undefined {
    if (
        !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length > 0
    ) {
        return undefined;
    }
    const record = value as DataRecord;
    const names = Object.getOwnPropertyNames(record);
    if (
        names.length !== 2 || !isEnumerableData(record, 'version') ||
        !isEnumerableData(record, 'presets')
    ) {
        return undefined;
    }
    return names.every((key) => isEnumerableData(record, key))
        ? record
        : undefined;
}

function exactArrayValues(value: unknown): readonly unknown[] | undefined {
    if (
        !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        value.length > HISTORY_FILTER_PRESET_MAX_INPUT_COUNT
    ) {
        return undefined;
    }
    const names = Object.getOwnPropertyNames(value).filter((key) => key !== 'length');
    if (names.length !== value.length) {
        return undefined;
    }
    const nameSet = new Set(names);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!nameSet.has(key) || !isEnumerableData(value, key)) {
            return undefined;
        }
        result.push(Object.getOwnPropertyDescriptor(value, key)?.value);
    }
    return result;
}

function isEnumerableData(value: object, key: string): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(
        descriptor && descriptor.enumerable &&
            Object.prototype.hasOwnProperty.call(descriptor, 'value')
    );
}

function ownDataValue(record: DataRecord, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}
