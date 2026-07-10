import { describe, expect, it } from "vitest";
import {
  attachHeadlessWorkerPageLogging,
  createHeadlessWorkerLogger,
  headlessWorkerLogSecretsFromEnv,
  logHeadlessWorkerUiConfirmationFailure,
  redactHeadlessWorkerLogText,
  waitForDistributedRunTerminal,
} from "../../../apps/rallar-black-box/src/headless-worker-runtime.ts";

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
});
