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
const RALLAR_BLACK_BOX_LIVE_API_BASE_URL = 'https://api.rallar.intactss.com';

export type RallarBlackBoxRtcRealtimeRecipeOptions = Readonly<{
    durationSeconds?: number;
    group?: RallarBlackBoxDistributedGroupRef;
    connection?: string;
}>;

export type RallarBlackBoxLiveRecipeOptions = Readonly<{
    group?: RallarBlackBoxDistributedGroupRef;
    apiBaseUrl?: string;
    actor?: string;
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

function stateApiPathSegment(value: string): string {
    return encodeURIComponent(value);
}

function stateApiActorPathSegment(value: string): string {
    return value.includes('{') ? value : stateApiPathSegment(value);
}

function defaultRallarBlackBoxGroup(): RallarBlackBoxDistributedGroupRef {
    return {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'rallar-black-box-room',
    };
}

function groupRoomRef(group: RallarBlackBoxDistributedGroupRef): RallarBlackBoxDistributedGroupRef {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
    };
}

function createRallarBlackBoxEnsureGroupCommands(input: Readonly<{
    commandPrefix: string;
    requestPrefix: string;
    group: RallarBlackBoxDistributedGroupRef;
    actor?: string;
}>): readonly RallarBlackBoxTestCommand[] {
    const actor = input.actor ?? '{auth.clientId}';
    const encodedApplicationId = stateApiPathSegment(input.group.applicationId);
    const encodedWorkspaceId = stateApiPathSegment(input.group.workspaceId);
    const encodedGroupId = stateApiPathSegment(input.group.groupId);
    const actorPathSegment = stateApiActorPathSegment(actor);
    const groupStatePath =
        `/api/state/apps/${encodedApplicationId}/workspaces/${encodedWorkspaceId}/groups`;
    const groupMemberPath =
        `${groupStatePath}/${encodedGroupId}/members/${actorPathSegment}`;
    const groupRequestKey = [
        input.requestPrefix,
        'ensure-group',
        input.group.applicationId,
        input.group.workspaceId,
        input.group.groupId,
    ].join(':');
    const memberRequestKey = [
        input.requestPrefix,
        'ensure-member',
        input.group.applicationId,
        input.group.workspaceId,
        input.group.groupId,
        actor,
    ].join(':');

    return [
        {
            kind: 'http.request',
            commandId: `${input.commandPrefix}-ensure-group`,
            timeoutMs: 5_000,
            metadata: {
                purpose: 'Ensure the backend group exists before RTC room join.',
                idempotent: true,
                group: input.group,
            },
            request: {
                method: 'POST',
                path: groupStatePath,
                body: {
                    requestId: groupRequestKey,
                    groupId: input.group.groupId,
                    displayName: input.group.groupId,
                    joinMode: 'open',
                },
            },
            response: {
                body: 'json',
            },
        },
        {
            kind: 'http.request',
            commandId: `${input.commandPrefix}-ensure-member`,
            timeoutMs: 5_000,
            metadata: {
                purpose: 'Ensure the logged-in browser client is an active group member before RTC room join.',
                idempotent: true,
                group: input.group,
            },
            request: {
                method: 'PUT',
                path: groupMemberPath,
                body: {
                    requestId: memberRequestKey,
                    status: 'active',
                },
            },
            response: {
                body: 'json',
            },
        },
    ];
}

export function createRallarBlackBoxRtcSmokeRecipe(
    options: RallarBlackBoxLiveRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const actor = options.actor ?? '{auth.clientId}';
    const connection = options.connection ?? 'aliceRtc';

    return {
        recipeId: 'rtc-smoke-recipe',
        name: 'RTC smoke recipe',
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-smoke',
            group,
        },
        commands: [
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'rtc-smoke',
                requestPrefix: 'rtc-smoke',
                group,
                actor,
            }),
            {
                kind: 'rtc.connect',
                commandId: 'rtc-connect-alice',
                connection,
                actor,
                roomId: group.groupId,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                timeoutMs: 5_000,
            },
            {
                kind: 'rtc.send',
                commandId: 'rtc-send-greeting',
                connection,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                send: {
                    roomId: group.groupId,
                    roomRef,
                    data: {
                        topic: 'black-box.smoke',
                        text: 'hello from local workbench',
                        actor,
                    },
                },
                timeoutMs: 3_000,
            },
            {
                kind: 'stats',
                commandId: 'rtc-stats-snapshot',
            },
        ],
    };
}

export function createRallarBlackBoxProviderParityLiveRecipe(
    options: RallarBlackBoxLiveRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const actor = options.actor ?? '{auth.clientId}';
    const connection = options.connection ?? 'aliceRtc';
    const apiBaseUrl = options.apiBaseUrl ?? RALLAR_BLACK_BOX_LIVE_API_BASE_URL;
    const baseRecipe = createRallarBlackBoxProviderParityRecipe({
        providerMode: 'browser-rallar',
        apiBaseUrl,
        actor,
        roomId: group.groupId,
        connection,
        rallar: {
            apiBaseUrl,
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            scope: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
            },
            roomRef,
            restoreSession: true,
        },
        control: {
            providerMode: 'browser-rallar',
            parity: true,
        },
    });
    const configureCommand = baseRecipe.commands[0];
    const scopedCommands = baseRecipe.commands.slice(1).map((command): RallarBlackBoxTestCommand => {
        if (command.kind === 'rtc.connect') {
            return {
                ...command,
                actor,
                roomId: group.groupId,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                rallar: {
                    ...command.rallar,
                    apiBaseUrl,
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                    scope: {
                        applicationId: group.applicationId,
                        workspaceId: group.workspaceId,
                    },
                    roomRef,
                    restoreSession: true,
                },
            };
        }
        if (command.kind === 'rtc.send') {
            const send = command.send && typeof command.send === 'object' && !Array.isArray(command.send)
                ? command.send
                : {};
            return {
                ...command,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                send: {
                    ...send,
                    roomId: group.groupId,
                    roomRef,
                },
            };
        }
        return command;
    });

    return {
        ...baseRecipe,
        metadata: {
            ...baseRecipe.metadata,
            group,
            selfContainedSetup: true,
        },
        commands: [
            configureCommand,
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'parity',
                requestPrefix: 'provider-parity',
                group,
                actor,
            }),
            ...scopedCommands,
        ],
    };
}

export function createRallarBlackBoxRtcRealtimeRecipe(
    options: RallarBlackBoxRtcRealtimeRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const durationSeconds = normalizeRallarBlackBoxRtcRealtimeDurationSeconds(options.durationSeconds);
    const frameCount = durationSeconds * RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;
    const connection = options.connection ?? 'rtcRealtime';
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const sendCommand: RallarBlackBoxTestCommand = {
        kind: 'rtc.send',
        commandId: 'rtc-realtime-position',
        connection,
        transport: 'realtime',
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomRef,
        timeoutMs: 3_000,
        metadata: {
            realtime: {
                rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                durationSeconds,
                frame: '{loop.iteration}',
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
                seq: '{loop.index}',
                rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                durationSeconds,
                totalFrames: frameCount,
                tMs: '{loop.elapsedMs}',
                position: {
                    frame: '{loop.iteration}',
                    x: '{loop.index}',
                    y: 0,
                    z: '{loop.index}',
                    headingDeg: '{loop.index}',
                    velocityMps: 4,
                },
            },
        },
    };
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
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'rtc-realtime',
                requestPrefix: 'rtc-realtime',
                group,
                actor: '{auth.clientId}',
            }),
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
            {
                kind: 'loop',
                commandId: 'rtc-realtime-position-loop',
                count: frameCount,
                intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                maxCommands: frameCount,
                continueOnFailure: false,
                metadata: {
                    realtime: {
                        rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                        intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
                        durationSeconds,
                        frameCount,
                    },
                },
                commands: [sendCommand],
            },
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
        recipe: createRallarBlackBoxRtcSmokeRecipe(),
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
        recipe: createRallarBlackBoxProviderParityLiveRecipe(),
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
        label: 'RTC Realtime',
        description: 'Sends game-style position updates over RTC at 20 Hz for a configurable duration.',
        recipe: createRallarBlackBoxRtcRealtimeRecipe(),
    },
    {
        fixtureId: 'composite-evidence',
        label: 'Composite Evidence',
        description: 'Runs loop, parallel, wait, and assert commands against local browser-agent evidence.',
        recipe: {
            recipeId: 'composite-evidence-recipe',
            name: 'Composite evidence recipe',
            description: 'Validates composite command authoring without requiring live Rallar services.',
            continueOnFailure: false,
            metadata: {
                profile: 'composite',
                primitives: ['loop', 'parallel', 'wait', 'assert'],
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
                            label: 'Loop health',
                        },
                    ],
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
                                    commandId: 'parallel-left-health',
                                },
                            ],
                        },
                        {
                            groupId: 'right-stats',
                            commands: [
                                {
                                    kind: 'stats',
                                    commandId: 'parallel-right-stats',
                                },
                            ],
                        },
                    ],
                },
                {
                    kind: 'wait',
                    commandId: 'wait-for-parallel-result',
                    timeoutMs: 1_000,
                    match: {
                        kind: 'result',
                        commandId: 'parallel-evidence',
                        payloadPath: 'ok',
                        equals: true,
                    },
                },
                {
                    kind: 'assert',
                    commandId: 'assert-wait-succeeded',
                    source: 'lastResult.ok',
                    operator: 'equals',
                    expected: true,
                },
                {
                    kind: 'stats',
                    commandId: 'composite-evidence-stats',
                },
            ],
        },
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
