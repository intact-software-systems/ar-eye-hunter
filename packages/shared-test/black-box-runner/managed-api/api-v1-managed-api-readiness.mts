/// <reference lib="deno.ns" />
import {
  BEARER_CREDENTIAL,
  MANAGED_SECRET_ENV_KEY,
  SENSITIVE_ASSIGNMENT,
  SENSITIVE_QUERY_VALUE,
  URL_USERINFO_PASSWORD,
} from './api-v1-managed-api-redaction-patterns.mts';
import { readLogTailSafely, resolveLogTailReader } from './api-v1-managed-log-tail.mts';

export {
  readBoundedLogTail,
  type BoundedLogTailFile,
  type ReadBoundedLogTailOptions,
} from './api-v1-managed-log-tail.mts';

export type WaitForManagedApiReadyInput = Readonly<{
  baseUrl: string;
  logPath: string;
  childStatus: PromiseLike<
    Readonly<{
      success: boolean;
      code: number;
      signal: string | null;
    }>
  >;
  startup: PromiseLike<void>;
  streamsDrained: PromiseLike<void>;
  timeoutMs?: number;
  fetchImpl?: (
    url: string,
    init?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<Pick<Response, 'ok' | 'status' | 'body'>>;
  diagnosticSecrets?: readonly string[];
  readLogTail?: (path: string) => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}>;

type ManagedApiReadinessWinner = 'ready' | 'child' | 'timeout' | 'error';

interface ManagedApiReadinessState {
  winner: ManagedApiReadinessWinner | undefined;
  startupObserved: boolean;
  lastError: Error | undefined;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly rejectCompletion: (error: Error) => void;
}

export async function waitForManagedApiReady(input: WaitForManagedApiReadyInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 30000;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const readLogTail = resolveLogTailReader(input);
  const diagnosticSecrets = normalizeDiagnosticSecrets(input.diagnosticSecrets ?? []);
  const now = input.now ?? Date.now;
  const sleepImpl = input.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  const url = input.baseUrl.replace(/\/+$/, '') + '/api/config';
  const state = createManagedApiReadinessState();
  const triggerTimeout = () =>
    triggerManagedApiTimeout({ state, input, url, readLogTail, diagnosticSecrets });
  observeManagedApiChild({ state, input, readLogTail, diagnosticSecrets });
  const timeout = setTimeout(triggerTimeout, Math.max(0, timeoutMs));
  const readinessLoop = pollManagedApiReadiness({
    state,
    input,
    url,
    deadline,
    fetchImpl,
    now,
    sleepImpl,
    triggerTimeout,
  });

  try {
    await state.completion;
  } finally {
    clearTimeout(timeout);
    abortManagedApiReadiness(state, new Error('API-v1 managed readiness stopped'));
    await readinessLoop;
  }
}

function createManagedApiReadinessState(): ManagedApiReadinessState {
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return {
    winner: undefined,
    startupObserved: false,
    lastError: undefined,
    controller: new AbortController(),
    completion,
    resolveCompletion,
    rejectCompletion,
  };
}

function claimManagedApiReadiness(
  state: ManagedApiReadinessState,
  candidate: ManagedApiReadinessWinner,
): boolean {
  if (state.winner) return false;
  state.winner = candidate;
  return true;
}

function abortManagedApiReadiness(state: ManagedApiReadinessState, reason: Error): void {
  if (!state.controller.signal.aborted) state.controller.abort(reason);
}

interface ObserveManagedApiChildInput {
  readonly state: ManagedApiReadinessState;
  readonly input: WaitForManagedApiReadyInput;
  readonly readLogTail: (path: string) => Promise<string>;
  readonly diagnosticSecrets: readonly string[];
}

function observeManagedApiChild({
  state,
  input,
  readLogTail,
  diagnosticSecrets,
}: ObserveManagedApiChildInput): void {
  void observeManagedApiChildStatus({ state, input, readLogTail, diagnosticSecrets });
}

async function observeManagedApiChildStatus({
  state,
  input,
  readLogTail,
  diagnosticSecrets,
}: ObserveManagedApiChildInput): Promise<void> {
  try {
    const status = await input.childStatus;
    if (!claimManagedApiReadiness(state, 'child')) return;
    abortManagedApiReadiness(
      state,
      new Error(`API-v1 child exited before readiness (code ${status.code})`),
    );
    await Promise.resolve(input.streamsDrained).catch(() => undefined);
    state.rejectCompletion(
      await managedApiChildExitError(status, input.logPath, readLogTail, diagnosticSecrets),
    );
  } catch (error) {
    settleUnexpectedManagedApiError(state, error);
  }
}

interface TriggerManagedApiTimeoutInput extends ObserveManagedApiChildInput {
  readonly url: string;
}

function triggerManagedApiTimeout({
  state,
  input,
  url,
  readLogTail,
  diagnosticSecrets,
}: TriggerManagedApiTimeoutInput): void {
  if (!claimManagedApiReadiness(state, 'timeout')) return;
  abortManagedApiReadiness(state, new Error(`Timed out waiting for ${url}`));
  void managedApiTimeoutError({
    url,
    startupObserved: state.startupObserved,
    lastError: state.lastError,
    logPath: input.logPath,
    readLogTail,
    diagnosticSecrets,
  }).then(state.rejectCompletion, state.rejectCompletion);
}

function settleUnexpectedManagedApiError<Value>(
  state: ManagedApiReadinessState,
  error: Value,
): void {
  if (!claimManagedApiReadiness(state, 'error')) return;
  const reason = toManagedApiReadinessError(error);
  abortManagedApiReadiness(state, reason);
  state.rejectCompletion(reason);
}

interface PollManagedApiReadinessInput {
  readonly state: ManagedApiReadinessState;
  readonly input: WaitForManagedApiReadyInput;
  readonly url: string;
  readonly deadline: number;
  readonly fetchImpl: NonNullable<WaitForManagedApiReadyInput['fetchImpl']>;
  readonly now: () => number;
  readonly sleepImpl: NonNullable<WaitForManagedApiReadyInput['sleep']>;
  readonly triggerTimeout: () => void;
}

async function pollManagedApiReadiness(input: PollManagedApiReadinessInput): Promise<void> {
  const { state } = input;
  try {
    await raceWithAbort(input.input.startup, state.controller.signal);
    state.startupObserved = true;
    checkManagedApiDeadline(input);
    while (!state.winner) {
      const response = await fetchManagedApiReadiness(input);
      checkManagedApiDeadline(input);
      if (state.winner) return;
      if (response?.ok) {
        if (claimManagedApiReadiness(state, 'ready')) {
          abortManagedApiReadiness(state, new Error('API-v1 managed readiness completed'));
          state.resolveCompletion();
        }
        return;
      }
      if (response) state.lastError = new Error(`${input.url} returned ${response.status}`);
      try {
        await raceWithAbort(input.sleepImpl(250, state.controller.signal), state.controller.signal);
      } catch (error) {
        if (state.winner) return;
        throw error;
      }
      checkManagedApiDeadline(input);
    }
  } catch (error) {
    if (!state.winner) settleUnexpectedManagedApiError(state, error);
  }
}

async function fetchManagedApiReadiness(
  input: PollManagedApiReadinessInput,
): Promise<Pick<Response, 'ok' | 'status' | 'body'> | undefined> {
  try {
    const responseWithDisposedBody = Promise.resolve(
      input.fetchImpl(input.url, { signal: input.state.controller.signal }),
    ).then((response) => {
      cancelResponseBodyBestEffort(response);
      return response;
    });
    return await raceWithAbort(responseWithDisposedBody, input.state.controller.signal);
  } catch (error) {
    if (!input.state.winner) {
      input.state.lastError = error == null ? undefined : toManagedApiReadinessError(error);
    }
    return undefined;
  }
}

function checkManagedApiDeadline(input: PollManagedApiReadinessInput): void {
  if (!input.state.winner && input.now() >= input.deadline) input.triggerTimeout();
}

type ManagedApiTimeoutErrorInput = Readonly<{
  url: string;
  startupObserved: boolean;
  lastError: Error | undefined;
  logPath: string;
  readLogTail: (path: string) => Promise<string>;
  diagnosticSecrets: readonly string[];
}>;

async function managedApiTimeoutError(input: ManagedApiTimeoutErrorInput): Promise<Error> {
  const { url, startupObserved, lastError, logPath, readLogTail, diagnosticSecrets } = input;
  const reason = startupObserved
    ? lastError instanceof Error
      ? lastError.message
      : String(lastError ?? 'no successful response')
    : 'API-v1 child startup marker was not observed';
  const logTail = await readLogTailSafely(logPath, readLogTail);
  return new Error(
    redactManagedApiDiagnostic(
      `Timed out waiting for ${url}: ${reason}\nLatest API-v1 log tail:\n${logTail}`,
      diagnosticSecrets,
    ),
  );
}

async function managedApiChildExitError(
  status: Awaited<WaitForManagedApiReadyInput['childStatus']>,
  logPath: string,
  readLogTail: (path: string) => Promise<string>,
  diagnosticSecrets: readonly string[],
): Promise<Error> {
  const signal = status.signal ? `, signal ${status.signal}` : '';
  const logTail = await readLogTailSafely(logPath, readLogTail);
  return new Error(
    redactManagedApiDiagnostic(
      `API-v1 child exited before readiness (code ${status.code}${signal})` +
        `\nLatest API-v1 log tail:\n${logTail}`,
      diagnosticSecrets,
    ),
  );
}

function cancelResponseBodyBestEffort(response: Pick<Response, 'body'>): void {
  if (!response.body) {
    return;
  }
  try {
    void Promise.resolve(response.body.cancel()).catch(() => undefined);
  } catch (_error) {
    // Body disposal cannot mask readiness, child-exit, or timeout outcomes.
  }
}

export function managedApiDiagnosticSecrets(env: Record<string, string>): readonly string[] {
  return Object.entries(env)
    .filter(([key, value]) => MANAGED_SECRET_ENV_KEY.test(key) && value.length > 0)
    .map(([, value]) => value);
}

function normalizeDiagnosticSecrets(secrets: readonly string[]): readonly string[] {
  return [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

function redactManagedApiDiagnostic(value: string, diagnosticSecrets: readonly string[]): string {
  let redacted = value
    .replace(URL_USERINFO_PASSWORD, '$1<redacted>$3')
    .replace(BEARER_CREDENTIAL, '$1<redacted>')
    .replace(SENSITIVE_QUERY_VALUE, '$1<redacted>')
    .replace(SENSITIVE_ASSIGNMENT, '$1<redacted>');

  for (const secret of diagnosticSecrets) {
    redacted = redacted.replaceAll(secret, '<redacted>');
  }
  return redacted;
}

function raceWithAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(abortReason(signal)));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return toManagedApiReadinessError(signal.reason ?? new Error('Operation aborted'));
}

function toManagedApiReadinessError<Value>(value: Value): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal ? abortReason(signal) : new Error('Operation aborted'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}
