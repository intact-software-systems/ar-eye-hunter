import { describe, expect, it, vi } from "vitest";
import {
  attachHeadlessWorkerPageLogging,
  createHeadlessWorkerLogger,
  headlessWorkerLogSecretsFromEnv,
  logHeadlessWorkerUiConfirmationFailure,
  redactHeadlessWorkerLogText,
  waitForDistributedRunTerminal,
  waitForHeadlessWorkerExit,
} from "../../../apps/rallar-black-box/src/headless-worker-runtime.ts";

type PromiseOutcome =
  | Readonly<{ state: "resolved" }>
  | Readonly<{ state: "rejected"; error: unknown }>
  | Readonly<{ state: "pending" }>;

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function observe(promise: Promise<void>): Promise<PromiseOutcome> {
  return promise.then(
    () => ({ state: "resolved" }),
    (error: unknown) => ({ state: "rejected", error }),
  );
}

async function observeWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<PromiseOutcome> {
  return await Promise.race([
    observe(promise),
    new Promise<PromiseOutcome>((resolve) => {
      setTimeout(() => resolve({ state: "pending" }), timeoutMs);
    }),
  ]);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakePageEvents {
  #listeners = new Map<string, ((value: unknown) => void)[]>();

  on(event: string, listener: (value: unknown) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(value);
    }
  }
}

describe("rallar-black-box headless worker runtime", () => {
  it("redacts Playwright navigation messages with configured credentials", () => {
    const password = "agent-password";
    const token = "agent-control-token";
    const message =
      "page.goto: net::ERR_CONNECTION_REFUSED at " +
      `https://operator:${password}@control.example.test/runs?` +
      `rallarPassword=${password}&controlToken=${token}&rallarToken=${token}`;

    const redacted = redactHeadlessWorkerLogText(message, [password, token]);

    expect(redacted).not.toContain(password);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("rallarPassword=[REDACTED]");
    expect(redacted).toContain("controlToken=[REDACTED]");
    expect(redacted).toContain("rallarToken=[REDACTED]");
  });

  it("retries a rejected distributed-run poll until it reaches a terminal state", async () => {
    let calls = 0;
    const logs: string[] = [];

    await waitForDistributedRunTerminal({
      runId: "run-1",
      url: "https://control.example.test/distributed-runs/run-1",
      deadline: 1_000,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("connect ECONNREFUSED");
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({ state: "passed" }),
        };
      },
      sleep: async () => undefined,
      now: () => 0,
      log: (message) => logs.push(message),
    });

    expect(calls).toBe(2);
    expect(logs).toContain("Distributed run run-1 state=network-error");
    expect(logs).toContain("Distributed run run-1 state=passed");
  });

  it("uses the configured timeout duration in terminal polling errors", async () => {
    await expect(waitForDistributedRunTerminal({
      runId: "run-1",
      url: "https://control.example.test/distributed-runs/run-1",
      deadline: 1_000,
      timeoutMs: 25,
      pollIntervalMs: 10,
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => ({ state: "running" }),
      }),
      sleep: async () => undefined,
      now: () => 1_000,
      log: () => undefined,
    })).rejects.toThrow("Timed out after 25ms");
  });

  it("derives bootstrap secrets and routes every worker message category through one logger", () => {
    const password = "route-password";
    const token = "route-control-token";
    const secrets = headlessWorkerLogSecretsFromEnv({
      RALLAR_BLACK_BOX_PASSWORD: password,
      RALLAR_BLACK_BOX_CONTROL_TOKEN: token,
      RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: "read-token",
      RALLAR_BLACK_BOX_AGENT_2_PASSWORD: "agent-two-password",
      RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN: "agent-two-token",
    });
    expect(secrets).toEqual(expect.arrayContaining([
      password,
      token,
      "read-token",
      "agent-two-password",
      "agent-two-token",
    ]));

    const logs: string[] = [];
    const errors: string[] = [];
    const logger = createHeadlessWorkerLogger({
      secrets,
      now: () => new Date("2026-07-10T18:00:00.000Z"),
      writeLog: (message) => logs.push(message),
      writeError: (message) => errors.push(message),
    });
    const page = new FakePageEvents();
    attachHeadlessWorkerPageLogging({
      agentId: "agent-1",
      browserLogLevel: "debug",
      page: page as never,
      logger,
    });

    logger.log(`ordinary log password=${password}`);
    page.emit("console", {
      type: () => "error",
      text: () => `console ${password} token=${token}`,
    });
    page.emit("pageerror", new Error(`page error ${password}`));
    page.emit("requestfailed", {
      method: () => "GET",
      url: () => `https://control.example.test/?controlToken=${token}`,
      failure: () => ({ errorText: `request failed ${password}` }),
    });
    logHeadlessWorkerUiConfirmationFailure({
      agentId: "agent-1",
      error: new Error(`ui confirmation ${token}`),
      logger,
    });
    logger.error(new Error(`startup failure ${password} token=${token}`));

    const output = [...logs, ...errors].join("\n");
    expect(output).not.toContain(password);
    expect(output).not.toContain(token);
    expect(output).toContain("ordinary log");
    expect(output).toContain("browser.console.error");
    expect(output).toContain("browser.pageerror");
    expect(output).toContain("browser.requestfailed");
    expect(output).toContain("UI confirmation skipped");
    expect(output).toContain("startup failure");
    expect(output).toContain("controlToken=[REDACTED]");
  });

  it("hard-times out a never-settling fetch and aborts its signal", async () => {
    vi.useFakeTimers();
    try {
      let fetchSignal: AbortSignal | undefined;
      const startedAt = Date.now();
      const polling = waitForDistributedRunTerminal({
        runId: "run-never",
        url: "https://control.example.test/distributed-runs/run-never",
        deadline: startedAt + 10,
        timeoutMs: 10,
        pollIntervalMs: 5,
        fetch: async (_url, init) => {
          fetchSignal = init?.signal;
          return await new Promise(() => undefined);
        },
        sleep: async () => undefined,
        now: Date.now,
        log: () => undefined,
      });
      const guarded = Promise.race([
        observe(polling),
        new Promise<PromiseOutcome>((resolve) => {
          setTimeout(() => resolve({ state: "pending" }), 11);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(11);
      const outcome = await guarded;

      expect(outcome).toEqual({
        state: "rejected",
        error: expect.objectContaining({
          message: expect.stringContaining("Timed out after 10ms"),
        }),
      });
      expect(fetchSignal).toBeInstanceOf(AbortSignal);
      expect(fetchSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles promptly when external shutdown aborts an active fetch", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = deferred<void>();
      let fetchSignal: AbortSignal | undefined;
      const startedAt = Date.now();
      const exit = waitForHeadlessWorkerExit({
        waitForShutdown: async () => await shutdown.promise,
        waitForCompletion: async (signal) => {
          await waitForDistributedRunTerminal({
            runId: "run-shutdown",
            url: "https://control.example.test/distributed-runs/run-shutdown",
            deadline: startedAt + 10_000,
            timeoutMs: 10_000,
            pollIntervalMs: 5_000,
            signal,
            fetch: async (_url, init) => {
              fetchSignal = init?.signal;
              return await new Promise(() => undefined);
            },
            sleep: async () => undefined,
            now: Date.now,
            log: () => undefined,
          });
        },
      });

      await flushMicrotasks();
      shutdown.resolve();
      await expect(exit).resolves.toBeUndefined();

      expect(fetchSignal).toBeInstanceOf(AbortSignal);
      expect(fetchSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes late response disposal failures after an aborted fetch", async () => {
    const shutdown = new AbortController();
    const response = deferred<Readonly<{
      status: number;
      ok: boolean;
      body: Readonly<{ cancel(): Promise<void> }>;
      json(): Promise<unknown>;
    }>>();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const polling = waitForDistributedRunTerminal({
        runId: "run-late",
        url: "https://control.example.test/distributed-runs/run-late",
        deadline: Date.now() + 10_000,
        timeoutMs: 10_000,
        pollIntervalMs: 5_000,
        signal: shutdown.signal,
        fetch: async () => await response.promise,
        sleep: async () => undefined,
        now: Date.now,
        log: () => undefined,
      });

      await flushMicrotasks();
      shutdown.abort(new Error("worker shutdown"));
      expect((await observeWithin(polling, 25)).state).toBe("rejected");
      response.resolve({
        status: 503,
        ok: false,
        body: {
          cancel: async () => {
            throw new Error("late cancel failed");
          },
        },
        json: async () => ({}),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("cancels the losing after-idle timer when shutdown wins", async () => {
    const shutdown = deferred<void>();
    let idleSignal: AbortSignal | undefined;
    let idleTimerCleared = false;

    const exit = waitForHeadlessWorkerExit({
      waitForShutdown: async () => await shutdown.promise,
      waitForCompletion: async (signal) => {
        idleSignal = signal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            idleTimerCleared = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });

    await flushMicrotasks();
    shutdown.resolve();
    await expect(exit).resolves.toBeUndefined();

    expect(idleSignal?.aborted).toBe(true);
    expect(idleTimerCleared).toBe(true);
  });

  it("cancels the 404 response body before retrying", async () => {
    const cancel = vi.fn(async () => undefined);
    let calls = 0;

    await waitForDistributedRunTerminal({
      runId: "run-404",
      url: "https://control.example.test/distributed-runs/run-404",
      deadline: undefined,
      timeoutMs: undefined,
      pollIntervalMs: 10,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 404,
            ok: false,
            body: { cancel },
            json: async () => ({}),
          };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({ state: "passed" }),
        };
      },
      sleep: async () => undefined,
      now: () => 0,
      log: () => undefined,
    });

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an authentication response body before throwing", async () => {
    const cancel = vi.fn(async () => undefined);

    await expect(waitForDistributedRunTerminal({
      runId: "run-auth",
      url: "https://control.example.test/distributed-runs/run-auth",
      deadline: undefined,
      timeoutMs: undefined,
      pollIntervalMs: 10,
      fetch: async () => ({
        status: 401,
        ok: false,
        body: { cancel },
        json: async () => ({}),
      }),
      sleep: async () => undefined,
      now: () => 0,
      log: () => undefined,
    })).rejects.toThrow("returned HTTP 401");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a retryable non-OK response body before polling again", async () => {
    const cancel = vi.fn(async () => undefined);
    let calls = 0;

    await waitForDistributedRunTerminal({
      runId: "run-retry",
      url: "https://control.example.test/distributed-runs/run-retry",
      deadline: undefined,
      timeoutMs: undefined,
      pollIntervalMs: 10,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 503,
            ok: false,
            body: { cancel },
            json: async () => ({}),
          };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({ state: "passed" }),
        };
      },
      sleep: async () => undefined,
      now: () => 0,
      log: () => undefined,
    });

    expect(cancel).toHaveBeenCalledOnce();
  });
});
