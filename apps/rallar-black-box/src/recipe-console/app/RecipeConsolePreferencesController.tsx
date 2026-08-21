import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { RecipeConsoleControlBootstrap } from '../control/ControlConnectionProvider.tsx';
import {
    readRecipeConsolePreferences,
    resetRecipeConsolePreferences,
    resolveRecipeConsolePreferenceState,
    writeRecipeConsolePreferences,
    type RecipeConsolePreferences,
    type RecipeConsolePreferencesStorage,
    type RecipeConsolePreferenceState
} from './recipe-console-preferences.ts';

export type RecipeConsolePreferencesControllerValue = Readonly<{
    error?: string;
    preferences: RecipeConsolePreferences;
    reset(): boolean;
    save(preferences: RecipeConsolePreferences): boolean;
    state: RecipeConsolePreferenceState;
}>;

export function RecipeConsolePreferencesController({
    bootstrap,
    children
}: Readonly<{
    bootstrap: RecipeConsoleControlBootstrap;
    children(value: RecipeConsolePreferencesControllerValue): ReactNode;
}>) {
    const [preferences, setPreferences] = useState(readInitialPreferences);
    const [error, setError] = useState<string>();
    const state = useMemo(
        () =>
            resolveRecipeConsolePreferenceState({
                bootstrap,
                preferences,
                search: globalThis.location?.search ?? '',
                env: (import.meta as {
                    env?: Readonly<Record<string, string | undefined>>;
                }).env ?? {}
            }),
        [bootstrap, preferences]
    );
    const save = useCallback((next: RecipeConsolePreferences) => {
        try {
            const stored = writeRecipeConsolePreferences(
                browserStorage(),
                next
            );
            setPreferences(stored);
            setError(undefined);
            return true;
        }
        catch (cause) {
            setError(errorMessage(cause));
            return false;
        }
    }, []);
    const reset = useCallback(() => {
        try {
            const storage = browserStorage();
            resetRecipeConsolePreferences(storage);
            setPreferences(readRecipeConsolePreferences(storage));
            setError(undefined);
            return true;
        }
        catch (cause) {
            setError(errorMessage(cause));
            return false;
        }
    }, []);

    return children({ error, preferences, reset, save, state });
}

function readInitialPreferences(): RecipeConsolePreferences {
    try {
        return readRecipeConsolePreferences(browserStorage());
    }
    catch (_error) {
        return readRecipeConsolePreferences(memoryStorage());
    }
}

function browserStorage(): RecipeConsolePreferencesStorage {
    return globalThis.localStorage;
}

function memoryStorage(): RecipeConsolePreferencesStorage {
    return {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
    };
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error
        ? cause.message
        : 'Personal defaults could not be updated.';
}
