import { isBlackBoxCommandRecord } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { shouldRetryRallarOperation } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

import type {
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserRallarTransport
} from './browser-command-contracts.ts';
import {
    createRtcConnectReadinessAbortScope,
    decodeRtcConnectReadinessAbortReason,
    raceWithRtcConnectReadinessAbort,
    waitForRtcConnectReadinessPoll,
    type RtcConnectReadinessAbortScope
} from './rtc-connect-readiness-abort.ts';

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
    health?: RallarBlackBoxTestRecord;
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
    latestHealth: RallarBlackBoxTestRecord | undefined;
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

/** The lane-level RTC status names the ready peers; an older health shape named them at its root. */
export function decodeRtcReadyPeerIds(value: unknown): readonly string[] {
    const root = isBlackBoxCommandRecord(value) ? value : undefined;
    const rtcStatus = isBlackBoxCommandRecord(root?.rtcStatus) ? root.rtcStatus : undefined;
    const readyPeerIds = Array.isArray(rtcStatus?.readyPeerIds)
        ? rtcStatus.readyPeerIds
        : Array.isArray(root?.readyPeerIds)
        ? root.readyPeerIds
        : [];
    return readyPeerIds.filter((peerId): peerId is string => typeof peerId === 'string');
}

function decodeReadinessError(
    error: unknown
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

function isRtcReadinessConfirmed(input: ReadinessLoopInput): boolean {
    return (
        input.state.roomRefreshSuccesses > 0 &&
        input.state.readyPeerIds.length >= input.options.minReadyPeers
    );
}

function toReadinessResult(input: ReadinessLoopInput): RtcConnectReadinessResult {
    return {
        ready: isRtcReadinessConfirmed(input),
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

function toParentAbortError(parentSignal: AbortSignal | undefined): Error | undefined {
    return parentSignal?.aborted ? decodeRtcConnectReadinessAbortReason(parentSignal.reason) : undefined;
}

async function readRtcConnectHealth(
    input: ReadinessLoopInput
): Promise<HealthPollOutcome> {
    try {
        const health = await raceWithRtcConnectReadinessAbort(input.runtime.health(), input.abortScope.signal);
        input.state.latestHealth = isBlackBoxCommandRecord(health) ? health : undefined;
        input.state.readyPeerIds = decodeRtcReadyPeerIds(health);
    }
    catch (error) {
        if (input.abortScope.timedOut()) {
            return 'timed-out';
        }
        throw toParentAbortError(input.parentSignal) ?? error;
    }
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
        if (input.parentSignal?.aborted || isRallarValidationError(error) || !shouldRetryRallarOperation(error)) {
            throw toParentAbortError(input.parentSignal) ?? error;
        }
        input.state.roomRefreshRetryableFailures += 1;
        input.state.lastRefreshError = decodeReadinessError(error);
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
        throw toParentAbortError(input.parentSignal) ?? error;
    }
}

async function runRtcConnectReadinessLoop(
    input: ReadinessLoopInput
): Promise<RtcConnectReadinessResult> {
    while (true) {
        if ((await refreshRtcConnectRoom(input)) === 'timed-out') {
            return toReadinessResult(input);
        }
        if ((await readRtcConnectHealth(input)) === 'timed-out') {
            return toReadinessResult(input);
        }
        if (
            isRtcReadinessConfirmed(input) ||
            Date.now() >= input.deadlineEpochMs
        ) {
            return toReadinessResult(input);
        }
        if ((await sleepForRtcConnectPoll(input)) === 'timed-out') {
            return toReadinessResult(input);
        }
    }
}

export async function waitForRtcConnectReadiness(
    input: WaitForRtcConnectReadinessInput
): Promise<RtcConnectReadinessResult> {
    if (input.transport === 'messages.rtc') {
        return await waitForRtcRoomConnectReadiness(input);
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
    input: WaitForRtcConnectReadinessInput
): Promise<RtcConnectReadinessResult> {
    const { runtime, options, parentSignal } = input;
    const startedAtEpochMs = Date.now();
    const deadlineEpochMs = startedAtEpochMs + options.timeoutMs;
    const abortScope = createRtcConnectReadinessAbortScope(options.timeoutMs, parentSignal);
    const step = { abortScope, parentSignal };
    try {
        const refreshed = await raceRtcRoomReadinessStep(step, () =>
            runtime.refreshRoom({
                signal: abortScope.signal,
                timeoutMs: Math.max(0, deadlineEpochMs - Date.now())
            }));
        if (refreshed === undefined) {
            return toRtcRoomReadinessResult({ options, startedAtEpochMs, roomRefreshSuccesses: 0 });
        }
        const waited = await raceRtcRoomReadinessStep(step, () =>
            runtime.waitForRoom({
                connect: true,
                minReadyPeers: options.minReadyPeers,
                signal: abortScope.signal,
                timeoutMs: Math.max(0, deadlineEpochMs - Date.now())
            }));
        return toRtcRoomReadinessResult({
            options,
            startedAtEpochMs,
            roomRefreshSuccesses: 1,
            ...(waited === undefined ? {} : { room: waited.value })
        });
    }
    finally {
        abortScope.cleanup();
    }
}

interface RtcRoomReadinessStep {
    readonly abortScope: RtcConnectReadinessAbortScope;
    readonly parentSignal: AbortSignal | undefined;
}

/** Resolves undefined when the readiness budget ran out; a parent abort or a real failure rejects. */
async function raceRtcRoomReadinessStep<T>(
    step: RtcRoomReadinessStep,
    operation: () => Promise<T>
): Promise<{ readonly value: T; } | undefined> {
    try {
        return { value: await raceWithRtcConnectReadinessAbort(operation(), step.abortScope.signal) };
    }
    catch (error) {
        if (step.abortScope.timedOut()) {
            return undefined;
        }
        throw toParentAbortError(step.parentSignal) ?? error;
    }
}

interface RtcRoomReadinessResultInput {
    readonly options: RtcConnectReadinessOptions;
    readonly startedAtEpochMs: number;
    readonly roomRefreshSuccesses: number;
    readonly room?: RallarRoomTransportStatus;
}

function toRtcRoomReadinessResult(
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
