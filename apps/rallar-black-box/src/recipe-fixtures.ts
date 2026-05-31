import { createRallarBlackBoxProviderParityRecipe } from '@shared-test/rallar-bb-test/provider-parity.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe, } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';

export type RallarBlackBoxRecipeFixture = Readonly<{
    fixtureId: string;
    label: string;
    description: string;
    recipe: RallarBlackBoxTestRecipe;
}>;

export const RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID = 'rtc-realtime';
export const RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ = 20;
export const RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS =
    Math.round(1_000 / RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ);
export const RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS = 5;
export const RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS = 1;
export const RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS = 60;

export type RallarBlackBoxRtcRealtimeRecipeOptions = Readonly<{
    durationSeconds?: number;
    group?: RallarBlackBoxDistributedGroupRef;
    connection?: string;
}>;

export function normalizeRallarBlackBoxRtcRealtimeDurationSeconds(value: unknown): number {
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseFloat(value)
            : RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS;
    if (!Number.isFinite(numeric)) {
        return RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS;
    }

    return Math.min(
        RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS,
        Math.max(RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS, Math.round(numeric)),
    );
}

function rtcRealtimePositionFrame(frame: number): Readonly<Record<string, number>> {
    const elapsedSeconds = frame / RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;
    const radius = 12;
    return {
        x: Number((Math.cos(elapsedSeconds) * radius).toFixed(3)),
        y: 0,
        z: Number((Math.sin(elapsedSeconds) * radius).toFixed(3)),
        headingDeg: Number(((elapsedSeconds * 90) % 360).toFixed(1)),
        velocityMps: 4,
    };
}

export function createRallarBlackBoxRtcRealtimeRecipe(
    options: RallarBlackBoxRtcRealtimeRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const durationSeconds = normalizeRallarBlackBoxRtcRealtimeDurationSeconds(options.durationSeconds);
    const frameCount = durationSeconds * RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;
    const connection = options.connection ?? 'rtcRealtime';
    const group = options.group ?? {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'rallar-black-box-room',
    };
    const roomRef = {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
    };
    const sendCommands: RallarBlackBoxTestCommand[] = Array.from({ length: frameCount }, (_entry, index) => ({
        kind: 'rtc.send',
        commandId: `rtc-realtime-position-${String(index + 1).padStart(4, '0')}`,
        connection,
        transport: 'realtime',
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        timeoutMs: 3_000,
        metadata: {
            localDelayMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            realtime: {
                rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                durationSeconds,
                frame: index + 1,
                totalFrames: frameCount,
            },
        },
        send: {
            roomId: group.groupId,
            roomRef,
            openTimeoutMs: 10_000,
            data: {
                topic: 'room.black-box.rtc-realtime.position',
                typeId: 'room.black-box.rtc-realtime.position',
                actor: '{auth.clientId}',
                seq: index,
                rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                durationSeconds,
                totalFrames: frameCount,
                tMs: index * RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                position: rtcRealtimePositionFrame(index),
            },
        },
    }));

    return {
        recipeId: RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
        name: 'RTC realtime position stream',
        description: 'Connect RTC and send game-style position updates at 20 Hz for the configured duration.',
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-realtime',
            rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            durationSeconds,
            frameCount,
            group,
        },
        commands: [
            {
                kind: 'rtc.connect',
                commandId: 'rtc-realtime-connect',
                connection,
                actor: '{auth.clientId}',
                roomId: group.groupId,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                timeoutMs: 10_000,
                metadata: {
                    realtime: {
                        rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                        durationSeconds,
                        frameCount,
                    },
                },
            },
            ...sendCommands,
            {
                kind: 'stats',
                commandId: 'rtc-realtime-stats',
                metadata: {
                    realtime: {
                        rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                        durationSeconds,
                        frameCount,
                    },
                },
            },
        ],
    };
}

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
        fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
        label: 'RTC Realtime',
        description: 'Sends game-style position updates over RTC at 20 Hz for a configurable duration.',
        recipe: createRallarBlackBoxRtcRealtimeRecipe(),
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
