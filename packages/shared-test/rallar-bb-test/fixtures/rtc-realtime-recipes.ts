import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import {
    computeRtcConnectCommandTimeoutMs,
    createRallarBlackBoxEnsureGroupCommands,
    defaultRallarBlackBoxGroup,
    groupRoomRef,
    rtcConnectReadiness
} from './live-rtc-setup.ts';

export const RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID = 'rtc-realtime';

export const RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID = 'rtc-realtime-stability';

export const RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ = 20;

export const RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS = Math.round(1_000 / RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ);

export const RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS = 5;

export const RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS = 1;

export const RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS = 3_600;

export interface RallarBlackBoxRtcRealtimeRecipeOptions {
    readonly durationSeconds?: number;
    readonly rateHz?: number;
    readonly group?: RallarBlackBoxDistributedGroupRef;
    readonly connection?: string;
    readonly readyPeerCount?: number;
    readonly readyTimeoutMs?: number;
    readonly executionMode?: 'loop' | 'stream';
    readonly stream?: Readonly<{
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
}

export function normalizeRallarBlackBoxRtcRealtimeDurationSeconds(value: number | string | undefined): number {
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
        Math.max(RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS, Math.round(numeric))
    );
}

export function normalizeRallarBlackBoxRtcRealtimeRateHz(value: number | string | undefined): number {
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

export function createRallarBlackBoxRtcRealtimeRecipe(
    options: RallarBlackBoxRtcRealtimeRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    const durationSeconds = normalizeRallarBlackBoxRtcRealtimeDurationSeconds(
        options.durationSeconds
    );
    const rateHz = normalizeRallarBlackBoxRtcRealtimeRateHz(options.rateHz);
    const intervalMs = Math.max(1, Math.round(1_000 / rateHz));
    const frameCount = Math.max(1, Math.round(durationSeconds * rateHz));
    const connection = options.connection ?? 'rtcRealtime';
    const group = options.group ?? defaultRallarBlackBoxGroup();
    const roomRef = groupRoomRef(group);
    const executionMode = options.executionMode ?? 'loop';
    const context: RealtimeRecipeContext = {
        options,
        durationSeconds,
        rateHz,
        intervalMs,
        frameCount,
        connection,
        group,
        roomRef,
        executionMode
    };
    return toRealtimeRecipe(context);
}

export function createRallarBlackBoxRtcRealtimeStabilityRecipe(
    options: RallarBlackBoxRtcRealtimeRecipeOptions = {}
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
            ...options.stream
        }
    });

    return {
        ...recipe,
        recipeId: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
        name: 'RTC realtime stability stream',
        description: 'Connect RTC and send a lower-rate stream intended as a green realtime stability baseline.',
        metadata: {
            ...recipe.metadata,
            profile: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
        }
    };
}

interface RealtimeRecipeContext {
    readonly options: RallarBlackBoxRtcRealtimeRecipeOptions;
    readonly durationSeconds: number;
    readonly rateHz: number;
    readonly intervalMs: number;
    readonly frameCount: number;
    readonly connection: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly roomRef: RallarBlackBoxDistributedGroupRef;
    readonly executionMode: 'loop' | 'stream';
}

function toRealtimePositionPayload(
    context: RealtimeRecipeContext,
    mode: 'loop' | 'stream'
): RallarBlackBoxTestRecord {
    const { group, roomRef, rateHz, intervalMs, durationSeconds, frameCount } = context;
    return {
        roomId: group.groupId,
        roomRef,
        openTimeoutMs: 10_000,
        data: {
            topic: 'room.black-box.rtc-realtime.position',
            typeId: 'room.black-box.rtc-realtime.position',
            actor: '{auth.clientId}',
            seq: `{${mode}.index}`,
            rateHz,
            intervalMs,
            durationSeconds,
            totalFrames: frameCount,
            tMs: `{${mode}.elapsedMs}`,
            position: {
                frame: `{${mode}.iteration}`,
                x: `{${mode}.index}`,
                y: 0,
                z: `{${mode}.index}`,
                headingDeg: `{${mode}.index}`,
                velocityMps: 4
            }
        }
    };
}

function toRealtimeSendCommand(context: RealtimeRecipeContext): RallarBlackBoxTestCommand {
    const { options, group, roomRef, rateHz, intervalMs, durationSeconds, frameCount, connection } = context;
    return {
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
                totalFrames: frameCount
            }
        },
        send: toRealtimePositionPayload(context, 'loop')
    };
}

function toRealtimeStreamCommand(context: RealtimeRecipeContext): RallarBlackBoxTestCommand {
    const { options, group, roomRef, rateHz, intervalMs, durationSeconds, frameCount, connection } = context;
    const continueOnStreamSendFailure = options.stream?.continueOnSendFailure ??
        ((options.stream?.maxDroppedFrames ?? 0) > 0 ? true : undefined);
    return {
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
                : { maxP99SendDurationMs: options.stream.maxP99SendDurationMs })
        },
        metadata: {
            realtime: {
                rateHz,
                intervalMs,
                durationSeconds,
                frameCount,
                executionMode: 'stream'
            }
        },
        send: toRealtimePositionPayload(context, 'stream')
    };
}

function toRealtimeRecipe(context: RealtimeRecipeContext): RallarBlackBoxTestRecipe {
    const { options, group, roomRef, rateHz, intervalMs, durationSeconds, frameCount, connection, executionMode } =
        context;
    return {
        schemaVersion: 1,
        recipeId: RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
        name: 'RTC realtime position stream',
        description: 'Connect RTC and send game-style position updates at ' +
            `${rateHz} Hz for the configured duration.`,
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-realtime',
            rateHz,
            intervalMs,
            durationSeconds,
            frameCount,
            executionMode,
            group
        },

        commands: [
            ...createRallarBlackBoxEnsureGroupCommands({
                commandPrefix: 'rtc-realtime',
                requestPrefix: 'rtc-realtime',
                group,
                actor: '{auth.clientId}'
            }),
            toRealtimeConnectCommand(context),
            executionMode === 'stream'
                ? toRealtimeStreamCommand(context)
                : toRealtimeLoopCommand(context),
            {
                kind: 'stats',
                commandId: 'rtc-realtime-stats',
                metadata: {
                    realtime: {
                        rateHz,
                        durationSeconds,
                        frameCount
                    }
                }
            }
        ]
    };
}

function toRealtimeConnectCommand(context: RealtimeRecipeContext): RallarBlackBoxTestCommand {
    const { options, group, roomRef, rateHz, intervalMs, durationSeconds, frameCount, connection } = context;
    return {
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
                frameCount
            }
        }
    };
}

function toRealtimeLoopCommand(context: RealtimeRecipeContext): RallarBlackBoxTestCommand {
    const { options, group, roomRef, rateHz, intervalMs, durationSeconds, frameCount, connection } = context;
    return {
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
                frameCount
            }
        },
        commands: [toRealtimeSendCommand(context)]
    };
}
