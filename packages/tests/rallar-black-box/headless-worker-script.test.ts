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
    expect(source).toContain("redactAgentUrlForLog(agent.url)");
    expect(source).toContain("rallarPassword");
    expect(source).toContain("controlToken");
  });

  it("waits for configured worker exit modes and terminal distributed runs", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain(
      'const TERMINAL_DISTRIBUTED_RUN_STATES = new Set(["passed", "failed", "cancelled", "timed-out"]);',
    );
    expect(script).toContain("await waitForWorkerExit(config, shutdown);");
    expect(script).toContain("Distributed run ${runId} is not created yet");
    expect(script).toContain("response.status === 404");
  });

  it("redacts URL secrets by known key and sensitive key pattern", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain("controlToken");
    expect(script).toContain("rallarPassword");
    expect(script).toContain("rallarToken");
    expect(script).toContain("/(token|password|secret)/i");
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
    expect(script).toContain("fetch(url, { headers: controlReadHeaders(config) })");
  });
});
