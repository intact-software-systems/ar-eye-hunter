import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

export type RallarBlackBoxUiStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const UI_STORAGE_KEYS = {
    activeMode: 'rallar-black-box.ui.active-mode',
    activeTab: 'rallar-black-box.ui.active-tab',
    selectedCommandId: 'rallar-black-box.ui.selected-command-id',
    manualDraft: 'rallar-black-box.ui.manual-draft.v1',
    rallarServerDraft: 'rallar-black-box.ui.rallar-server-draft.v1',
    rallarServerCollectionDraft: 'rallar-black-box.ui.rallar-server-collection-draft.v1',
    eventFilters: 'rallar-black-box.ui.event-filters.v1'
} as const;

/**
 * Reads a cached entry. The entry is absent when the browser has no storage, no value under the
 * key, or a value that is not JSON: this cache never breaks the workbench UI.
 */
export function readStoredJson(
    storage: RallarBlackBoxUiStorage | undefined,
    key: string
): ApiJsonValue | undefined {
    if (!storage) {
        return undefined;
    }

    try {
        const value = storage.getItem(key);
        return value ? JSON.parse(value) as ApiJsonValue : undefined;
    }
    catch {
        return undefined;
    }
}

export function writeStoredJson(
    storage: RallarBlackBoxUiStorage | undefined,
    key: string,
    value: object
): void {
    if (!storage) {
        return;
    }

    try {
        storage.setItem(key, JSON.stringify(value));
    }
    catch {
        // Storage quota, privacy mode, and disabled storage should not break the workbench UI.
    }
}

export function readStoredText(
    storage: RallarBlackBoxUiStorage | undefined,
    key: string
): string | undefined {
    if (!storage) {
        return undefined;
    }

    try {
        return storage.getItem(key) ?? undefined;
    }
    catch {
        return undefined;
    }
}

export function writeStoredText(
    storage: RallarBlackBoxUiStorage | undefined,
    key: string,
    value: string
): void {
    if (!storage) {
        return;
    }

    try {
        storage.setItem(key, value);
    }
    catch {
        // Ignore storage failures for the same reason as writeStoredJson.
    }
}

export function deleteStoredText(storage: RallarBlackBoxUiStorage | undefined, key: string): void {
    if (!storage) {
        return;
    }

    try {
        storage.removeItem(key);
    }
    catch {
        // Ignore storage failures for the same reason as writeStoredJson.
    }
}
