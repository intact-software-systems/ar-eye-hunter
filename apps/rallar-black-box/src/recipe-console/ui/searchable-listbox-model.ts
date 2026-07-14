import type { ExplicitWindowModel } from './explicit-window-model.ts';

export const SEARCHABLE_LISTBOX_WINDOW_SIZE = 100;

export type SearchableListboxOption = Readonly<{
    key: string;
    value: string;
    label: string;
    searchText: string;
    detail?: string;
    exactIdentifier?: string;
}>;

export type SearchableListboxRow = Readonly<{
    option: SearchableListboxOption;
    sourceIndex: number;
}>;

export function duplicateSearchableListboxKey(
    options: readonly SearchableListboxOption[],
): string | undefined {
    const keys = new Set<string>();
    for (const option of options) {
        if (keys.has(option.key)) return option.key;
        keys.add(option.key);
    }
    return undefined;
}

export function filterSearchableListboxRows(
    options: readonly SearchableListboxOption[],
    query: string,
): readonly SearchableListboxRow[] {
    const needle = normalizedSearch(query);
    const rows: SearchableListboxRow[] = [];
    for (let sourceIndex = 0; sourceIndex < options.length; sourceIndex += 1) {
        const option = options[sourceIndex];
        if (!option || (needle && !searchValue(option).includes(needle))) continue;
        rows.push({ option, sourceIndex });
    }
    return rows;
}

export function searchableListboxFingerprint(
    contextKey: string,
    query: string,
): string {
    return JSON.stringify([
        'searchable-windowed-listbox-v1',
        contextKey,
        normalizedSearch(query),
    ]);
}

export function findSearchableListboxRow(
    rows: readonly SearchableListboxRow[],
    key: string | undefined,
): number {
    if (key === undefined) return -1;
    return rows.findIndex(row => row.option.key === key);
}

export function searchableListboxOptionId(
    id: string,
    row: SearchableListboxRow,
): string {
    return `${id}-option-${row.sourceIndex}`;
}

export function searchableListboxRangeLabel(
    model: ExplicitWindowModel,
    query: string,
): string {
    if (model.total === 0) {
        return normalizedSearch(query)
            ? 'No options match this search.'
            : 'No options available.';
    }
    return `Showing ${number(model.displayStart)}–${number(model.displayEnd)} of ${
        number(model.total)
    } options.`;
}

export function searchableListboxOutsideCount(
    model: ExplicitWindowModel,
): number {
    return model.total - (model.endIndexExclusive - model.startIndex);
}

export function normalizedSearch(value: string): string {
    return value.trim().toLocaleLowerCase('en-US');
}

function searchValue(option: SearchableListboxOption): string {
    return [
        option.key,
        option.value,
        option.label,
        option.searchText,
        option.detail ?? '',
        option.exactIdentifier ?? '',
    ].join('\u0000').toLocaleLowerCase('en-US');
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}
