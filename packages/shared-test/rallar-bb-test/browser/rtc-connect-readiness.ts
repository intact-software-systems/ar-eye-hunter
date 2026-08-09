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

type ReadinessResultInput = Readonly<{
  options: RtcConnectReadinessOptions;
  startedAtEpochMs: number;
  health: ReadinessBoundaryValue;
  readyPeerIds: readonly string[];
  lastRefreshError?: RtcConnectReadinessError;
}>;

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

function readinessResult(input: ReadinessResultInput): RtcConnectReadinessResult {
  return {
    ready: input.readyPeerIds.length >= input.options.minReadyPeers,
    minReadyPeers: input.options.minReadyPeers,
    timeoutMs: input.options.timeoutMs,
    intervalMs: input.options.intervalMs,
    waitedMs: Math.max(0, Date.now() - input.startedAtEpochMs),
    readyPeerIds: input.readyPeerIds,
    health: input.health,
    ...(input.lastRefreshError !== undefined ? { lastRefreshError: input.lastRefreshError } : {}),
  };
}

export async function waitForRtcConnectReadiness(
  runtime: RtcConnectReadinessRuntime,
  options: RtcConnectReadinessOptions,
  parentSignal?: AbortSignal,
): Promise<RtcConnectReadinessResult> {
  const startedAtEpochMs = Date.now();
  const deadlineEpochMs = startedAtEpochMs + options.timeoutMs;
  const abortScope = createReadinessAbortScope(options.timeoutMs, parentSignal);
  let latestHealth: ReadinessBoundaryValue;
  let readyPeerIds: readonly string[] = [];
  let lastRefreshError: RtcConnectReadinessError | undefined;
  let nextRefreshAtEpochMs = startedAtEpochMs;

  try {
    while (true) {
      try {
        latestHealth = await raceWithAbort(runtime.health(), abortScope.signal);
      } catch (error) {
        if (abortScope.timedOut()) {
          return readinessResult({
            options,
            startedAtEpochMs,
            health: latestHealth,
            readyPeerIds,
            lastRefreshError,
          });
        }
        if (parentSignal?.aborted) {
          throw toAbortError(parentSignal.reason);
        }
        throw error;
      }
      readyPeerIds = toRtcReadyPeerIds(latestHealth);
      if (readyPeerIds.length >= options.minReadyPeers || Date.now() >= deadlineEpochMs) {
        return readinessResult({
          options,
          startedAtEpochMs,
          health: latestHealth,
          readyPeerIds,
          lastRefreshError,
        });
      }

      if (Date.now() >= nextRefreshAtEpochMs) {
        const remainingMs = Math.max(0, deadlineEpochMs - Date.now());
        try {
          await raceWithAbort(
            runtime.refreshRoom({
              signal: abortScope.signal,
              timeoutMs: remainingMs,
            }),
            abortScope.signal,
          );
        } catch (error) {
          if (abortScope.timedOut()) {
            return readinessResult({
              options,
              startedAtEpochMs,
              health: latestHealth,
              readyPeerIds,
              lastRefreshError,
            });
          }
          if (parentSignal?.aborted) {
            throw toAbortError(parentSignal.reason);
          }
          if (!shouldRetryRoomRefresh(error)) {
            throw error;
          }
          lastRefreshError = serializeReadinessError(error);
        }
        nextRefreshAtEpochMs = Date.now() + ROOM_REFRESH_INTERVAL_MS;
        continue;
      }

      const remainingMs = Math.max(0, deadlineEpochMs - Date.now());
      try {
        await sleep(Math.min(options.intervalMs, remainingMs), abortScope.signal);
      } catch (error) {
        if (abortScope.timedOut()) {
          return readinessResult({
            options,
            startedAtEpochMs,
            health: latestHealth,
            readyPeerIds,
            lastRefreshError,
          });
        }
        if (parentSignal?.aborted) {
          throw toAbortError(parentSignal.reason);
        }
        throw error;
      }
    }
  } finally {
    abortScope.cleanup();
  }
}
