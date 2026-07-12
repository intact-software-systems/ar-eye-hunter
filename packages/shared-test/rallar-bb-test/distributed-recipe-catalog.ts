import {
    distributedRecipeCommandKinds,
    distributedRecipePreflight,
    type DistributedRecipeCatalogItem,
    type DistributedRecipePreflightSummary,
} from './distributed-run-monitor.ts';
import type { RallarBlackBoxDistributedGroupRef } from './distributed-run.ts';
import {
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
} from './recipe-fixtures.ts';
import { validateRallarBlackBoxRecipeCompatibility } from './schema.ts';

const RTC_REALTIME_STABILITY_CATALOG_TITLE = 'RTC Realtime Stability';

export type DistributedRecipeCatalogConfiguration = Readonly<{
    group: RallarBlackBoxDistributedGroupRef;
    apiBaseUrl: string;
    rtcRealtimeDurationSeconds: number;
}>;

export type DistributedRecipeCatalogSchemaFact = Readonly<{
    ok: boolean;
    status: 'valid' | 'legacy-compatible' | 'invalid';
    legacy: boolean;
    label: string;
    warnings: readonly string[];
    errors: readonly string[];
}>;

export type DistributedRecipeCatalogEntryProjection = Readonly<{
    item: DistributedRecipeCatalogItem;
    commandKinds: ReturnType<typeof distributedRecipeCommandKinds>;
    schema: DistributedRecipeCatalogSchemaFact;
    preflight: DistributedRecipePreflightSummary;
}>;

export type DistributedRecipeCatalogProjection = Readonly<{
    entries: readonly DistributedRecipeCatalogEntryProjection[];
    profiles: readonly string[];
    providerModes: readonly string[];
}>;

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
    input: DistributedRecipeCatalogConfiguration,
): DistributedRecipeCatalogItem {
    if (
        item.itemId ===
            RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID ||
        item.itemId ===
            RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID
    ) {
        const [sender, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            group: input.group,
        });
        const isSender = item.itemId ===
            RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID;
        return {
            ...item,
            recipe: isSender ? sender : receiver,
        };
    }

    if (item.itemId === RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID) {
        return {
            ...item,
            recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
                group: input.group,
            }),
        };
    }

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
        item.recipe.name,
        item.recipe.description,
        item.providerMode,
        ...item.profiles,
        ...item.prerequisites,
        ...distributedRecipeCommandKinds(item.recipe),
    ]
        .join(' ')
        .toLowerCase();
    return haystack.includes(trimmed);
}

export function projectDistributedRecipeCatalog(
    input: Readonly<{
        items?: readonly DistributedRecipeCatalogItem[];
        configuration?: DistributedRecipeCatalogConfiguration;
    }> = {},
): DistributedRecipeCatalogProjection {
    const items = (input.items ?? DISTRIBUTED_RECIPE_CATALOG).map((item) =>
        input.configuration
            ? configuredDistributedRecipeCatalogItem(item, input.configuration)
            : item
    );
    const entries = items.map((item): DistributedRecipeCatalogEntryProjection => {
        const compatibility = validateRallarBlackBoxRecipeCompatibility(item.recipe);
        const issueText = (issue: Readonly<{ path: string; message: string }>) =>
            `${issue.path}: ${issue.message}`;
        const status = compatibility.ok
            ? compatibility.legacy
                ? 'legacy-compatible'
                : 'valid'
            : 'invalid';

        return {
            item,
            commandKinds: distributedRecipeCommandKinds(item.recipe),
            schema: {
                ok: compatibility.ok,
                status,
                legacy: compatibility.legacy,
                label: status === 'valid'
                    ? 'Schema valid (v1)'
                    : status === 'legacy-compatible'
                    ? 'Schema valid (compatible v1)'
                    : 'Schema invalid',
                warnings: compatibility.warnings.map(issueText),
                errors: compatibility.errors.map(issueText),
            },
            preflight: distributedRecipePreflight(item.recipe),
        };
    });

    return {
        entries,
        profiles: uniqueSorted(items.flatMap((item) => item.profiles)),
        providerModes: uniqueSorted(items.map((item) => item.providerMode)),
    };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
