import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import {
    createRallarBlackBoxEnsureGroupCommands,
    defaultRallarBlackBoxGroup,
    groupRoomRef,
    RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS
} from './live-rtc-setup.ts';
import {
    normalizeRallarBlackBoxRtcRealtimeDurationSeconds,
    normalizeRallarBlackBoxRtcRealtimeRateHz
} from './rtc-realtime-recipes.ts';

export const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID =
    'rtc-messages-principal-multicast-sender';

export const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID =
    'rtc-messages-principal-multicast-receiver';

export const RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID = 'rtc-messages-all-peer-multicast';

const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS = 5_000;

const RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS = 1_000;

const RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS = 5_000;

const RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS = 1_000;

export interface RallarBlackBoxRtcMessagesMulticastRecipeOptions {
    readonly participantCount?: number;
    readonly durationSeconds?: number;
    readonly rateHz?: number;
    readonly minReceiveRatio?: number;
    readonly group?: RallarBlackBoxDistributedGroupRef;
    readonly connection?: string;
    readonly readyTimeoutMs?: number;
    readonly stream?: Readonly<{
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

function multicastDeliveryPlan(
    options: Readonly<{
        participantCount?: number;
        senderCount: number;
        durationSeconds?: number;
        rateHz?: number;
        minReceiveRatio?: number;
    }>
): MulticastDeliveryPlan {
    const participantCount = normalizePositiveInteger(options.participantCount, 50, 2);
    const senderCount = Math.min(
        participantCount,
        normalizePositiveInteger(options.senderCount, 1, 1)
    );
    const rateHz = normalizeRallarBlackBoxRtcRealtimeRateHz(options.rateHz);
    const intervalMs = Math.max(1, Math.round(1_000 / rateHz));
    const durationSeconds = normalizeRallarBlackBoxRtcRealtimeDurationSeconds(
        options.durationSeconds
    );
    const frameCount = Math.max(1, Math.round(durationSeconds * rateHz));
    const receiverCount = senderCount === participantCount
        ? participantCount
        : Math.max(0, participantCount - senderCount);
    const expectedInboundMessages = frameCount * Math.max(
        0,
        senderCount === participantCount
            ? participantCount - 1
            : senderCount
    );
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
        logicalFanoutMessages
    };
}

const RALLAR_BLACK_BOX_GROUP_MULTICAST_POSITION_SELECTOR = {
    typeId: 'black-box.group.multicast.position',
    topicId: 'black-box.group.multicast.position'
} as const;

function messagesRtcConnectCommand(
    options: Readonly<{
        commandId: string;
        connection: string;
        group: RallarBlackBoxDistributedGroupRef;
        minReadyPeers: number;
        readyTimeoutMs?: number;
        metadata: Readonly<Record<string, unknown>>;
    }>
): RallarBlackBoxTestCommand {
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
            intervalMs: 100
        },
        metadata: options.metadata
    };
}

function messagesRtcStreamCommand(
    options: MulticastStreamInput
): RallarBlackBoxTestCommand {
    const roomRef = groupRoomRef(options.group);
    const continueOnSendFailure = options.stream?.continueOnSendFailure ?? true;
    const receiverDelivery = options.plan.expectedInboundMessages > 0
        ? {
            receiverDelivery: {
                expectedInboundMessages: options.plan.expectedInboundMessages,
                minExpectedInboundMessages: options.plan.minExpectedInboundMessages,
                minReceiveRatio: options.plan.minReceiveRatio
            }
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
                : { maxP99SendDurationMs: options.stream.maxP99SendDurationMs })
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
            ...receiverDelivery
        },
        send: toMulticastPositionPayload(options)
    };
}

function receiverDeliveryMetadata(
    plan: MulticastDeliveryPlan,
    profile: string
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
        logicalFanoutMessages: plan.logicalFanoutMessages
    };
}

function multicastRunShapeMetadata(
    plan: MulticastDeliveryPlan,
    profile: string
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
    plan: MulticastDeliveryPlan
): number {
    return plan.participantCount > 1 ? 1 : 0;
}

export function createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes(
    options: RallarBlackBoxRtcMessagesMulticastRecipeOptions = {}
): readonly [RallarBlackBoxTestRecipe, RallarBlackBoxTestRecipe] {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const connection = options.connection ?? 'rtcMessagesPrincipal';
    const receiverPlan = multicastDeliveryPlan({
        participantCount: options.participantCount,
        senderCount: 1,
        durationSeconds: options.durationSeconds ?? 30,
        rateHz: options.rateHz ?? 20,
        minReceiveRatio: options.minReceiveRatio ?? 0.95
    });
    const senderPlan = { ...receiverPlan, expectedInboundMessages: 0, minExpectedInboundMessages: 0 };
    const baseSetupCommands = createRallarBlackBoxEnsureGroupCommands({
        commandPrefix: 'rtc-messages-principal',
        requestPrefix: 'rtc-messages-principal',
        group,
        actor: '{auth.clientId}'
    });
    const context = { options, group, connection, baseSetupCommands };
    return [
        toPrincipalSenderRecipe({
            ...context,
            plan: senderPlan,
            metadata: multicastRunShapeMetadata(senderPlan, 'rtc-messages-principal-multicast-sender')
        }),
        toPrincipalReceiverRecipe({
            ...context,
            plan: receiverPlan,
            metadata: receiverDeliveryMetadata(receiverPlan, 'rtc-messages-principal-multicast-receiver')
        })
    ];
}

export function createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe(
    options: RallarBlackBoxRtcMessagesMulticastRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const connection = options.connection ?? 'rtcMessagesAllPeer';
    const participantCount = normalizePositiveInteger(options.participantCount, 50, 2);
    const plan = multicastDeliveryPlan({
        participantCount,
        senderCount: participantCount,
        durationSeconds: options.durationSeconds ?? 30,
        rateHz: options.rateHz ?? 5,
        minReceiveRatio: options.minReceiveRatio ?? 0.9
    });
    const metadata = receiverDeliveryMetadata(plan, 'rtc-messages-all-peer-multicast');
    const settleMetadata = multicastRunShapeMetadata(plan, 'rtc-messages-all-peer-multicast');

    return toAllPeerRecipe({
        options,
        group,
        connection,
        plan,
        metadata,
        baseSetupCommands: createRallarBlackBoxEnsureGroupCommands({
            commandPrefix: 'rtc-messages-all-peer',
            requestPrefix: 'rtc-messages-all-peer',
            group,
            actor: '{auth.clientId}'
        })
    }, settleMetadata);
}

interface MulticastDeliveryPlan {
    readonly participantCount: number;
    readonly senderCount: number;
    readonly receiverCount: number;
    readonly rateHz: number;
    readonly intervalMs: number;
    readonly durationSeconds: number;
    readonly frameCount: number;
    readonly expectedInboundMessages: number;
    readonly minExpectedInboundMessages: number;
    readonly minReceiveRatio: number;
    readonly logicalFanoutMessages: number;
}
interface MulticastStreamInput {
    readonly commandId: string;
    readonly connection: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly plan: MulticastDeliveryPlan;
    readonly profile: string;
    readonly stream?: RallarBlackBoxRtcMessagesMulticastRecipeOptions['stream'];
}

function toMulticastPositionPayload(options: MulticastStreamInput): Readonly<Record<string, unknown>> {
    const roomRef = groupRoomRef(options.group);
    return {
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
                velocityMps: 4
            }
        }
    };
}

interface MulticastStatsLoopInput {
    readonly commandId: string;
    readonly count: number;
    readonly intervalMs: number;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly childCommandId: string;
    readonly childMetadata: Readonly<Record<string, unknown>>;
}

function toMulticastStatsLoop(input: MulticastStatsLoopInput): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: input.commandId,
        count: input.count,
        intervalMs: input.intervalMs,
        maxCommands: input.count,
        metadata: input.metadata,
        commands: [{ kind: 'stats', commandId: input.childCommandId, metadata: input.childMetadata }]
    };
}

interface MulticastRecipeContext {
    readonly options: RallarBlackBoxRtcMessagesMulticastRecipeOptions;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly connection: string;
    readonly plan: MulticastDeliveryPlan;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly baseSetupCommands: readonly RallarBlackBoxTestCommand[];
}

function toPrincipalSenderRecipe(context: MulticastRecipeContext): RallarBlackBoxTestRecipe {
    const { options, group, connection, plan, metadata, baseSetupCommands } = context;
    return {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
        name: 'RTC messages principal multicast sender',
        description: 'Connect RTC messages and multicast ' +
            `${plan.frameCount} principal frames at ${plan.rateHz} Hz.`,
        continueOnFailure: false,
        metadata: metadata,
        commands: [
            ...baseSetupCommands,
            messagesRtcConnectCommand({
                commandId: 'rtc-messages-principal-sender-connect',
                connection,
                group,
                minReadyPeers: topologySafeRtcReadyPeerCount(plan),
                readyTimeoutMs: options.readyTimeoutMs,
                metadata: metadata
            }),
            toMulticastStatsLoop({
                commandId: 'rtc-messages-principal-sender-warmup-stats-loop',
                count: Math.ceil(
                    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS /
                        RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS
                ) + 1,
                intervalMs: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_INTERVAL_MS,
                metadata: {
                    ...metadata,
                    purpose: 'post-connect-receiver-settle',
                    warmupDurationMs: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_SENDER_WARMUP_DURATION_MS
                },
                childCommandId: 'rtc-messages-principal-sender-warmup-stats',
                childMetadata: metadata
            }),
            messagesRtcStreamCommand({
                commandId: 'rtc-messages-principal-multicast-stream',
                connection,
                group,
                plan: plan,
                profile: 'rtc-messages-principal-multicast-sender',
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                    ...options.stream
                }
            }),
            {
                kind: 'stats',
                commandId: 'rtc-messages-principal-sender-final-stats',
                metadata: metadata
            }
        ]
    };
}

function toPrincipalReceiverRecipe(context: MulticastRecipeContext): RallarBlackBoxTestRecipe {
    const { options, group, connection, plan, metadata, baseSetupCommands } = context;
    const roomRef = groupRoomRef(group);
    const receiverHoldMs = Math.max(1, plan.durationSeconds + 5) * 1000;
    const receiverStatsIntervalMs = receiverHoldMs > 2000 ? 5000 : 1000;
    const receiverStatsLoopCount = Math.ceil(receiverHoldMs / receiverStatsIntervalMs) + 1;
    return {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
        name: 'RTC messages principal multicast receiver',
        description: `Connect RTC messages, hold for ${plan.durationSeconds}s, ` +
            'and assert principal multicast delivery.',
        continueOnFailure: false,
        metadata: metadata,
        commands: [
            ...baseSetupCommands,
            messagesRtcConnectCommand({
                commandId: 'rtc-messages-principal-receiver-connect',
                connection,
                group,
                minReadyPeers: 1,
                readyTimeoutMs: options.readyTimeoutMs,
                metadata: metadata
            }),
            toMulticastStatsLoop({
                commandId: 'rtc-messages-principal-receiver-stats-loop',
                count: receiverStatsLoopCount,
                intervalMs: receiverStatsIntervalMs,
                metadata: metadata,
                childCommandId: 'rtc-messages-principal-receiver-stats',
                childMetadata: metadata
            }),
            {
                kind: 'stats',
                commandId: 'rtc-messages-principal-receiver-final-stats',
                metadata: metadata
            },
            toMulticastDeliveryAssertion({
                commandId: 'rtc-messages-principal-receiver-delivery-threshold',
                plan,
                metadata,
                roomRef
            })
        ]
    };
}

function toAllPeerRecipe(
    context: MulticastRecipeContext,
    settleMetadata: Readonly<Record<string, unknown>>
): RallarBlackBoxTestRecipe {
    const { options, group, connection, plan, metadata } = context;
    return {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
        name: 'RTC messages all-peer multicast',
        description: 'Connect RTC messages and multicast from every peer at ' +
            `${plan.rateHz} Hz for ${plan.durationSeconds}s.`,
        continueOnFailure: false,
        metadata,
        commands: [
            ...context.baseSetupCommands,
            messagesRtcConnectCommand({
                commandId: 'rtc-messages-all-peer-connect',
                connection,
                group,
                minReadyPeers: topologySafeRtcReadyPeerCount(plan),
                readyTimeoutMs: options.readyTimeoutMs,
                metadata
            }),
            toAllPeerSettleLoop(settleMetadata),
            messagesRtcStreamCommand({
                commandId: 'rtc-messages-all-peer-multicast-stream',
                connection,
                group,
                plan,
                profile: 'rtc-messages-all-peer-multicast',
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                    ...options.stream
                }
            }),
            toMulticastStatsLoop({
                commandId: 'rtc-messages-all-peer-receiver-stats-loop',
                count: 5,
                intervalMs: 1_000,
                metadata: metadata,
                childCommandId: 'rtc-messages-all-peer-receiver-stats',
                childMetadata: metadata
            }),
            {
                kind: 'stats',
                commandId: 'rtc-messages-all-peer-final-stats',
                metadata
            },
            toMulticastDeliveryAssertion({ commandId: 'rtc-messages-all-peer-delivery-threshold', plan, metadata })
        ]
    };
}

interface MulticastDeliveryAssertionInput {
    readonly commandId: string;
    readonly plan: MulticastDeliveryPlan;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly roomRef?: RallarBlackBoxDistributedGroupRef;
}

function toMulticastDeliveryAssertion(input: MulticastDeliveryAssertionInput): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: input.commandId,
        source: 'stats.counters.messages',
        operator: 'gte',
        expected: input.plan.minExpectedInboundMessages,
        metadata: {
            ...input.metadata,
            receiverDelivery: {
                expectedInboundMessages: input.plan.expectedInboundMessages,
                minExpectedInboundMessages: input.plan.minExpectedInboundMessages,
                minReceiveRatio: input.plan.minReceiveRatio
            },
            ...(input.roomRef ? { roomRef: input.roomRef } : {})
        }
    };
}

function toAllPeerSettleLoop(settleMetadata: Readonly<Record<string, unknown>>): RallarBlackBoxTestCommand {
    return toMulticastStatsLoop({
        commandId: 'rtc-messages-all-peer-settle-stats-loop',
        count: Math.ceil(
            RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS /
                RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS
        ) + 1,
        intervalMs: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_INTERVAL_MS,
        metadata: {
            ...settleMetadata,
            purpose: 'post-connect-topology-settle',
            settleDurationMs: RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_SETTLE_DURATION_MS
        },
        childCommandId: 'rtc-messages-all-peer-settle-stats',
        childMetadata: settleMetadata
    });
}
