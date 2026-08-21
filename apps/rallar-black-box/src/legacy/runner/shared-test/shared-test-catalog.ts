import type { RallarBlackBoxSharedTestRecipeCatalogEntry } from '../../../shared-test-handoff-fixtures.ts';

export type AppLocalRecipeEntry = Readonly<{
    id: string;
    title: string;
    description: string;
    path: string;
    providerMode: string;
    requirements: readonly string[];
    expectedResult: string;
}>;

export const APP_LOCAL_RECIPE_CATALOG: readonly AppLocalRecipeEntry[] = [
    {
        id: 'app-local-group-ws-setup',
        title: 'Group And WebSocket Setup',
        description: 'Creates or reuses bb-group, joins it, acquires a WebSocket ticket, and opens the API socket.',
        path: 'apps/rallar-black-box/examples/rallar-server-group-ws-setup.recipe.json',
        providerMode: 'browser-rallar',
        requirements: [
            'logged-in browser session',
            'Rallar Server API base URL',
            'auth and group endpoints'
        ],
        expectedResult: 'group joined and WebSocket opened'
    },
    {
        id: 'app-local-rtc-connect-send',
        title: 'RTC Connect And Send',
        description: 'Uses the logged-in session and group context to connect RTC and send a realtime payload.',
        path: 'apps/rallar-black-box/examples/rallar-server-rtc-connect-send.recipe.json',
        providerMode: 'browser-rallar',
        requirements: [
            'logged-in browser session',
            'group state API can create or reuse bb-group',
            'RTC signaling available'
        ],
        expectedResult: 'RTC connect succeeds and payload is sent'
    }
];

export function catalogEntryMatches(
    entry: RallarBlackBoxSharedTestRecipeCatalogEntry,
    query: string,
    profile: string
): boolean {
    if (profile && !entry.profiles.includes(profile)) {
        return false;
    }

    if (!query) {
        return true;
    }

    const haystack = [
        entry.id,
        entry.title,
        entry.description,
        entry.recipePath,
        entry.category,
        entry.providerMode,
        entry.liveSupport,
        ...entry.profiles,
        ...entry.uiHints.badges
    ]
        .join(' ')
        .toLowerCase();

    return haystack.includes(query.toLowerCase());
}

export function catalogRequirements(
    entry: RallarBlackBoxSharedTestRecipeCatalogEntry
): readonly string[] {
    return [
        ...entry.prerequisites.requiredEnvVars.map((env) => `env:${env}`),
        ...entry.prerequisites.httpServices.map(
            (service) => `${service.name}:${service.env}`
        ),
        ...(entry.prerequisites.requiresPlaywright ? ['Playwright'] : [])
    ];
}
