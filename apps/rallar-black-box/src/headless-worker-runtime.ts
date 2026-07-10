import type { ConsoleMessage, Page, Request } from "playwright";

type DistributedRunSnapshot = Readonly<{
  state?: string;
}>;

type DistributedRunResponse = Readonly<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type WaitForDistributedRunTerminalInput = Readonly<{
  runId: string;
  url: string;
  headers?: HeadersInit;
  deadline: number | undefined;
  timeoutMs?: number;
  pollIntervalMs: number;
  fetch: (
    url: string,
    init?: RequestInit,
  ) => Promise<DistributedRunResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}>;

export type HeadlessWorkerLogger = Readonly<{
  log(message: string): void;
  error(error: unknown): void;
}>;

export type CreateHeadlessWorkerLoggerInput = Readonly<{
  secrets: readonly (string | undefined)[];
  now: () => Date;
  writeLog: (message: string) => void;
  writeError: (message: string) => void;
}>;

export type AttachHeadlessWorkerPageLoggingInput = Readonly<{
  agentId: string;
  browserLogLevel: string;
  page: Pick<Page, "on">;
  logger: HeadlessWorkerLogger;
}>;

const HEADLESS_WORKER_SECRET_ENV_KEY =
  /^RALLAR_BLACK_BOX_(?:PASSWORD|CONTROL_TOKEN|CONTROL_READ_TOKEN|AGENT_\d+_(?:PASSWORD|CONTROL_TOKEN))$/;

const TERMINAL_DISTRIBUTED_RUN_STATES = new Set([
  "passed",
  "failed",
  "cancelled",
  "timed-out",
]);

export function redactHeadlessWorkerLogText(
  message: string,
  secrets: readonly (string | undefined)[],
): string {
  const withoutKnownSecrets = [...secrets]
    .filter((secret): secret is string => Boolean(secret))
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      message,
    );
  return withoutKnownSecrets.replace(
    /((?:token|password|secret)[^=&\s]*=)[^&#\s]*/gi,
    "$1[REDACTED]",
  );
}

export function headlessWorkerLogSecretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.entries(env)
    .filter(([key]) => HEADLESS_WORKER_SECRET_ENV_KEY.test(key))
    .map(([, value]) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

export function createHeadlessWorkerLogger(
  input: CreateHeadlessWorkerLoggerInput,
): HeadlessWorkerLogger {
  const redact = (message: string) =>
    redactHeadlessWorkerLogText(message, input.secrets);

  return {
    log: (message) => {
      input.writeLog(
        `[rallar-black-box-worker] ${input.now().toISOString()} ${redact(message)}`,
      );
    },
    error: (error) => {
      input.writeError(
        `[rallar-black-box-worker] ${redact(headlessWorkerErrorMessage(error))}`,
      );
    },
  };
}

export function attachHeadlessWorkerPageLogging(
  input: AttachHeadlessWorkerPageLoggingInput,
): void {
  input.page.on("console", (message: ConsoleMessage) => {
    const type = message.type();
    if (shouldLogHeadlessWorkerBrowserConsole(input.browserLogLevel, type)) {
      input.logger.log(
        `agent=${input.agentId} browser.console.${type}: ${message.text()}`,
      );
    }
  });
  input.page.on("pageerror", (error: Error) => {
    input.logger.log(
      `agent=${input.agentId} browser.pageerror: ${error.message}`,
    );
  });
  if (input.browserLogLevel === "debug") {
    input.page.on("requestfailed", (request: Request) => {
      const failure = request.failure()?.errorText ?? "unknown";
      input.logger.log(
        `agent=${input.agentId} browser.requestfailed: ${request.method()} ` +
          `${request.url()} ${failure}`,
      );
    });
  }
}

export function logHeadlessWorkerUiConfirmationFailure(
  input: Readonly<{
    agentId: string;
    error: unknown;
    logger: HeadlessWorkerLogger;
  }>,
): void {
  input.logger.log(
    `Agent ${input.agentId} registered in control server; UI confirmation skipped: ${
      headlessWorkerErrorMessage(input.error)
    }`,
  );
}

export async function waitForDistributedRunTerminal(
  input: WaitForDistributedRunTerminalInput,
): Promise<void> {
  let lastObservedState = "";
  let malformedJsonCount = 0;

  while (input.deadline === undefined || input.now() < input.deadline) {
    let response: DistributedRunResponse;
    try {
      response = await input.fetch(input.url, { headers: input.headers });
    } catch {
      const state = "network-error";
      if (lastObservedState !== state) {
        input.log(`Distributed run ${input.runId} state=${state}`);
        lastObservedState = state;
      }
      malformedJsonCount = 0;
      await input.sleep(input.pollIntervalMs);
      continue;
    }
    if (response.status === 404) {
      const state = "not-created";
      if (lastObservedState !== state) {
        input.log(`Distributed run ${input.runId} is not created yet.`);
        lastObservedState = state;
      }
      malformedJsonCount = 0;
      await input.sleep(input.pollIntervalMs);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Distributed run ${input.runId} returned HTTP ${response.status}; ` +
          `check GitHub/operator control token configuration for ${
            redactHeadlessWorkerLogText(input.url, [])
          }.`,
      );
    }

    if (!response.ok) {
      const state = `http-${response.status}`;
      if (lastObservedState !== state) {
        input.log(
          `Distributed run ${input.runId} returned HTTP ${response.status}; retrying.`,
        );
        lastObservedState = state;
      }
      malformedJsonCount = 0;
      await input.sleep(input.pollIntervalMs);
      continue;
    }

    let snapshot: DistributedRunSnapshot;
    try {
      snapshot = await response.json() as DistributedRunSnapshot;
    } catch {
      malformedJsonCount += 1;
      if (malformedJsonCount >= 3) {
        throw new Error(
          `Distributed run ${input.runId} returned malformed JSON from ${
            redactHeadlessWorkerLogText(input.url, [])
          } for ${malformedJsonCount} consecutive polls.`,
        );
      }
      await input.sleep(input.pollIntervalMs);
      continue;
    }

    malformedJsonCount = 0;
    const state = snapshot.state ?? "unknown";
    if (lastObservedState !== state) {
      input.log(`Distributed run ${input.runId} state=${state}`);
      lastObservedState = state;
    }
    if (TERMINAL_DISTRIBUTED_RUN_STATES.has(state)) {
      return;
    }
    await input.sleep(input.pollIntervalMs);
  }

  throw new Error(
    `Timed out after ${input.timeoutMs ?? input.deadline}ms waiting for distributed run ${
      input.runId
    } to become terminal at ${redactHeadlessWorkerLogText(input.url, [])}.`,
  );
}

function shouldLogHeadlessWorkerBrowserConsole(
  browserLogLevel: string,
  type: string,
): boolean {
  if (browserLogLevel === "debug") {
    return true;
  }
  if (browserLogLevel === "info") {
    return type !== "debug";
  }
  return type === "error" || type === "warning";
}

function headlessWorkerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
