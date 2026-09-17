import type { AppModeId, AppTabId } from './app-tabs.ts';
import { appModeFromValue, appTabFromValue } from './app-tabs.ts';
import type { RallarBlackBoxUiStorage } from './ui-persistence.ts';
import { deleteStoredText, readStoredText, UI_STORAGE_KEYS, writeStoredText } from './ui-persistence.ts';

export function readStoredAppTab(storage: RallarBlackBoxUiStorage | undefined): AppTabId | undefined {
    const value = readStoredText(storage, UI_STORAGE_KEYS.activeTab);
    return value ? appTabFromValue(value) : undefined;
}

export function writeStoredAppTab(storage: RallarBlackBoxUiStorage | undefined, tab: AppTabId): void {
    writeStoredText(storage, UI_STORAGE_KEYS.activeTab, tab);
}

export function readStoredAppMode(storage: RallarBlackBoxUiStorage | undefined): AppModeId | undefined {
    const value = readStoredText(storage, UI_STORAGE_KEYS.activeMode);
    return value ? appModeFromValue(value) : undefined;
}

export function writeStoredAppMode(storage: RallarBlackBoxUiStorage | undefined, mode: AppModeId): void {
    writeStoredText(storage, UI_STORAGE_KEYS.activeMode, mode);
}

export function readStoredSelectedCommandId(
    storage: RallarBlackBoxUiStorage | undefined
): string | undefined {
    return readStoredText(storage, UI_STORAGE_KEYS.selectedCommandId);
}

export function writeStoredSelectedCommandId(
    storage: RallarBlackBoxUiStorage | undefined,
    commandId: string | undefined
): void {
    if (commandId) {
        writeStoredText(storage, UI_STORAGE_KEYS.selectedCommandId, commandId);
        return;
    }
    deleteStoredText(storage, UI_STORAGE_KEYS.selectedCommandId);
}
