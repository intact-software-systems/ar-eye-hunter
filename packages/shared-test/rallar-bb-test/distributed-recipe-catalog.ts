import { distributedRecipeCommandKinds } from './distributed-recipe-preflight/distributed-recipe-command-preview.ts';
import type { DistributedRecipePreflightSummary } from './distributed-recipe-preflight/distributed-recipe-preflight-contracts.ts';
import { distributedRecipePreflight } from './distributed-recipe-preflight/distributed-recipe-preflight.ts';
import type { DistributedRecipeCatalogItem } from './distributed-run-monitor.ts';
import type { RallarBlackBoxDistributedGroupRef } from './distributed-run.ts';
import {
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcSmokeRecipe
} from './fixtures/rtc-live-recipes.ts';
import {
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID
} from './fixtures/rtc-multicast-recipes.ts';
import {
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
} from './fixtures/rtc-realtime-recipes.ts';
import { RALLAR_BLACK_BOX_RECIPE_FIXTURES } from './recipe-fixtures.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from './schema.ts';
import { validateJsonSchema } from './schema/json-schema-validation.ts';

const RTC_REALTIME_STABILITY_CATALOG_TITLE = 'RTC Realtime Stability';

export interface DistributedRecipeCatalogConfiguration {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly apiBaseUrl: string;
    readonly rtcRealtimeDurationSeconds: number;
}

export interface DistributedRecipeCatalogSchemaFact {
    readonly ok: boolean;
    readonly status: 'valid' | 'invalid';
    readonly label: string;
    readonly errors: readonly string[];
}

export interface DistributedRecipeCatalogEntryProjection {
    readonly item: DistributedRecipeCatalogItem;
    readonly commandKinds: ReturnType<typeof distributedRecipeCommandKinds>;
    readonly schema: DistributedRecipeCatalogSchemaFact;
    readonly preflight: DistributedRecipePreflightSummary;
}

export interface DistributedRecipeCatalogProjection {
    readonly entries: readonly DistributedRecipeCatalogEntryProjection[];
    readonly profiles: readonly string[];
    readonly providerModes: readonly string[];
}

export const DISTRIBUTED_RECIPE_CATALOG: readonly DistributedRecipeCatalogItem[] = RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(
    (fixture) => {
        const commandKinds = distributedRecipeCommandKinds(fixture.recipe);
        const usesNetwork = commandKinds.some(
            (kind) =>
                kind.startsWith('rtc') ||
                kind.startsWith('ws') ||
                kind === 'http.request'
        );

        return {
            itemId: fixture.fixtureId,
            title: fixture.fixtureId === RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
                ? RTC_REALTIME_STABILITY_CATALOG_TITLE
                : fixture.label,
            description: fixture.description,
            recipe: fixture.recipe,
            providerMode: usesNetwork ? 'browser-rallar' : 'simulated',
            profiles: fixture.fixtureId ===
                    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
                ? ['rtc', 'realtime', 'stability', 'green', 'rtc-realtime-stability']
                : fixture.fixtureId ===
                        RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID
                ? ['rtc', 'realtime', 'soak']
                : [
                    fixture.fixtureId.includes('rtc') ||
                        commandKinds.some((kind) => kind.startsWith('rtc'))
                        ? 'rtc'
                        : 'general',
                    fixture.fixtureId.includes('failure')
                        ? 'negative'
                        : 'smoke'
                ],
            prerequisites: usesNetwork
                ? [
                    'connected browser control agents',
                    'matching global group',
                    'live Rallar backend for real delivery'
                ]
                : ['connected browser control agents'],
            live: usesNetwork,
            source: 'app-local' as const
        };
    }
);

export function configuredDistributedRecipeCatalogItem(
    item: DistributedRecipeCatalogItem,
    input: DistributedRecipeCatalogConfiguration
): DistributedRecipeCatalogItem {
    switch (item.itemId) {
        case RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID:
        case RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID: {
            const recipes = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({ group: input.group });
            return {
                ...item,
                recipe: recipes[
                    item.itemId === RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID
                        ? 0
                        : 1
                ]
            };
        }
        case RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID:
            return { ...item, recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({ group: input.group }) };
        case 'rtc-smoke':
            return { ...item, recipe: createRallarBlackBoxRtcSmokeRecipe({ group: input.group }) };
        case 'provider-parity':
            return {
                ...item,
                recipe: createRallarBlackBoxProviderParityLiveRecipe({
                    group: input.group,
                    apiBaseUrl: input.apiBaseUrl
                })
            };
        case RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID:
            return {
                ...item,
                recipe: createRallarBlackBoxRtcRealtimeRecipe({
                    durationSeconds: input.rtcRealtimeDurationSeconds,
                    group: input.group
                })
            };
        case RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID:
            return {
                ...item,
                recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
                    group: input.group,
                    readyPeerCount: 1,
                    readyTimeoutMs: 10_000
                })
            };
        default:
            return item;
    }
}

export function distributedRecipeMatches(
    item: DistributedRecipeCatalogItem,
    query: string,
    profile: string
): boolean {
    if (profile && !item.profiles.includes(profile)) {
        return false;
    }
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
        return true;
    }

    const haystack = [
        item.itemId,
        item.title,
        item.description,
        item.recipe.recipeId,
        item.recipe.name,
        item.recipe.description,
        item.providerMode,
        ...item.profiles,
        ...item.prerequisites,
        ...distributedRecipeCommandKinds(item.recipe)
    ]
        .join(' ')
        .toLowerCase();
    return haystack.includes(trimmed);
}

export function projectDistributedRecipeCatalog(
    input: Readonly<{
        items?: readonly DistributedRecipeCatalogItem[];
        configuration?: DistributedRecipeCatalogConfiguration;
    }> = {}
): DistributedRecipeCatalogProjection {
    const items = (input.items ?? DISTRIBUTED_RECIPE_CATALOG).map((item) =>
        input.configuration
            ? configuredDistributedRecipeCatalogItem(item, input.configuration)
            : item
    );
    const entries = items.map((item): DistributedRecipeCatalogEntryProjection => {
        const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, item.recipe);
        const issueText = (issue: Readonly<{ path: string; message: string; }>) => `${issue.path}: ${issue.message}`;

        return {
            item,
            commandKinds: distributedRecipeCommandKinds(item.recipe),
            schema: {
                ok: validation.ok,
                status: validation.ok ? 'valid' : 'invalid',
                label: validation.ok ? 'Schema valid (v1)' : 'Schema invalid',
                errors: validation.errors.map(issueText)
            },
            preflight: distributedRecipePreflight(item.recipe)
        };
    });

    return {
        entries,
        profiles: uniqueSorted(items.flatMap((item) => item.profiles)),
        providerModes: uniqueSorted(items.map((item) => item.providerMode))
    };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
