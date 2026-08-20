import { createRallarBlackBoxProviderParityRecipe } from './provider-parity.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from './types.ts';
import type { RallarBlackBoxDistributedGroupRef } from './distributed-run.ts';

export type RallarBlackBoxRecipeFixture = Readonly<{
    fixtureId: string;
    label: string;
    description: string;
    recipe: RallarBlackBoxTestRecipe;
}>;

export const RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID = 'rtc-realtime';
export const RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID = 'rtc-realtime-stability';
export const RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ = 20;
export const RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS =
    Math.round(1_000 / RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ);
export const RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS = 5;
export const RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS = 1;
export const RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS = 3_600;
export const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID =
    'rtc-messages-principal-multicast-sender';
export const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID =
    'rtc-messages-principal-multicast-receiver';
export const RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID =
    'rtc-messages-all-peer-multicast';
const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS = 5_000;
const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS = 1_000;
const RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS = 5_000;
const RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS = 1_000;
const RALLAR_BLACK_BOX_LIVE_API_BASE_URL = 'https://api.rallar.intactss.com';
const RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS = 5_000;

export type RallarBlackBoxRtcRealtimeRecipeOptions = Readonly<{
    durationSeconds?: number;
    rateHz?: number;
    group?: RallarBlackBoxDistributedGroupRef;
    connection?: string;
    readyPeerCount?: number;
    readyTimeoutMs?: number;
    executionMode?: 'loop' | 'stream';
    stream?: Readonly<{
        maxInFlight?: number;
        drainTimeoutMs?: number;
        progressEveryMs?: number;
        sampleEvery?: number;
        maxDroppedFrames?: number;
        maxP95SendDurationMs?: number;
        maxP99SendDurationMs?: number;
        minSendSuccessRatio?: number;
        continueOnSendFailure?: boolean;
    }>;
}>;

export type RallarBlackBoxLiveRecipeOptions = Readonly<{
    group?: RallarBlackBoxDistributedGroupRef;
    apiBaseUrl?: string;
    actor?: string;
    connection?: string;
    readyPeerCount?: number;
    readyTimeoutMs?: number;
}>;

export type RallarBlackBoxRtcMessagesMulticastRecipeOptions = Readonly<{
    participantCount?: number;
    durationSeconds?: number;
    rateHz?: number;
    minReceiveRatio?: number;
    group?: RallarBlackBoxDistributedGroupRef;
    connection?: string;
    readyTimeoutMs?: number;
    stream?: Readonly<{
        maxInFlight?: number;
        drainTimeoutMs?: number;
        progressEveryMs?: number;
        sampleEvery?: number;
        maxDroppedFrames?: number;
        minSendSuccessRatio?: number;
        maxP95SendDurationMs?: number;
        maxP99SendDurationMs?: number;
        continueOnSendFailure?: boolean;
    }>;
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

function normalizeRallarBlackBoxRtcRealtimeRateHz(value: unknown): number {
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseFloat(value)
            : RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;
    }
    return numeric;
}

function normalizePositiveInteger(value: unknown, fallback: number, minimum = 1): number {
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseFloat(value)
            : fallback;
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(minimum, Math.round(numeric));
}

function normalizeRatio(value: unknown, fallback: number): number {
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseFloat(value)
            : fallback;
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(0, Math.min(1, numeric));
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

function rtcConnectReadiness(
    options: Readonly<{
        readyPeerCount?: number;
        readyTimeoutMs?: number;
    }>,
): { minReadyPeers: number; timeoutMs: number; intervalMs: number } | undefined {
    if (
        typeof options.readyPeerCount !== 'number' ||
        !Number.isFinite(options.readyPeerCount) ||
        options.readyPeerCount <= 0
    ) {
        return undefined;
    }

    return {
        minReadyPeers: Math.max(1, Math.round(options.readyPeerCount)),
        timeoutMs: typeof options.readyTimeoutMs === 'number' && Number.isFinite(options.readyTimeoutMs)
            ? Math.max(1, Math.round(options.readyTimeoutMs))
            : 5_000,
        intervalMs: 100,
    };
}

function computeRtcConnectCommandTimeoutMs(
    options: Readonly<{
        readyPeerCount?: number;
        readyTimeoutMs?: number;
    }>,
    fallbackTimeoutMs: number,
): number {
    const readiness = rtcConnectReadiness(options);
    return readiness === undefined
        ? fallbackTimeoutMs
        : readiness.timeoutMs + RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS;
}

function multicastDeliveryPlan(options: Readonly<{
    participantCount?: number;
    senderCount: number;
    durationSeconds?: number;
    rateHz?: number;
    minReceiveRatio?: number;
}>): Readonly<{
    participantCount: number;
    senderCount: number;
    receiverCount: number;
    rateHz: number;
    intervalMs: number;
    durationSeconds: number;
    frameCount: number;
    expectedInboundMessages: number;
    minExpectedInboundMessages: number;
    minReceiveRatio: number;
    logicalFanoutMessages: number;
}> {
    const participantCount = normalizePositiveInteger(options.participantCount, 50, 2);
    const senderCount = Math.min(participantCount, normalizePositiveInteger(options.senderCount, 1, 1));
    const rateHz = normalizeRallarBlackBoxRtcRealtimeRateHz(options.rateHz);
    const intervalMs = Math.max(1, Math.round(1_000 / rateHz));
    const durationSeconds = normalizeRallarBlackBoxRtcRealtimeDurationSeconds(options.durationSeconds);
    const frameCount = Math.max(1, Math.round(durationSeconds * rateHz));
    const receiverCount = senderCount === participantCount
        ? participantCount
        : Math.max(0, participantCount - senderCount);
    const expectedInboundMessages = frameCount * Math.max(0, senderCount === participantCount
        ? participantCount - 1
        : senderCount);
    const minReceiveRatio = normalizeRatio(options.minReceiveRatio, senderCount === participantCount ? 0.9 : 0.95);
    const minExpectedInboundMessages = Math.floor(expectedInboundMessages * minReceiveRatio);
    const logicalFanoutMessages = frameCount * senderCount * Math.max(0, participantCount - 1);

    return {
        participantCount,
        senderCount,
        receiverCount,
        rateHz,
        intervalMs,
        durationSeconds,
        frameCount,
        expectedInboundMessages,
        minExpectedInboundMessages,
        minReceiveRatio,
        logicalFanoutMessages,
    };
}

const RALLAR_BLACK_BOX_GROUP_MULTICAST_POSITION_SELECTOR = {
    typeId: 'black-box.group.multicast.position',
    topicId: 'black-box.group.multicast.position',
} as const;

function messagesRtcConnectCommand(options: Readonly<{
    commandId: string;
    connection: string;
    group: RallarBlackBoxDistributedGroupRef;
    minReadyPeers: number;
    readyTimeoutMs?: number;
    metadata: Readonly<Record<string, unknown>>;
}>): RallarBlackBoxTestCommand {
    const roomRef = groupRoomRef(options.group);
    const readinessTimeoutMs = options.readyTimeoutMs ?? 45_000;
    return {
        kind: 'rtc.connect',
        commandId: options.commandId,
        connection: options.connection,
        actor: '{auth.clientId}',
        roomId: options.group.groupId,
        applicationId: options.group.applicationId,
        workspaceId: options.group.workspaceId,
        roomRef,
        transport: 'messages.rtc',
        rallar: { ...RALLAR_BLACK_BOX_GROUP_MULTICAST_POSITION_SELECTOR },
        timeoutMs: readinessTimeoutMs + RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS,
        readiness: {
            minReadyPeers: options.minReadyPeers,
            timeoutMs: readinessTimeoutMs,
            intervalMs: 100,
        },
        metadata: options.metadata,
    };
}

function messagesRtcStreamCommand(options: Readonly<{
    commandId: string;
    connection: string;
    group: RallarBlackBoxDistributedGroupRef;
    plan: ReturnType<typeof multicastDeliveryPlan>;
    profile: string;
    stream?: RallarBlackBoxRtcMessagesMulticastRecipeOptions['stream'];
}>): RallarBlackBoxTestCommand {
    const roomRef = groupRoomRef(options.group);
    const continueOnSendFailure = options.stream?.continueOnSendFailure ?? true;
    const receiverDelivery = options.plan.expectedInboundMessages > 0
        ? {
              receiverDelivery: {
                  expectedInboundMessages: options.plan.expectedInboundMessages,
                  minExpectedInboundMessages: options.plan.minExpectedInboundMessages,
                  minReceiveRatio: options.plan.minReceiveRatio,
              },
          }
        : {};
    return {
        kind: 'rtc.stream',
        commandId: options.commandId,
        connection: options.connection,
        actor: '{auth.clientId}',
        transport: 'messages.rtc',
        applicationId: options.group.applicationId,
        workspaceId: options.group.workspaceId,
        roomId: options.group.groupId,
        roomRef,
        count: options.plan.frameCount,
        intervalMs: options.plan.intervalMs,
        maxInFlight: options.stream?.maxInFlight ?? 64,
        drainTimeoutMs: options.stream?.drainTimeoutMs ?? 5_000,
        progressEveryMs: options.stream?.progressEveryMs ?? 1_000,
        sampleEvery: options.stream?.sampleEvery ?? 1,
        continueOnSendFailure,
        thresholds: {
            minSendSuccessRatio: options.stream?.minSendSuccessRatio ?? 0.95,
            maxDroppedFrames: options.stream?.maxDroppedFrames ??
                Math.ceil(options.plan.frameCount * 0.05),
            ...(options.stream?.maxP95SendDurationMs === undefined
                ? {}
                : { maxP95SendDurationMs: options.stream.maxP95SendDurationMs }),
            ...(options.stream?.maxP99SendDurationMs === undefined
                ? {}
                : { maxP99SendDurationMs: options.stream.maxP99SendDurationMs }),
        },
        metadata: {
            profile: options.profile,
            transport: 'messages.rtc',
            rateHz: options.plan.rateHz,
            intervalMs: options.plan.intervalMs,
            durationSeconds: options.plan.durationSeconds,
            frameCount: options.plan.frameCount,
            participantCount: options.plan.participantCount,
            senderCount: options.plan.senderCount,
            receiverCount: options.plan.receiverCount,
            logicalFanoutMessages: options.plan.logicalFanoutMessages,
            ...receiverDelivery,
        },
        send: {
            roomId: options.group.groupId,
            roomRef,
            deliveryMode: 'multicast',
            ...RALLAR_BLACK_BOX_GROUP_MULTICAST_POSITION_SELECTOR,
            payload: {
                topic: RALLAR_BLACK_BOX_GROUP_MULTICAST_POSITION_SELECTOR.topicId,
                typeId: RALLAR_BLACK_BOX_GROUP_MULTICAST_POSITION_SELECTOR.typeId,
                actor: '{auth.clientId}',
                seq: '{stream.index}',
                rateHz: options.plan.rateHz,
                intervalMs: options.plan.intervalMs,
                durationSeconds: options.plan.durationSeconds,
                totalFrames: options.plan.frameCount,
                tMs: '{stream.elapsedMs}',
                position: {
                    frame: '{stream.iteration}',
                    x: '{stream.index}',
                    y: 0,
                    z: '{stream.index}',
                    headingDeg: '{stream.index}',
                    velocityMps: 4,
                },
            },
        },
    };
}

function receiverDeliveryMetadata(
    plan: ReturnType<typeof multicastDeliveryPlan>,
    profile: string,
): Readonly<Record<string, unknown>> {
    return {
        profile,
        transport: 'messages.rtc',
        participantCount: plan.participantCount,
        senderCount: plan.senderCount,
        receiverCount: plan.receiverCount,
        rateHz: plan.rateHz,
        intervalMs: plan.intervalMs,
        durationSeconds: plan.durationSeconds,
        frameCount: plan.frameCount,
        expectedInboundMessages: plan.expectedInboundMessages,
        minExpectedInboundMessages: plan.minExpectedInboundMessages,
        minReceiveRatio: plan.minReceiveRatio,
        logicalFanoutMessages: plan.logicalFanoutMessages,
    };
}

function multicastRunShapeMetadata(
    plan: ReturnType<typeof multicastDeliveryPlan>,
    profile: string,
): Readonly<Record<string, unknown>> {
    const {
        expectedInboundMessages: _expectedInboundMessages,
        minExpectedInboundMessages: _minExpectedInboundMessages,
        minReceiveRatio: _minReceiveRatio,
        ...metadata
    } = receiverDeliveryMetadata(plan, profile);
    return metadata;
}

function topologySafeRtcReadyPeerCount(
    plan: ReturnType<typeof multicastDeliveryPlan>,
): number {
    return plan.participantCount > 1 ? 1 : 0;
}

export function createRallarBlackBoxEnsureGroupRequestId(input: Readonly<{
    requestPrefix: string;
    group: RallarBlackBoxDistributedGroupRef;
}>): string {
    return ensureGroupRequestId(input.requestPrefix, 'group');
}

function ensureGroupRequestId(
    requestPrefix: string,
    operation: 'group' | 'member',
): string {
    return `${requestPrefix}-ensure-${operation}-{runId}`;
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
    const groupRequestKey = createRallarBlackBoxEnsureGroupRequestId(input);
    const memberRequestKey = ensureGroupRequestId(input.requestPrefix, 'member');

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
                path: `${groupStatePath}/requests/${groupRequestKey}`,
                body: {
                    groupId: input.group.groupId,
                    displayName: input.group.groupId,
                    kind: 'room',
                    joinMode: 'open',
                },
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200, 201, 409],
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
                path: `${groupMemberPath}/requests/${memberRequestKey}`,
                body: {
                    status: 'active',
                },
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200, 201],
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
                timeoutMs: computeRtcConnectCommandTimeoutMs(options, 5_000),
                readiness: rtcConnectReadiness(options),
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
        includeDemoAuth: false,
        apiBaseUrl,
        actor,
        roomId: group.groupId,
        connection,
        directPeerIds: ['{rtc.readyPeerIds[0]}'],
        multicastPeerIds: ['{rtc.readyPeerIds}'],
        rallar: {
            apiBaseUrl,
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            scope: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
            },
            roomRef,
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
                timeoutMs: computeRtcConnectCommandTimeoutMs(options, command.timeoutMs ?? 5_000),
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
                },
                readiness: rtcConnectReadiness(options),
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

export function createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes(
    options: RallarBlackBoxRtcMessagesMulticastRecipeOptions = {},
): readonly [RallarBlackBoxTestRecipe, RallarBlackBoxTestRecipe] {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const connection = options.connection ?? 'rtcMessagesPrincipal';
    const receiverPlan = multicastDeliveryPlan({
        participantCount: options.participantCount,
        senderCount: 1,
        durationSeconds: options.durationSeconds ?? 30,
        rateHz: options.rateHz ?? 20,
        minReceiveRatio: options.minReceiveRatio ?? 0.95,
    });
    const senderPlan = {
        ...receiverPlan,
        expectedInboundMessages: 0,
        minExpectedInboundMessages: 0,
    };
    const roomRef = groupRoomRef(group);
    const baseSetupCommands = createRallarBlackBoxEnsureGroupCommands({
        commandPrefix: 'rtc-messages-principal',
        requestPrefix: 'rtc-messages-principal',
        group,
        actor: '{auth.clientId}',
    });
    const {
        expectedInboundMessages: _senderExpectedInboundMessages,
        minExpectedInboundMessages: _senderMinExpectedInboundMessages,
        minReceiveRatio: _senderMinReceiveRatio,
        ...senderMetadata
    } = receiverDeliveryMetadata(
        senderPlan,
        'rtc-messages-principal-multicast-sender',
    );
    const receiverMetadata = receiverDeliveryMetadata(
        receiverPlan,
        'rtc-messages-principal-multicast-receiver',
    );

    const sender: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
        name: 'RTC messages principal multicast sender',
        description:
            `Connect RTC messages and multicast ${receiverPlan.frameCount} principal frames at ${receiverPlan.rateHz} Hz.`,
        continueOnFailure: false,
        metadata: senderMetadata,
        commands: [
            ...baseSetupCommands,
            messagesRtcConnectCommand({
                commandId: 'rtc-messages-principal-sender-connect',
                connection,
                group,
                minReadyPeers: topologySafeRtcReadyPeerCount(receiverPlan),
                readyTimeoutMs: options.readyTimeoutMs,
                metadata: senderMetadata,
            }),
            {
                kind: 'loop',
                commandId: 'rtc-messages-principal-sender-warmup-stats-loop',
                count: Math.ceil(
                    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS /
                        RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS,
                ) + 1,
                intervalMs: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS,
                maxCommands: Math.ceil(
                    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS /
                        RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS,
                ) + 1,
                metadata: {
                    ...senderMetadata,
                    purpose: 'post-connect-receiver-settle',
                    warmupDurationMs: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS,
                },
                commands: [
                    {
                        kind: 'stats',
                        commandId: 'rtc-messages-principal-sender-warmup-stats',
                        metadata: senderMetadata,
                    },
                ],
            },
            messagesRtcStreamCommand({
                commandId: 'rtc-messages-principal-multicast-stream',
                connection,
                group,
                plan: senderPlan,
                profile: 'rtc-messages-principal-multicast-sender',
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                    ...options.stream,
                },
            }),
            {
                kind: 'stats',
                commandId: 'rtc-messages-principal-sender-final-stats',
                metadata: senderMetadata,
            },
        ],
    };

    const receiverHoldSeconds = Math.max(1, receiverPlan.durationSeconds + 5);
    const receiverHoldMs = receiverHoldSeconds * 1_000;
    const receiverStatsIntervalMs = receiverHoldMs > 2_000 ? 5_000 : 1_000;
    const receiverStatsLoopCount = Math.ceil(receiverHoldMs / receiverStatsIntervalMs) + 1;
    const receiver: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
        name: 'RTC messages principal multicast receiver',
        description:
            `Connect RTC messages, hold for ${receiverPlan.durationSeconds}s, and assert principal multicast delivery.`,
        continueOnFailure: false,
        metadata: receiverMetadata,
        commands: [
            ...baseSetupCommands,
            messagesRtcConnectCommand({
                commandId: 'rtc-messages-principal-receiver-connect',
                connection,
                group,
                minReadyPeers: 1,
                readyTimeoutMs: options.readyTimeoutMs,
                metadata: receiverMetadata,
            }),
            {
                kind: 'loop',
                commandId: 'rtc-messages-principal-receiver-stats-loop',
                count: receiverStatsLoopCount,
                intervalMs: receiverStatsIntervalMs,
                maxCommands: receiverStatsLoopCount,
                metadata: receiverMetadata,
                commands: [
                    {
                        kind: 'stats',
                        commandId: 'rtc-messages-principal-receiver-stats',
                        metadata: receiverMetadata,
                    },
                ],
            },
            {
                kind: 'stats',
                commandId: 'rtc-messages-principal-receiver-final-stats',
                metadata: receiverMetadata,
            },
            {
                kind: 'assert',
                commandId: 'rtc-messages-principal-receiver-delivery-threshold',
                source: 'stats.counters.messages',
                operator: 'gte',
                expected: receiverPlan.minExpectedInboundMessages,
                metadata: {
                    ...receiverMetadata,
                    receiverDelivery: {
                        expectedInboundMessages: receiverPlan.expectedInboundMessages,
                        minExpectedInboundMessages: receiverPlan.minExpectedInboundMessages,
                        minReceiveRatio: receiverPlan.minReceiveRatio,
                    },
                    roomRef,
                },
            },
        ],
    };

    return [sender, receiver];
}

export function createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe(
    options: RallarBlackBoxRtcMessagesMulticastRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const connection = options.connection ?? 'rtcMessagesAllPeer';
    const participantCount = normalizePositiveInteger(options.participantCount, 50, 2);
    const plan = multicastDeliveryPlan({
        participantCount,
        senderCount: participantCount,
        durationSeconds: options.durationSeconds ?? 30,
        rateHz: options.rateHz ?? 5,
        minReceiveRatio: options.minReceiveRatio ?? 0.9,
    });
    const metadata = receiverDeliveryMetadata(plan, 'rtc-messages-all-peer-multicast');
    const settleMetadata = multicastRunShapeMetadata(plan, 'rtc-messages-all-peer-multicast');

    return {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
        name: 'RTC messages all-peer multicast',
        description:
            `Connect RTC messages and multicast from every peer at ${plan.rateHz} Hz for ${plan.durationSeconds}s.`,
        continueOnFailure: false,
        metadata,
        commands: [
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'rtc-messages-all-peer',
                requestPrefix: 'rtc-messages-all-peer',
                group,
                actor: '{auth.clientId}',
            }),
            messagesRtcConnectCommand({
                commandId: 'rtc-messages-all-peer-connect',
                connection,
                group,
                minReadyPeers: topologySafeRtcReadyPeerCount(plan),
                readyTimeoutMs: options.readyTimeoutMs,
                metadata,
            }),
            {
                kind: 'loop',
                commandId: 'rtc-messages-all-peer-settle-stats-loop',
                count: Math.ceil(
                    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS /
                        RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS,
                ) + 1,
                intervalMs: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS,
                maxCommands: Math.ceil(
                    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS /
                        RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS,
                ) + 1,
                metadata: {
                    ...settleMetadata,
                    purpose: 'post-connect-topology-settle',
                    settleDurationMs: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS,
                },
                commands: [
                    {
                        kind: 'stats',
                        commandId: 'rtc-messages-all-peer-settle-stats',
                        metadata: settleMetadata,
                    },
                ],
            },
            messagesRtcStreamCommand({
                commandId: 'rtc-messages-all-peer-multicast-stream',
                connection,
                group,
                plan,
                profile: 'rtc-messages-all-peer-multicast',
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                    ...options.stream,
                },
            }),
            {
                kind: 'loop',
                commandId: 'rtc-messages-all-peer-receiver-stats-loop',
                count: 5,
                intervalMs: 1_000,
                maxCommands: 5,
                metadata,
                commands: [
                    {
                        kind: 'stats',
                        commandId: 'rtc-messages-all-peer-receiver-stats',
                        metadata,
                    },
                ],
            },
            {
                kind: 'stats',
                commandId: 'rtc-messages-all-peer-final-stats',
                metadata,
            },
            {
                kind: 'assert',
                commandId: 'rtc-messages-all-peer-delivery-threshold',
                source: 'stats.counters.messages',
                operator: 'gte',
                expected: plan.minExpectedInboundMessages,
                metadata: {
                    ...metadata,
                    receiverDelivery: {
                        expectedInboundMessages: plan.expectedInboundMessages,
                        minExpectedInboundMessages: plan.minExpectedInboundMessages,
                        minReceiveRatio: plan.minReceiveRatio,
                    },
                },
            },
        ],
    };
}

export function createRallarBlackBoxRtcRealtimeRecipe(
    options: RallarBlackBoxRtcRealtimeRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const durationSeconds = normalizeRallarBlackBoxRtcRealtimeDurationSeconds(options.durationSeconds);
    const rateHz = normalizeRallarBlackBoxRtcRealtimeRateHz(options.rateHz);
    const intervalMs = Math.max(1, Math.round(1_000 / rateHz));
    const frameCount = Math.max(1, Math.round(durationSeconds * rateHz));
    const connection = options.connection ?? 'rtcRealtime';
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const executionMode = options.executionMode ?? 'loop';
    const continueOnStreamSendFailure = options.stream?.continueOnSendFailure ??
        ((options.stream?.maxDroppedFrames ?? 0) > 0 ? true : undefined);
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
                rateHz,
                intervalMs,
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
                rateHz,
                intervalMs,
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
    const streamCommand: RallarBlackBoxTestCommand = {
        kind: 'rtc.stream',
        commandId: 'rtc-realtime-position-stream',
        connection,
        actor: '{auth.clientId}',
        transport: 'realtime',
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        roomId: group.groupId,
        roomRef,
        count: frameCount,
        intervalMs,
        maxInFlight: options.stream?.maxInFlight ?? 64,
        drainTimeoutMs: options.stream?.drainTimeoutMs ?? 5_000,
        progressEveryMs: options.stream?.progressEveryMs ?? 1_000,
        sampleEvery: options.stream?.sampleEvery ?? 1,
        ...(continueOnStreamSendFailure === undefined
            ? {}
            : { continueOnSendFailure: continueOnStreamSendFailure }),
        thresholds: {
            minSendSuccessRatio: options.stream?.minSendSuccessRatio ?? 0.99,
            maxDroppedFrames: options.stream?.maxDroppedFrames ?? 0,
            ...(options.stream?.maxP95SendDurationMs === undefined
                ? {}
                : { maxP95SendDurationMs: options.stream.maxP95SendDurationMs }),
            ...(options.stream?.maxP99SendDurationMs === undefined
                ? {}
                : { maxP99SendDurationMs: options.stream.maxP99SendDurationMs }),
        },
        metadata: {
            realtime: {
                rateHz,
                intervalMs,
                durationSeconds,
                frameCount,
                executionMode: 'stream',
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
                seq: '{stream.index}',
                rateHz,
                intervalMs,
                durationSeconds,
                totalFrames: frameCount,
                tMs: '{stream.elapsedMs}',
                position: {
                    frame: '{stream.iteration}',
                    x: '{stream.index}',
                    y: 0,
                    z: '{stream.index}',
                    headingDeg: '{stream.index}',
                    velocityMps: 4,
                },
            },
        },
    };
    return {
        recipeId: RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
        name: 'RTC realtime position stream',
        description: `Connect RTC and send game-style position updates at ${rateHz} Hz for the configured duration.`,
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-realtime',
            rateHz,
            intervalMs,
            durationSeconds,
            frameCount,
            executionMode,
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
                timeoutMs: computeRtcConnectCommandTimeoutMs(options, 10_000),
                readiness: rtcConnectReadiness(options),
                metadata: {
                    realtime: {
                        rateHz,
                        durationSeconds,
                        frameCount,
                    },
                },
            },
            executionMode === 'stream'
                ? streamCommand
                : {
                    kind: 'loop',
                    commandId: 'rtc-realtime-position-loop',
                    count: frameCount,
                    intervalMs,
                    maxCommands: frameCount,
                    continueOnFailure: false,
                    metadata: {
                        realtime: {
                            rateHz,
                            intervalMs,
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
                        rateHz,
                        durationSeconds,
                        frameCount,
                    },
                },
            },
        ],
    };
}

export function createRallarBlackBoxRtcRealtimeStabilityRecipe(
    options: RallarBlackBoxRtcRealtimeRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const recipe = createRallarBlackBoxRtcRealtimeRecipe({
        ...options,
        durationSeconds: options.durationSeconds ?? 5,
        rateHz: options.rateHz ?? 5,
        executionMode: options.executionMode ?? 'stream',
        stream: {
            maxInFlight: 8,
            maxDroppedFrames: 2,
            minSendSuccessRatio: 0.95,
            continueOnSendFailure: true,
            ...options.stream,
        },
    });

    return {
        ...recipe,
        recipeId: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
        name: 'RTC realtime stability stream',
        description:
            'Connect RTC and send a lower-rate stream intended as a green realtime stability baseline.',
        metadata: {
            ...recipe.metadata,
            profile: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
        },
    };
}

export const RALLAR_BLACK_BOX_RECIPE_FIXTURES: readonly RallarBlackBoxRecipeFixture[] = [
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
        label: 'RTC Messages Principal Sender',
        description: 'Principal headless authority multicasts RTC messages to a larger group.',
        recipe: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes()[0],
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
        label: 'RTC Messages Principal Receiver',
        description: 'Receiver role for principal RTC messages multicast delivery checks.',
        recipe: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes()[1],
    },
    {
        fixtureId: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
        label: 'RTC Messages All-Peer Multicast',
        description: 'Every peer multicasts RTC messages and asserts inbound delivery.',
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe(),
    },
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
        fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
        label: 'RTC Realtime Stability',
        description: 'Lower-risk 5 Hz RTC realtime stream for green stability checks.',
        recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe(),
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

export function recipeFixtureText(fixtureId: string): string {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
        entry.fixtureId === fixtureId
    ) ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];
    return JSON.stringify(fixture.recipe, null, 2);
}
