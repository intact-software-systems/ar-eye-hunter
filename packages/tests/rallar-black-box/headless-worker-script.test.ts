import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("rallar-black-box headless worker script", () => {
  it("launches the configured Playwright browser engine", async () => {
    const source = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(source).toContain("type BrowserType");
    expect(source).toContain("chromium,");
    expect(source).toContain("firefox,");
    expect(source).toContain("webkit,");
    expect(source).toContain(
      "satisfies Record<HeadlessWorkerBrowserEngine, BrowserType>",
    );
    expect(source).toContain("browserTypes[config.browserEngine].launch");
    expect(source).toContain("engine=${config.browserEngine}");
  });

  it("logs the selected entry and redacted per-agent URLs", async () => {
    const source = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(source).toContain("entry=${config.headlessEntry}");
    expect(source).toContain("redactHeadlessWorkerLogText(agent.url, [])");
    expect(source).toContain("headless-worker-runtime.ts");
  });

  it("waits for configured worker exit modes and terminal distributed runs", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );
    const runtime = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/src/headless-worker-runtime.ts"),
      "utf8",
    );

    expect(runtime).toContain(
      '"passed",\n  "failed",\n  "cancelled",\n  "timed-out",',
    );
    expect(runtime).toContain("Distributed run ${input.runId} is not created yet");
    expect(runtime).toContain("response.status === 404");
    expect(script).toContain("await waitForWorkerExit(config, shutdown);");
    expect(script).toContain("await waitForDistributedRunTerminal({");
  });

  it("redacts URL secrets by known key and sensitive key pattern", async () => {
    const runtime = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/src/headless-worker-runtime.ts"),
      "utf8",
    );

    expect(runtime).toContain("redactHeadlessWorkerLogText");
    expect(runtime).toContain("(?:token|password|secret)");
    expect(runtime).toContain("[REDACTED]");
  });

  it("routes all worker output through the configured central redactor", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain("const headlessWorkerLogSecrets = [");
    expect(script).toContain("config.controlReadToken");
    expect(script).toContain("...config.agentControlTokens");
    expect(script).toContain(
      "...config.agentCredentials.map((credentials) => credentials.password)",
    );
    expect(script).toContain(
      "redactHeadlessWorkerLogText(message, headlessWorkerLogSecrets)",
    );
    expect(script).toMatch(
      /redactHeadlessWorkerLogText\(\s*errorMessage\(error\),\s*headlessWorkerLogSecrets,?\s*\)/,
    );
  });

  it("authenticates Node-side control-server reads when a control token is configured", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain("controlReadHeaders(config)");
    expect(script).toContain("config.controlReadToken ?? config.controlToken");
    expect(script).toContain('Authorization: `Bearer ${token}`');
    expect(script).toContain("fetchControlRunSnapshot(config)");
    expect(script).toContain("headers: controlReadHeaders(config)");
  });
});
