/// <reference lib="deno.ns" />
import {
  BEARER_CREDENTIAL,
  MANAGED_SECRET_ENV_KEY,
  SENSITIVE_ASSIGNMENT,
  SENSITIVE_QUERY_VALUE,
  URL_USERINFO_PASSWORD,
} from './api-v1-managed-api-redaction-patterns.mts';

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

export type BoundedLogTailFile = Readonly<{
  size: () => Promise<number>;
  readAt: (offset: number, target: Uint8Array) => Promise<number | null>;
  close: () => void;
}>;

export type ReadBoundedLogTailOptions = Readonly<{
  openFile?: (path: string) => Promise<BoundedLogTailFile>;
}>;

const LOG_TAIL_MAX_BYTES = 4096;

export async function waitForManagedApiReady(input: WaitForManagedApiReadyInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 30000;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const readLogTail = resolveLogTailReader(input);
  const diagnosticSecrets = normalizeDiagnosticSecrets(input.diagnosticSecrets ?? []);
  const now = input.now ?? Date.now;
  const sleepImpl = input.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  const url = input.baseUrl.replace(/\/+$/, '') + '/api/config';
  const controller = new AbortController();
  let winner: 'ready' | 'child' | 'timeout' | 'error' | undefined;
  let startupObserved = false;
  let lastError: unknown;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const claim = (candidate: NonNullable<typeof winner>): boolean => {
    if (winner) {
      return false;
    }
    winner = candidate;
    return true;
  };

  const abort = (reason: Error): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const settleUnexpectedError = (error: unknown): void => {
    if (!claim('error')) {
      return;
    }
    const reason = error instanceof Error ? error : new Error(String(error));
    abort(reason);
    rejectCompletion(reason);
  };

  const triggerTimeout = (): void => {
    if (!claim('timeout')) {
      return;
    }
    abort(new Error(`Timed out waiting for ${url}`));
    void managedApiTimeoutError({
      url,
      startupObserved,
      lastError,
      logPath: input.logPath,
      readLogTail,
      diagnosticSecrets,
    }).then(rejectCompletion, rejectCompletion);
  };

  const checkDeadline = (): void => {
    if (!winner && now() >= deadline) {
      triggerTimeout();
    }
  };

  void Promise.resolve(input.childStatus).then(async (status) => {
    if (!claim('child')) {
      return;
    }
    abort(new Error(`API-v1 child exited before readiness (code ${status.code})`));
    await Promise.resolve(input.streamsDrained).catch(() => undefined);
    rejectCompletion(
      await managedApiChildExitError(status, input.logPath, readLogTail, diagnosticSecrets),
    );
  }, settleUnexpectedError);

  const timeout = setTimeout(triggerTimeout, Math.max(0, timeoutMs));

  const readinessLoop = (async () => {
    try {
      await raceWithAbort(input.startup, controller.signal);
      startupObserved = true;
      checkDeadline();

      while (!winner) {
        let response: Pick<Response, 'ok' | 'status' | 'body'> | undefined;
        try {
          const responseWithDisposedBody = Promise.resolve(
            fetchImpl(url, { signal: controller.signal }),
          ).then((configResponse) => {
            cancelResponseBodyBestEffort(configResponse);
            return configResponse;
          });
          response = await raceWithAbort(responseWithDisposedBody, controller.signal);
        } catch (error) {
          if (winner) {
            return;
          }
          lastError = error;
        }

        checkDeadline();
        if (winner) {
          return;
        }
        if (response?.ok) {
          if (claim('ready')) {
            abort(new Error('API-v1 managed readiness completed'));
            resolveCompletion();
          }
          return;
        }
        if (response) {
          lastError = new Error(`${url} returned ${response.status}`);
        }

        try {
          await raceWithAbort(sleepImpl(250, controller.signal), controller.signal);
        } catch (error) {
          if (winner) {
            return;
          }
          throw error;
        }
        checkDeadline();
      }
    } catch (error) {
      if (!winner) {
        settleUnexpectedError(error);
      }
    }
  })();

  try {
    await completion;
  } finally {
    clearTimeout(timeout);
    abort(new Error('API-v1 managed readiness stopped'));
    await readinessLoop;
  }
}

type ManagedApiTimeoutErrorInput = Readonly<{
  url: string;
  startupObserved: boolean;
  lastError: unknown;
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

export async function readBoundedLogTail(
  logPath: string,
  options: ReadBoundedLogTailOptions = {},
): Promise<string> {
  let file: BoundedLogTailFile | undefined;
  try {
    file = await (options.openFile ?? openDenoBoundedLogTailFile)(logPath);
    const size = Math.max(0, await file.size());
    const length = Math.min(size, LOG_TAIL_MAX_BYTES);
    if (length === 0) {
      return '(empty)';
    }

    const bytes = new Uint8Array(length);
    const start = size - length;
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = await file.readAt(start + bytesRead, bytes.subarray(bytesRead));
      if (count === null || count <= 0) {
        break;
      }
      bytesRead += Math.min(count, length - bytesRead);
    }
    return normalizeLogTail(new TextDecoder().decode(bytes.subarray(0, bytesRead)));
  } catch (error) {
    return `[unable to read ${logPath}: ${error instanceof Error ? error.message : String(error)}]`;
  } finally {
    try {
      file?.close();
    } catch (_error) {
      // Diagnostic cleanup must not replace the readiness outcome.
    }
  }
}

async function openDenoBoundedLogTailFile(path: string): Promise<BoundedLogTailFile> {
  const file = await Deno.open(path, { read: true });
  return {
    size: async () => (await file.stat()).size,
    readAt: async (offset, target) => {
      await file.seek(offset, Deno.SeekMode.Start);
      return await file.read(target);
    },
    close: () => file.close(),
  };
}

function resolveLogTailReader(
  input: WaitForManagedApiReadyInput,
): (path: string) => Promise<string> {
  if (input.readLogTail) {
    return input.readLogTail;
  }
  if (input.readTextFile) {
    const readTextFile = input.readTextFile;
    return async (path) => normalizeLogTail((await readTextFile(path)).slice(-LOG_TAIL_MAX_BYTES));
  }
  return readBoundedLogTail;
}

async function readLogTailSafely(
  path: string,
  readLogTail: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return normalizeLogTail(await readLogTail(path));
  } catch (error) {
    return `[unable to read ${path}: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function normalizeLogTail(contents: string): string {
  return contents.trimEnd() || '(empty)';
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Operation aborted');
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
