import { shouldRetryRallarOperation } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import type {
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserRallarTransport
} from '../browser-adapter.ts';
import {
    createRtcConnectReadinessAbortScope,
    raceWithRtcConnectReadinessAbort,
    toRtcConnectReadinessAbortError,
    waitForRtcConnectReadinessPoll,
    type RtcConnectReadinessAbortScope
} from './rtc-connect-readiness-abort.ts';

type ReadinessBoundaryValue = Awaited<ReturnType<RallarBlackBoxBrowserRallarRuntime['health']>>;

type RtcConnectReadinessError = Readonly<{
    name: string;
    message: string;
}>;

export type RtcConnectReadinessOptions = Readonly<{
    minReadyPeers: number;
    timeoutMs: number;
    intervalMs: number;
}>;

export type RtcConnectReadinessResult = Readonly<{
    ready: boolean;
    minReadyPeers: number;
    timeoutMs: number;
    intervalMs: number;
    waitedMs: number;
    readyPeerIds: readonly string[];
    roomRefreshAttempts: number;
    roomRefreshSuccesses: number;
    roomRefreshRetryableFailures: number;
    health?: ReadinessBoundaryValue;
    room?: RallarRoomTransportStatus;
    lastRefreshError?: RtcConnectReadinessError;
}>;

type RtcConnectReadinessRuntime = Pick<RallarBlackBoxBrowserRallarRuntime, 'health' | 'refreshRoom' | 'waitForRoom'>;

export interface WaitForRtcConnectReadinessInput {
    readonly runtime: RtcConnectReadinessRuntime;
    readonly transport: RallarBlackBoxBrowserRallarTransport | undefined;
    readonly options: RtcConnectReadinessOptions;
    readonly parentSignal?: AbortSignal;
}

interface RtcConnectReadinessState {
    latestHealth: ReadinessBoundaryValue;
    readyPeerIds: readonly string[];
    roomRefreshAttempts: number;
    roomRefreshSuccesses: number;
    roomRefreshRetryableFailures: number;
    nextRefreshAtEpochMs: number;
    lastRefreshError?: RtcConnectReadinessError;
}

type ReadinessLoopInput = Readonly<{
    runtime: RtcConnectReadinessRuntime;
    options: RtcConnectReadinessOptions;
    parentSignal?: AbortSignal;
    abortScope: RtcConnectReadinessAbortScope;
    startedAtEpochMs: number;
    deadlineEpochMs: number;
    state: RtcConnectReadinessState;
}>;

type HealthPollOutcome = 'polled' | 'timed-out';
type RoomRefreshOutcome = 'not-due' | 'refreshed' | 'timed-out';
type ReadinessSleepOutcome = 'slept' | 'timed-out';

const ROOM_REFRESH_INTERVAL_MS = 1_000;

function asRecord(
    value: ReadinessBoundaryValue
): Record<string, ReadinessBoundaryValue> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, ReadinessBoundaryValue>)
        : undefined;
}

export function toRtcReadyPeerIds(
    value: ReadinessBoundaryValue
): readonly string[] {
    const root = asRecord(value);
    const rtcStatus = asRecord(root?.rtcStatus);
    const readyPeerIds = Array.isArray(rtcStatus?.readyPeerIds)
        ? rtcStatus.readyPeerIds
        : Array.isArray(root?.readyPeerIds)
        ? root.readyPeerIds
        : [];
    return readyPeerIds.filter(
        (peerId): peerId is string => typeof peerId === 'string'
    );
}

function serializeReadinessError(
    error: ReadinessBoundaryValue
): RtcConnectReadinessError {
    return error instanceof Error
        ? {
            name: error.name,
            message: error.message
        }
        : {
            name: 'NonError',
            message: String(error)
        };
}

function shouldRetryRoomRefresh(error: ReadinessBoundaryValue): boolean {
    return !isRallarValidationError(error) && shouldRetryRallarOperation(error);
}

function hasConfirmedRtcReadiness(input: ReadinessLoopInput): boolean {
    return (
        input.state.roomRefreshSuccesses > 0 &&
        input.state.readyPeerIds.length >= input.options.minReadyPeers
    );
}

function readinessResult(input: ReadinessLoopInput): RtcConnectReadinessResult {
    return {
        ready: hasConfirmedRtcReadiness(input),
        minReadyPeers: input.options.minReadyPeers,
        timeoutMs: input.options.timeoutMs,
        intervalMs: input.options.intervalMs,
        waitedMs: Math.max(0, Date.now() - input.startedAtEpochMs),
        readyPeerIds: input.state.readyPeerIds,
        roomRefreshAttempts: input.state.roomRefreshAttempts,
        roomRefreshSuccesses: input.state.roomRefreshSuccesses,
        roomRefreshRetryableFailures: input.state.roomRefreshRetryableFailures,
        health: input.state.latestHealth,
        ...(input.state.lastRefreshError !== undefined
            ? { lastRefreshError: input.state.lastRefreshError }
            : {})
    };
}

function throwParentAbortOrError(
    error: ReadinessBoundaryValue,
    parentSignal?: AbortSignal
): never {
    if (parentSignal?.aborted) {
        throw toRtcConnectReadinessAbortError(parentSignal.reason);
    }
    throw error;
}

async function pollRtcConnectHealth(
    input: ReadinessLoopInput
): Promise<HealthPollOutcome> {
    try {
        input.state.latestHealth = await raceWithRtcConnectReadinessAbort(
            input.runtime.health(),
            input.abortScope.signal
        );
    }
    catch (error) {
        if (input.abortScope.timedOut()) {
            return 'timed-out';
        }
        throwParentAbortOrError(error, input.parentSignal);
    }
    input.state.readyPeerIds = toRtcReadyPeerIds(input.state.latestHealth);
    return 'polled';
}

async function refreshRtcConnectRoom(
    input: ReadinessLoopInput
): Promise<RoomRefreshOutcome> {
    if (Date.now() < input.state.nextRefreshAtEpochMs) {
        return 'not-due';
    }

    input.state.roomRefreshAttempts += 1;
    const remainingMs = Math.max(0, input.deadlineEpochMs - Date.now());
    try {
        await raceWithRtcConnectReadinessAbort(
            input.runtime.refreshRoom({
                signal: input.abortScope.signal,
                timeoutMs: remainingMs
            }),
            input.abortScope.signal
        );
        input.state.roomRefreshSuccesses += 1;
    }
    catch (error) {
        if (input.abortScope.timedOut()) {
            return 'timed-out';
        }
        if (input.parentSignal?.aborted || !shouldRetryRoomRefresh(error)) {
            throwParentAbortOrError(error, input.parentSignal);
        }
        input.state.roomRefreshRetryableFailures += 1;
        input.state.lastRefreshError = serializeReadinessError(error);
    }
    input.state.nextRefreshAtEpochMs = Date.now() + ROOM_REFRESH_INTERVAL_MS;
    return 'refreshed';
}

async function sleepForRtcConnectPoll(
    input: ReadinessLoopInput
): Promise<ReadinessSleepOutcome> {
    const remainingMs = Math.max(0, input.deadlineEpochMs - Date.now());
    try {
        await waitForRtcConnectReadinessPoll(
            Math.min(input.options.intervalMs, remainingMs),
            input.abortScope.signal
        );
        return 'slept';
    }
    catch (error) {
        if (input.abortScope.timedOut()) {
            return 'timed-out';
        }
        throwParentAbortOrError(error, input.parentSignal);
    }
}

async function runRtcConnectReadinessLoop(
    input: ReadinessLoopInput
): Promise<RtcConnectReadinessResult> {
    while (true) {
        if ((await refreshRtcConnectRoom(input)) === 'timed-out') {
            return readinessResult(input);
        }
        if ((await pollRtcConnectHealth(input)) === 'timed-out') {
            return readinessResult(input);
        }
        if (
            hasConfirmedRtcReadiness(input) ||
            Date.now() >= input.deadlineEpochMs
        ) {
            return readinessResult(input);
        }
        if ((await sleepForRtcConnectPoll(input)) === 'timed-out') {
            return readinessResult(input);
        }
    }
}

export async function waitForRtcConnectReadiness(
    input: WaitForRtcConnectReadinessInput
): Promise<RtcConnectReadinessResult> {
    if (input.transport === 'messages.rtc') {
        return await waitForRtcRoomConnectReadiness(
            input.runtime,
            input.options,
            input.parentSignal
        );
    }

    const startedAtEpochMs = Date.now();
    const deadlineEpochMs = startedAtEpochMs + input.options.timeoutMs;
    const abortScope = createRtcConnectReadinessAbortScope(
        input.options.timeoutMs,
        input.parentSignal
    );
    const state: RtcConnectReadinessState = {
        latestHealth: undefined,
        readyPeerIds: [],
        roomRefreshAttempts: 0,
        roomRefreshSuccesses: 0,
        roomRefreshRetryableFailures: 0,
        nextRefreshAtEpochMs: startedAtEpochMs
    };

    try {
        return await runRtcConnectReadinessLoop({
            runtime: input.runtime,
            options: input.options,
            parentSignal: input.parentSignal,
            abortScope,
            startedAtEpochMs,
            deadlineEpochMs,
            state
        });
    }
    finally {
        abortScope.cleanup();
    }
}

async function waitForRtcRoomConnectReadiness(
    runtime: RtcConnectReadinessRuntime,
    options: RtcConnectReadinessOptions,
    parentSignal?: AbortSignal
): Promise<RtcConnectReadinessResult> {
    const startedAtEpochMs = Date.now();
    const deadlineEpochMs = startedAtEpochMs + options.timeoutMs;
    const abortScope = createRtcConnectReadinessAbortScope(
        options.timeoutMs,
        parentSignal
    );
    let roomRefreshSuccesses = 0;
    try {
        try {
            await raceWithRtcConnectReadinessAbort(
                runtime.refreshRoom({
                    signal: abortScope.signal,
                    timeoutMs: Math.max(0, deadlineEpochMs - Date.now())
                }),
                abortScope.signal
            );
            roomRefreshSuccesses = 1;
        }
        catch (error) {
            if (abortScope.timedOut()) {
                return rtcRoomReadinessResult({
                    options,
                    startedAtEpochMs,
                    roomRefreshSuccesses
                });
            }
            throwParentAbortOrError(error, parentSignal);
        }

        let room: RallarRoomTransportStatus;
        try {
            room = await raceWithRtcConnectReadinessAbort(
                runtime.waitForRoom({
                    connect: true,
                    minReadyPeers: options.minReadyPeers,
                    signal: abortScope.signal,
                    timeoutMs: Math.max(0, deadlineEpochMs - Date.now())
                }),
                abortScope.signal
            );
        }
        catch (error) {
            if (abortScope.timedOut()) {
                return rtcRoomReadinessResult({
                    options,
                    startedAtEpochMs,
                    roomRefreshSuccesses
                });
            }
            throwParentAbortOrError(error, parentSignal);
        }

        return rtcRoomReadinessResult({
            options,
            startedAtEpochMs,
            roomRefreshSuccesses,
            room
        });
    }
    finally {
        abortScope.cleanup();
    }
}

interface RtcRoomReadinessResultInput {
    readonly options: RtcConnectReadinessOptions;
    readonly startedAtEpochMs: number;
    readonly roomRefreshSuccesses: number;
    readonly room?: RallarRoomTransportStatus;
}

function rtcRoomReadinessResult(
    input: RtcRoomReadinessResultInput
): RtcConnectReadinessResult {
    const readyPeerIds = input.room?.rtc.readyPeerIds ?? [];
    return {
        ready: input.room !== undefined &&
            input.room.rtc.acceptedLayoutIdentity !== undefined &&
            (input.room.rtc.state === 'open' || input.room.rtc.state === 'partial') &&
            readyPeerIds.length >= input.options.minReadyPeers,
        minReadyPeers: input.options.minReadyPeers,
        timeoutMs: input.options.timeoutMs,
        intervalMs: input.options.intervalMs,
        waitedMs: Math.max(0, Date.now() - input.startedAtEpochMs),
        readyPeerIds,
        roomRefreshAttempts: 1,
        roomRefreshSuccesses: input.roomRefreshSuccesses,
        roomRefreshRetryableFailures: 0,
        ...(input.room === undefined ? {} : { room: input.room })
    };
}
