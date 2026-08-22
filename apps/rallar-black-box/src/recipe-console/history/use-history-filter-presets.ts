import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    createHistoryFilterPreset,
    removeHistoryFilterPreset,
    upsertHistoryFilterPreset,
    type HistoryFilterPreset
} from './history-filter-contract.ts';
import {
    readHistoryFilterPresets,
    writeHistoryFilterPresets,
    type HistoryFilterPresetReadStatus,
    type HistoryFilterStorage
} from './history-filter-storage.ts';

export type HistoryFilterPresetControllerStatus =
    | HistoryFilterPresetReadStatus
    | 'write-failed';

export type HistoryFilterPresetController = Readonly<{
    presets: readonly HistoryFilterPreset[];
    status: HistoryFilterPresetControllerStatus;
    save(name: string): void;
    remove(name: string): void;
}>;

type HistoryFilterPresetModel = Readonly<{
    presets: readonly HistoryFilterPreset[];
    status: HistoryFilterPresetControllerStatus;
}>;

export function useHistoryFilterPresets(
    input: Readonly<{
        committedUrlState: RecipeConsoleUrlState;
        storage?: HistoryFilterStorage | null;
    }>
): HistoryFilterPresetController {
    const storage = useMemo(
        () =>
            input.storage === undefined
                ? browserHistoryFilterStorage()
                : input.storage ?? undefined,
        [input.storage]
    );
    const [model, setModel] = useState<HistoryFilterPresetModel>(
        () => readHistoryFilterPresets(storage)
    );
    const modelRef = useRef(model);
    const storageRef = useRef(storage);

    useLayoutEffect(() => {
        if (storageRef.current === storage) {
            return;
        }
        storageRef.current = storage;
        const next = readHistoryFilterPresets(storage);
        modelRef.current = next;
        setModel(next);
    }, [storage]);

    const commitModel = useCallback((next: HistoryFilterPresetModel): void => {
        modelRef.current = next;
        setModel(next);
    }, []);

    const save = useCallback((name: string): void => {
        const current = modelRef.current;
        if (current.status === 'unsupported' || current.status === 'unavailable') {
            return;
        }
        const nextPreset = createHistoryFilterPreset(
            name,
            input.committedUrlState
        );
        if (!nextPreset) {
            commitModel({ ...current, status: 'invalid' });
            return;
        }
        const presets = upsertHistoryFilterPreset(current.presets, nextPreset);
        commitModel(
            writeHistoryFilterPresets(storage, presets)
                ? { status: 'ready', presets }
                : { ...current, status: 'write-failed' }
        );
    }, [commitModel, input.committedUrlState, storage]);

    const remove = useCallback((name: string): void => {
        const current = modelRef.current;
        if (current.status === 'unsupported' || current.status === 'unavailable') {
            return;
        }
        const presets = removeHistoryFilterPreset(current.presets, name);
        commitModel(
            writeHistoryFilterPresets(storage, presets)
                ? { status: 'ready', presets }
                : { ...current, status: 'write-failed' }
        );
    }, [commitModel, storage]);

    return {
        presets: model.presets,
        status: model.status,
        save,
        remove
    };
}

function browserHistoryFilterStorage(): HistoryFilterStorage | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    try {
        return window.localStorage;
    }
    catch {
        return undefined;
    }
}
