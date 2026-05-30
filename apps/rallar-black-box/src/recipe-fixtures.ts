import { createRallarBlackBoxProviderParityRecipe } from '@shared-test/rallar-bb-test/provider-parity.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe, } from '@shared-test/rallar-bb-test/types.ts';

export type RallarBlackBoxRecipeFixture = Readonly<{
    fixtureId: string;
    label: string;
    description: string;
    recipe: RallarBlackBoxTestRecipe;
}>;

export const RALLAR_BLACK_BOX_RECIPE_FIXTURES: readonly RallarBlackBoxRecipeFixture[] = [
    {
        fixtureId: 'rtc-smoke',
        label: 'RTC Smoke',
        description: 'Connects one actor, sends a loopback RTC payload, and records stats.',
        recipe: {
            recipeId: 'rtc-smoke-recipe',
            name: 'RTC smoke recipe',
            continueOnFailure: false,
            commands: [
                {
                    kind: 'rtc.connect',
                    commandId: 'rtc-connect-alice',
                    connection: 'aliceRtc',
                    actor: 'alice',
                    roomId: 'rallar-black-box-room',
                    transport: 'realtime',
                    timeoutMs: 5_000,
                },
                {
                    kind: 'rtc.send',
                    commandId: 'rtc-send-greeting',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        data: {
                            topic: 'black-box.smoke',
                            text: 'hello from local workbench',
                        },
                    },
                    timeoutMs: 3_000,
                },
                {
                    kind: 'stats',
                    commandId: 'rtc-stats-snapshot',
                },
            ],
        },
    },
    {
        fixtureId: 'ws-http-smoke',
        label: 'WS And HTTP',
        description: 'Exercises simulated WebSocket and HTTP browser command paths.',
        recipe: {
            recipeId: 'ws-http-smoke-recipe',
            name: 'WebSocket and HTTP smoke recipe',
            continueOnFailure: false,
            commands: [
                {
                    kind: 'ws.open',
                    commandId: 'ws-open-control',
                    connection: 'control',
                    url: 'wss://control.example.invalid/runs/local-workbench',
                    timeoutMs: 2_000,
                },
                {
                    kind: 'ws.send',
                    commandId: 'ws-send-command',
                    connection: 'control',
                    data: {
                        kind: 'ping',
                        runId: 'local-workbench',
                    },
                    timeoutMs: 2_000,
                },
                {
                    kind: 'ws.close',
                    commandId: 'ws-close-control',
                    connection: 'control',
                    code: 1000,
                    reason: 'local workbench complete',
                },
                {
                    kind: 'http.request',
                    commandId: 'http-bootstrap-check',
                    request: {
                        path: '/health',
                        method: 'GET',
                    },
                    response: {
                        body: 'json',
                    },
                    timeoutMs: 2_000,
                },
                {
                    kind: 'stats',
                    commandId: 'ws-http-stats-snapshot',
                },
            ],
        },
    },
    {
        fixtureId: 'provider-parity',
        label: 'Provider Parity',
        description: 'Portable SPA and runner recipe covering connect, direct, multicast, broadcast, health, close, and reset.',
        recipe: createRallarBlackBoxProviderParityRecipe(),
    },
    {
        fixtureId: 'expected-failure',
        label: 'Expected Failure',
        description: 'Runs an intentionally invalid HTTP command to exercise failed UI state.',
        recipe: {
            recipeId: 'expected-failure-recipe',
            name: 'Expected failure recipe',
            continueOnFailure: false,
            commands: [
                {
                    kind: 'http.request',
                    commandId: 'http-invalid-missing-target',
                    request: {
                        method: 'GET',
                    },
                    timeoutMs: 1_000,
                },
                {
                    kind: 'stats',
                    commandId: 'expected-failure-stats',
                },
            ],
        },
    },
    {
        fixtureId: 'long-running-cancellable',
        label: 'Cancellable Run',
        description: 'Uses slow simulated steps so recipe.cancel can interrupt the next command.',
        recipe: {
            recipeId: 'long-running-cancellable-recipe',
            name: 'Long-running cancellable recipe',
            continueOnFailure: false,
            commands: [
                {
                    kind: 'rtc.connect',
                    commandId: 'long-connect',
                    connection: 'aliceRtc',
                    actor: 'alice',
                    roomId: 'rallar-black-box-room',
                    transport: 'realtime',
                    timeoutMs: 5_000,
                    metadata: {
                        localDelayMs: 1_300,
                    },
                },
                {
                    kind: 'rtc.send',
                    commandId: 'long-send-1',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        data: {
                            seq: 1,
                        },
                    },
                    metadata: {
                        localDelayMs: 1_300,
                    },
                },
                {
                    kind: 'rtc.send',
                    commandId: 'long-send-2',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        data: {
                            seq: 2,
                        },
                    },
                    metadata: {
                        localDelayMs: 1_300,
                    },
                },
            ],
        },
    },
];

export const RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE: RallarBlackBoxTestCommand = {
    kind: 'rtc.send',
    commandId: 'manual-rtc-send',
    connection: 'aliceRtc',
    transport: 'realtime',
    send: {
        data: {
            topic: 'room.manual.message',
            text: 'hello from manual command',
        },
    },
};

export function recipeFixtureText(fixtureId: string): string {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
        entry.fixtureId === fixtureId
    ) ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];
    return JSON.stringify(fixture.recipe, null, 2);
}
