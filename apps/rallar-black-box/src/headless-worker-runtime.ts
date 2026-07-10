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
  pollIntervalMs: number;
  fetch: (
    url: string,
    init?: RequestInit,
  ) => Promise<DistributedRunResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}>;

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
    `Timed out after ${input.deadline}ms waiting for distributed run ${
      input.runId
    } to become terminal at ${redactHeadlessWorkerLogText(input.url, [])}.`,
  );
}
