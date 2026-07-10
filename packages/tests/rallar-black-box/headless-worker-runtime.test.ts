import { describe, expect, it } from "vitest";
import {
  redactHeadlessWorkerLogText,
  waitForDistributedRunTerminal,
} from "../../../apps/rallar-black-box/src/headless-worker-runtime.ts";

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
});
