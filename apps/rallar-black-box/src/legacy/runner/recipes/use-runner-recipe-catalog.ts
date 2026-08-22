import { useMemo, useState } from 'react';
import { distributedRecipePreflight } from '../../../distributed-recipes.ts';
import { RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS } from '../../../recipe-fixtures.ts';
import { uniqueValues } from '../../shared/unique-values.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { runnerRecipeCatalog, runnerRecipeMatches, type RunnerRecipeSource } from './runner-recipe-catalog.ts';

export function useRunnerRecipeCatalog({
    globalValues
}: Readonly<{
    globalValues: CommandCenterGlobalValues;
}>) {
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [sourceFilter, setSourceFilter] = useState<RunnerRecipeSource | 'all'>('all');
    const [selectedRecipeId, setSelectedRecipeId] = useState('');
    const [showEditor, setShowEditor] = useState(false);
    const groupRef = useMemo(
        () => ({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId
        }),
        [
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId
        ]
    );
    const catalog = useMemo(
        () =>
            runnerRecipeCatalog({
                group: groupRef,
                apiBaseUrl: globalValues.apiBaseUrl,
                rtcRealtimeDurationSeconds: RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS
            }),
        [globalValues.apiBaseUrl, groupRef]
    );
    const profileOptions = useMemo(
        () => uniqueValues(catalog.flatMap((entry) => entry.profiles)),
        [catalog]
    );
    const filteredRecipes = useMemo(
        () => catalog.filter((entry) => runnerRecipeMatches(entry, query, profile, sourceFilter)),
        [catalog, profile, query, sourceFilter]
    );
    const selectedRecipe = catalog.find((entry) => entry.id === selectedRecipeId) ??
        filteredRecipes[0] ??
        catalog[0];
    const recipePreflight = useMemo(
        () =>
            selectedRecipe?.recipe
                ? distributedRecipePreflight(selectedRecipe.recipe)
                : undefined,
        [selectedRecipe]
    );

    return {
        query,
        setQuery,
        profile,
        setProfile,
        sourceFilter,
        setSourceFilter,
        selectedRecipeId,
        setSelectedRecipeId,
        showEditor,
        setShowEditor,
        groupRef,
        catalog,
        profileOptions,
        filteredRecipes,
        selectedRecipe,
        recipePreflight
    };
}

export type RunnerRecipeCatalogModel = ReturnType<typeof useRunnerRecipeCatalog>;
