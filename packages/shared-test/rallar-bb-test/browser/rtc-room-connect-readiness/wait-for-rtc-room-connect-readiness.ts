import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';

import {
    createRtcConnectReadinessAbortScope,
    raceWithRtcConnectReadinessAbort,
    toParentAbortError,
    waitForRtcConnectReadinessPoll,
    type RtcConnectReadinessAbortScope
} from '../rtc-connect-readiness-abort.ts';
import type {
    RtcConnectReadinessOptions,
    RtcConnectReadinessResult,
    RtcConnectReadinessRuntime,
    WaitForRtcConnectReadinessInput
} from '../rtc-connect-readiness.ts';

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

interface RtcRoomReadinessWaitInput {
    readonly runtime: RtcConnectReadinessRuntime;
    readonly options: RtcConnectReadinessOptions;
    readonly startedAtEpochMs: number;
    readonly deadlineEpochMs: number;
    readonly step: RtcRoomReadinessStep;
}

/** A room wait that ends without readiness before the deadline is retried; only the readiness budget ends the wait. */
async function waitForRtcRoomReadinessResult(
    input: RtcRoomReadinessWaitInput
): Promise<RtcConnectReadinessResult> {
    const { runtime, options, startedAtEpochMs, deadlineEpochMs, step } = input;
    while (true) {
        const waited = await raceRtcRoomReadinessStep(step, () =>
            runtime.waitForRoom({
                connect: true,
                minReadyPeers: options.minReadyPeers,
                signal: step.abortScope.signal,
                timeoutMs: Math.max(0, deadlineEpochMs - Date.now())
            }));
        const result = toRtcRoomReadinessResult({
            options,
            startedAtEpochMs,
            roomRefreshSuccesses: 1,
            ...(waited === undefined ? {} : { room: waited.value })
        });
        if (result.ready || waited === undefined || Date.now() >= deadlineEpochMs) {
            return result;
        }
        const polled = await raceRtcRoomReadinessStep(step, () =>
            waitForRtcConnectReadinessPoll(
                Math.min(options.intervalMs, Math.max(0, deadlineEpochMs - Date.now())),
                step.abortScope.signal
            ));
        if (polled === undefined) {
            return result;
        }
    }
}

export async function waitForRtcRoomConnectReadiness(
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
        return await waitForRtcRoomReadinessResult({ runtime, options, startedAtEpochMs, deadlineEpochMs, step });
    }
    finally {
        abortScope.cleanup();
    }
}
