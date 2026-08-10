import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import { shouldRetryRallarOperation } from '@shared-web/browser/rallar-operation-options.ts';

import type { RallarBlackBoxBrowserRallarRuntime } from '../browser-adapter.ts';

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
  lastRefreshError?: RtcConnectReadinessError;
}>;

type RtcConnectReadinessRuntime = Pick<
  RallarBlackBoxBrowserRallarRuntime,
  'health' | 'refreshRoom'
>;

type ReadinessAbortScope = Readonly<{
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}>;

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
  abortScope: ReadinessAbortScope;
  startedAtEpochMs: number;
  deadlineEpochMs: number;
  state: RtcConnectReadinessState;
}>;

type HealthPollOutcome = 'polled' | 'timed-out';
type RoomRefreshOutcome = 'not-due' | 'refreshed' | 'timed-out';
type ReadinessSleepOutcome = 'slept' | 'timed-out';

const ROOM_REFRESH_INTERVAL_MS = 1_000;
const READINESS_TIMEOUT_ERROR_NAME = 'RALLAR_BB_RTC_READINESS_TIMEOUT';
const ABORT_ERROR_NAME = 'RALLAR_BLACK_BOX_ABORTED';

function asRecord(
  value: ReadinessBoundaryValue,
): Record<string, ReadinessBoundaryValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, ReadinessBoundaryValue>)
    : undefined;
}

export function toRtcReadyPeerIds(value: ReadinessBoundaryValue): readonly string[] {
  const root = asRecord(value);
  const rtcStatus = asRecord(root?.rtcStatus);
  const readyPeerIds = Array.isArray(rtcStatus?.readyPeerIds)
    ? rtcStatus.readyPeerIds
    : Array.isArray(root?.readyPeerIds)
      ? root.readyPeerIds
      : [];
  return readyPeerIds.filter((peerId): peerId is string => typeof peerId === 'string');
}

function toAbortError(reason: ReadinessBoundaryValue): Error {
  if (reason instanceof Error && reason.name === ABORT_ERROR_NAME) {
    return reason;
  }

  const error = new Error(
    typeof reason === 'string' && reason.length > 0
      ? reason
      : reason instanceof Error
        ? reason.message
        : 'Rallar black-box RTC readiness was cancelled.',
  );
  error.name = ABORT_ERROR_NAME;
  return error;
}

function toReadinessTimeoutError(): Error {
  const error = new Error('RTC connect readiness timeout reached.');
  error.name = READINESS_TIMEOUT_ERROR_NAME;
  return error;
}

function serializeReadinessError(error: ReadinessBoundaryValue): RtcConnectReadinessError {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
      }
    : {
        name: 'NonError',
        message: String(error),
      };
}

function shouldRetryRoomRefresh(error: ReadinessBoundaryValue): boolean {
  return !isRallarValidationError(error) && shouldRetryRallarOperation(error);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const complete = (effect: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      effect();
    };
    const abort = () => complete(() => reject(signal.reason));

    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => complete(() => resolve(value)),
      (error) => complete(() => reject(error)),
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };

    if (signal.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function createReadinessAbortScope(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): ReadinessAbortScope {
  const controller = new AbortController();
  let deadlineReached = false;
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(toAbortError(parentSignal?.reason));
    }
  };
  const timeout = setTimeout(
    () => {
      deadlineReached = true;
      if (!controller.signal.aborted) {
        controller.abort(toReadinessTimeoutError());
      }
    },
    Math.max(0, timeoutMs),
  );

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => deadlineReached,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function readinessResult(input: ReadinessLoopInput): RtcConnectReadinessResult {
  return {
    ready: input.state.readyPeerIds.length >= input.options.minReadyPeers,
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
      : {}),
  };
}

function throwParentAbortOrError(
  error: ReadinessBoundaryValue,
  parentSignal?: AbortSignal,
): never {
  if (parentSignal?.aborted) {
    throw toAbortError(parentSignal.reason);
  }
  throw error;
}

async function pollRtcConnectHealth(input: ReadinessLoopInput): Promise<HealthPollOutcome> {
  try {
    input.state.latestHealth = await raceWithAbort(
      input.runtime.health(),
      input.abortScope.signal,
    );
  } catch (error) {
    if (input.abortScope.timedOut()) {
      return 'timed-out';
    }
    throwParentAbortOrError(error, input.parentSignal);
  }
  input.state.readyPeerIds = toRtcReadyPeerIds(input.state.latestHealth);
  return 'polled';
}

async function refreshRtcConnectRoom(input: ReadinessLoopInput): Promise<RoomRefreshOutcome> {
  if (Date.now() < input.state.nextRefreshAtEpochMs) {
    return 'not-due';
  }

  input.state.roomRefreshAttempts += 1;
  const remainingMs = Math.max(0, input.deadlineEpochMs - Date.now());
  try {
    await raceWithAbort(
      input.runtime.refreshRoom({ signal: input.abortScope.signal, timeoutMs: remainingMs }),
      input.abortScope.signal,
    );
    input.state.roomRefreshSuccesses += 1;
  } catch (error) {
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

async function sleepForRtcConnectPoll(input: ReadinessLoopInput): Promise<ReadinessSleepOutcome> {
  const remainingMs = Math.max(0, input.deadlineEpochMs - Date.now());
  try {
    await sleep(Math.min(input.options.intervalMs, remainingMs), input.abortScope.signal);
    return 'slept';
  } catch (error) {
    if (input.abortScope.timedOut()) {
      return 'timed-out';
    }
    throwParentAbortOrError(error, input.parentSignal);
  }
}

async function runRtcConnectReadinessLoop(
  input: ReadinessLoopInput,
): Promise<RtcConnectReadinessResult> {
  while (true) {
    if (await pollRtcConnectHealth(input) === 'timed-out') {
      return readinessResult(input);
    }
    if (
      input.state.readyPeerIds.length >= input.options.minReadyPeers ||
      Date.now() >= input.deadlineEpochMs
    ) {
      return readinessResult(input);
    }

    const refreshOutcome = await refreshRtcConnectRoom(input);
    if (refreshOutcome === 'timed-out') {
      return readinessResult(input);
    }
    if (refreshOutcome === 'refreshed') {
      continue;
    }
    if (await sleepForRtcConnectPoll(input) === 'timed-out') {
      return readinessResult(input);
    }
  }
}

export async function waitForRtcConnectReadiness(
  runtime: RtcConnectReadinessRuntime,
  options: RtcConnectReadinessOptions,
  parentSignal?: AbortSignal,
): Promise<RtcConnectReadinessResult> {
  const startedAtEpochMs = Date.now();
  const deadlineEpochMs = startedAtEpochMs + options.timeoutMs;
  const abortScope = createReadinessAbortScope(options.timeoutMs, parentSignal);
  const state: RtcConnectReadinessState = {
    latestHealth: undefined,
    readyPeerIds: [],
    roomRefreshAttempts: 0,
    roomRefreshSuccesses: 0,
    roomRefreshRetryableFailures: 0,
    nextRefreshAtEpochMs: startedAtEpochMs,
  };

  try {
    return await runRtcConnectReadinessLoop({
      runtime,
      options,
      parentSignal,
      abortScope,
      startedAtEpochMs,
      deadlineEpochMs,
      state,
    });
  } finally {
    abortScope.cleanup();
  }
}
