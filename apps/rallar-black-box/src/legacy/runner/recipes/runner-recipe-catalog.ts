import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import { distributedRecipeCommandPreview, type DistributedRecipeCatalogItem } from '../../../distributed-recipes.ts';
import { RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG } from '../../../shared-test-handoff-fixtures.ts';
import { json } from '../../shared/json-presentation.ts';
import {
    configuredDistributedRecipeCatalogItem,
    DISTRIBUTED_RECIPE_CATALOG
} from '../distributed-recipes/distributed-recipe-catalog.ts';
import { catalogRequirements } from '../shared-test/shared-test-catalog.ts';

export type RunnerRecipeSource = 'app-local' | 'shared-test';

export type RunnerRecipeCatalogEntry = Readonly<{
    id: string;
    title: string;
    description: string;
    source: RunnerRecipeSource;
    path: string;
    providerMode: string;
    profiles: readonly string[];
    requirements: readonly string[];
    expectedResult: string;
    live: boolean;
    recipe?: RallarBlackBoxTestRecipe;
    distributedItem?: DistributedRecipeCatalogItem;
    copyCommand: string;
    commandCount?: number;
}>;

export function runnerRecipeCatalog(
    input: Readonly<{
        group: RallarBlackBoxDistributedGroupRef;
        apiBaseUrl: string;
        rtcRealtimeDurationSeconds: number;
    }>
): readonly RunnerRecipeCatalogEntry[] {
    const distributedItems = DISTRIBUTED_RECIPE_CATALOG.map((item) =>
        configuredDistributedRecipeCatalogItem(item, input)
    );
    const fixtureEntries = distributedItems.map((item) => {
        const preview = distributedRecipeCommandPreview(item.recipe);
        return {
            id: `fixture:${item.itemId}`,
            title: item.title,
            description: item.description,
            source: 'app-local' as const,
            path: `fixture:${item.itemId}`,
            providerMode: item.providerMode,
            profiles: item.profiles,
            requirements: item.prerequisites,
            expectedResult: preview.label,
            live: item.live,
            recipe: item.recipe,
            distributedItem: item,
            copyCommand: json({
                kind: 'recipe.run',
                recipe: item.recipe
            }),
            commandCount: item.recipe.commands.length
        } satisfies RunnerRecipeCatalogEntry;
    });
    const sharedEntries = RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG.entries.map(
        (entry) => ({
            id: `shared:${entry.id}`,
            title: entry.title,
            description: entry.description,
            source: 'shared-test' as const,
            path: entry.recipePath,
            providerMode: entry.providerMode,
            profiles: entry.profiles,
            requirements: catalogRequirements(entry),
            expectedResult: entry.expectedResult,
            live: entry.support.live,
            copyCommand: entry.commands[0]?.command ?? entry.recipePath,
            commandCount: entry.commands.length
        } satisfies RunnerRecipeCatalogEntry)
    );

    return [...fixtureEntries, ...sharedEntries].sort(
        (left, right) =>
            runnerRecipeDefaultScore(left) - runnerRecipeDefaultScore(right) ||
            (left.commandCount ?? Number.MAX_SAFE_INTEGER) -
                (right.commandCount ?? Number.MAX_SAFE_INTEGER) ||
            left.title.localeCompare(right.title)
    );
}

function runnerRecipeDefaultScore(entry: RunnerRecipeCatalogEntry): number {
    return (
        (entry.recipe ? 0 : 100) +
        (entry.live ? 40 : 0) +
        (entry.source === 'shared-test' ? 20 : 0)
    );
}

export function runnerRecipeMatches(
    entry: RunnerRecipeCatalogEntry,
    query: string,
    profile: string,
    source: RunnerRecipeSource | 'all'
): boolean {
    if (source !== 'all' && entry.source !== source) {
        return false;
    }
    if (profile && !entry.profiles.includes(profile)) {
        return false;
    }
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
        return true;
    }
    return [
        entry.id,
        entry.title,
        entry.description,
        entry.path,
        entry.providerMode,
        entry.expectedResult,
        ...entry.profiles,
        ...entry.requirements
    ]
        .join(' ')
        .toLowerCase()
        .includes(trimmed);
}
