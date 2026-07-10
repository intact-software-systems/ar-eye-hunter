import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    distributedRecipeCommandKinds,
    type DistributedRecipeCatalogItem,
} from '../../../distributed-recipes.ts';
import {
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
} from '../../../recipe-fixtures.ts';

const RTC_REALTIME_STABILITY_CATALOG_TITLE = 'RTC Realtime Stability';

export const DISTRIBUTED_RECIPE_CATALOG: readonly DistributedRecipeCatalogItem[] =
    RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((fixture) => {
        const commandKinds = distributedRecipeCommandKinds(fixture.recipe);
        const usesNetwork = commandKinds.some(
            (kind) =>
                kind.startsWith('rtc') ||
                kind.startsWith('ws') ||
                kind === 'http.request',
        );

        return {
            itemId: fixture.fixtureId,
            title: fixture.fixtureId === RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
                ? RTC_REALTIME_STABILITY_CATALOG_TITLE
                : fixture.label,
            description: fixture.description,
            recipe: fixture.recipe,
            providerMode: usesNetwork ? 'browser-rallar' : 'simulated',
            profiles:
                fixture.fixtureId ===
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
                              : 'smoke',
                      ],
            prerequisites: usesNetwork
                ? [
                      'connected browser control agents',
                      'matching global group',
                      'live Rallar backend for real delivery',
                  ]
                : ['connected browser control agents'],
            live: usesNetwork,
            source: 'app-local' as const,
        };
    });

export function configuredDistributedRecipeCatalogItem(
    item: DistributedRecipeCatalogItem,
    input: Readonly<{
        group: RallarBlackBoxDistributedGroupRef;
        apiBaseUrl: string;
        rtcRealtimeDurationSeconds: number;
    }>,
): DistributedRecipeCatalogItem {
    if (item.itemId === 'rtc-smoke') {
        return {
            ...item,
            recipe: createRallarBlackBoxRtcSmokeRecipe({
                group: input.group,
            }),
        };
    }

    if (item.itemId === 'provider-parity') {
        return {
            ...item,
            recipe: createRallarBlackBoxProviderParityLiveRecipe({
                group: input.group,
                apiBaseUrl: input.apiBaseUrl,
            }),
        };
    }

    if (item.itemId === RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID) {
        return {
            ...item,
            recipe: createRallarBlackBoxRtcRealtimeRecipe({
                durationSeconds: input.rtcRealtimeDurationSeconds,
                group: input.group,
            }),
        };
    }

    if (item.itemId === RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID) {
        return {
            ...item,
            recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
                group: input.group,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000,
            }),
        };
    }

    return item;
}

export function distributedRecipeMatches(
    item: DistributedRecipeCatalogItem,
    query: string,
    profile: string,
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
        item.providerMode,
        ...item.profiles,
        ...item.recipe.commands.map((command) => command.kind),
    ]
        .join(' ')
        .toLowerCase();
    return haystack.includes(trimmed);
}
