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
import type { RallarBlackBoxTestRecipe } from './rallar-black-box-test-contracts.ts';

export interface RallarBlackBoxRecipeFixture {
readonly fixtureId: string;
readonly label: string;
readonly description: string;
readonly recipe: RallarBlackBoxTestRecipe;
}
export const RALLAR_BLACK_BOX_RECIPE_FIXTURES: readonly RallarBlackBoxRecipeFixture[] = [
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
        label: 'RTC Messages Principal Sender',
        description: 'Principal headless authority multicasts RTC messages to a larger group.',
        recipe: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes()[0]
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
        label: 'RTC Messages Principal Receiver',
        description: 'Receiver role for principal RTC messages multicast delivery checks.',
        recipe: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes()[1]
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
        label: 'RTC Messages All-Peer Multicast',
        description: 'Every peer multicasts RTC messages and asserts inbound delivery.',
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe()
    },
    {
        fixtureId: 'rtc-smoke',
        label: 'RTC Smoke',
        description: 'Connects one actor, sends a loopback RTC payload, and records stats.',
        recipe: createRallarBlackBoxRtcSmokeRecipe()
    },
    {
        fixtureId: 'ws-http-smoke',
        label: 'WS And HTTP',
        description: 'Exercises simulated WebSocket and HTTP browser command paths.',
        recipe: {
            schemaVersion: 1,
            recipeId: 'ws-http-smoke-recipe',
            name: 'WebSocket and HTTP smoke recipe',
            continueOnFailure: false,
            commands: [
                {
                    kind: 'ws.open',
                    commandId: 'ws-open-control',
                    connection: 'control',
                    url: 'wss://control.example.invalid/runs/local-workbench',
                    timeoutMs: 2_000
                },
                {
                    kind: 'ws.send',
                    commandId: 'ws-send-command',
                    connection: 'control',
                    data: {
                        kind: 'ping',
                        runId: 'local-workbench'
                    },
                    timeoutMs: 2_000
                },
                {
                    kind: 'ws.close',
                    commandId: 'ws-close-control',
                    connection: 'control',
                    code: 1000,
                    reason: 'local workbench complete'
                },
                {
                    kind: 'http.request',
                    commandId: 'http-bootstrap-check',
                    request: {
                        path: '/health',
                        method: 'GET'
                    },
                    response: {
                        body: 'json'
                    },
                    timeoutMs: 2_000
                },
                {
                    kind: 'stats',
                    commandId: 'ws-http-stats-snapshot'
                }
            ]
        }
    },
    {
        fixtureId: 'provider-parity',
        label: 'Provider Parity',
        description:
            'Portable SPA and runner recipe covering connect, direct, multicast, broadcast, health, close, and reset.',
        recipe: createRallarBlackBoxProviderParityLiveRecipe()
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
        label: 'RTC Realtime',
        description: 'Sends game-style position updates over RTC at 20 Hz for a configurable duration.',
        recipe: createRallarBlackBoxRtcRealtimeRecipe()
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
        label: 'RTC Realtime Stability',
        description: 'Lower-risk 5 Hz RTC realtime stream for green stability checks.',
        recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe()
    },
    {
        fixtureId: 'composite-evidence',
        label: 'Composite Evidence',
        description: 'Runs loop, parallel, wait, and assert commands against local ' +
            'browser-agent evidence.',
        recipe: {
            schemaVersion: 1,
            recipeId: 'composite-evidence-recipe',
            name: 'Composite evidence recipe',
            description: 'Validates composite command authoring without requiring live ' +
                'Rallar services.',
            continueOnFailure: false,
            metadata: {
                profile: 'composite',
                primitives: ['loop', 'parallel', 'wait', 'assert']
            },
            commands: [
                {
                    kind: 'loop',
                    commandId: 'composite-health-loop',
                    count: 2,
                    intervalMs: 1,
                    maxCommands: 2,
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'loop-health',
                            label: 'Loop health'
                        }
                    ]
                },
                {
                    kind: 'parallel',
                    commandId: 'parallel-evidence',
                    maxConcurrency: 2,
                    groups: [
                        {
                            groupId: 'left-health',
                            commands: [
                                {
                                    kind: 'health',
                                    commandId: 'parallel-left-health'
                                }
                            ]
                        },
                        {
                            groupId: 'right-stats',
                            commands: [
                                {
                                    kind: 'stats',
                                    commandId: 'parallel-right-stats'
                                }
                            ]
                        }
                    ]
                },
                {
                    kind: 'wait',
                    commandId: 'wait-for-parallel-result',
                    timeoutMs: 1_000,
                    match: {
                        kind: 'result',
                        commandId: 'parallel-evidence',
                        payloadPath: 'ok',
                        equals: true
                    }
                },
                {
                    kind: 'assert',
                    commandId: 'assert-wait-succeeded',
                    source: 'lastResult.ok',
                    operator: 'equals',
                    expected: true
                },
                {
                    kind: 'stats',
                    commandId: 'composite-evidence-stats'
                }
            ]
        }
    },
    {
        fixtureId: 'expected-failure',
        label: 'Expected Failure',
        description: 'Runs an intentionally invalid HTTP command to exercise failed UI state.',
        recipe: {
            schemaVersion: 1,
            recipeId: 'expected-failure-recipe',
            name: 'Expected failure recipe',
            continueOnFailure: false,
            commands: [
                {
                    kind: 'http.request',
                    commandId: 'http-invalid-missing-target',
                    request: {
                        method: 'GET'
                    },
                    timeoutMs: 1_000
                },
                {
                    kind: 'stats',
                    commandId: 'expected-failure-stats'
                }
            ]
        }
    },
    {
        fixtureId: 'long-running-cancellable',
        label: 'Cancellable Run',
        description: 'Uses slow simulated steps so recipe.cancel can interrupt the next command.',
        recipe: {
            schemaVersion: 1,
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
                        localDelayMs: 1_300
                    }
                },
                {
                    kind: 'rtc.send',
                    commandId: 'long-send-1',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        data: {
                            seq: 1
                        }
                    },
                    metadata: {
                        localDelayMs: 1_300
                    }
                },
                {
                    kind: 'rtc.send',
                    commandId: 'long-send-2',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        data: {
                            seq: 2
                        }
                    },
                    metadata: {
                        localDelayMs: 1_300
                    }
                }
            ]
        }
    }
];

export function recipeFixtureText(fixtureId: string): string {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === fixtureId) ??
        RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];
    return JSON.stringify(fixture.recipe, null, 2);
}

export {
    createRallarBlackBoxEnsureGroupRequestId,
    RallarBlackBoxLiveRecipeOptions
} from './fixtures/live-rtc-setup.ts';
export {
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcSmokeRecipe
} from './fixtures/rtc-live-recipes.ts';
export {
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
    RallarBlackBoxRtcMessagesMulticastRecipeOptions
} from './fixtures/rtc-multicast-recipes.ts';
export {
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    normalizeRallarBlackBoxRtcRealtimeDurationSeconds,
    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
    RallarBlackBoxRtcRealtimeRecipeOptions
} from './fixtures/rtc-realtime-recipes.ts';
