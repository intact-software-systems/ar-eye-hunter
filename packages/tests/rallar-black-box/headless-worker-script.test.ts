import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

async function runHeadlessWorker(
  env: NodeJS.ProcessEnv,
): Promise<Readonly<{ exitCode: number | null; output: string }>> {
  return await new Promise((resolve, reject) => {
    const worker = spawn(
      path.join(repoRoot, "node_modules", ".bin", "tsx"),
      ["apps/rallar-black-box/scripts/headless-worker.ts"],
      { cwd: repoRoot, env },
    );
    let output = "";
    worker.stdout.on("data", (chunk) => output += String(chunk));
    worker.stderr.on("data", (chunk) => output += String(chunk));
    worker.once("error", reject);
    worker.once("close", (exitCode) => resolve({ exitCode, output }));
  });
}

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

  it("logs the selected entry and per-agent URLs through the runtime logger", async () => {
    const source = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(source).toContain("entry=${config.headlessEntry}");
    expect(source).toContain("Opening agent ${agent.agentId} url=${agent.url}");
    expect(source).toContain("createWorkerLogger(bootstrapLogSecrets)");
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
    expect(script).toContain("await waitForWorkerExit(config, activeShutdown);");
    expect(script).toContain("waitForHeadlessWorkerExit({");
    expect(script).toContain("await waitForDistributedRunTerminal({");
    expect(script).toContain("signal,");
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

  it("keeps the runtime logger wired into worker startup and browser events", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain("headlessWorkerLogSecretsFromEnv(process.env)");
    expect(script).toContain("createHeadlessWorkerLogger({");
    expect(script).toContain("attachHeadlessWorkerPageLogging({");
    expect(script).toContain("logHeadlessWorkerUiConfirmationFailure({");
  });

  it("redacts malformed credential-bearing startup configuration errors", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RALLAR_BLACK_BOX_SPA_URL: "https://blackbox.example.test",
      RALLAR_BLACK_BOX_CONTROL_URL:
        "ftp://operator:startup-password@control.example.test/?controlToken=startup-token",
      RALLAR_API_BASE_URL: "https://api.example.test",
      RALLAR_BLACK_BOX_RUN_ID: "run-1",
      RALLAR_BLACK_BOX_ROOM_ID: "room-1",
      RALLAR_BLACK_BOX_AGENT_COUNT: "1",
      RALLAR_BLACK_BOX_USERNAME: "operator",
      RALLAR_BLACK_BOX_PASSWORD: "startup-password",
      RALLAR_BLACK_BOX_CONTROL_TOKEN: "startup-token",
      RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: "startup-read-token",
    };
    delete env.RALLAR_CONTROL_HTTP_URL;

    const result = await runHeadlessWorker(env);

    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("startup-password");
    expect(result.output).not.toContain("startup-token");
    expect(result.output).not.toContain("startup-read-token");
    expect(result.output).toContain("Control URL must use ws, wss, http, or https");
    expect(result.output).toContain("controlToken=[REDACTED]");
  });

  it("authenticates Node-side control-server reads when a control token is configured", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain("controlReadHeaders(config)");
    expect(script).toContain("config.controlReadToken ?? config.controlToken");
    expect(script).toContain('Authorization: `Bearer ${token}`');
    expect(script).toContain("fetchControlRunSnapshot(config, signal)");
    expect(script).toContain("headers: controlReadHeaders(config)");
  });

  it("creates shutdown cancellation before opening agents and wires it through registration", async () => {
    const script = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/scripts/headless-worker.ts"),
      "utf8",
    );

    expect(script).toContain("signal: AbortSignal;");
    expect(script).toContain("const activeShutdown = createShutdownSignal();");
    expect(
      script.indexOf("const activeShutdown = createShutdownSignal();"),
    ).toBeLessThan(
      script.indexOf("config.agents.map"),
    );
    expect(script).toContain(
      "openAgent(browser!, agent, config, activeShutdown.signal)",
    );
    expect(script).toContain("waitForAgentRegistration(agent, config, signal)");
    expect(script).toContain("fetchControlRunSnapshot(config, signal)");
    expect(script).toContain("signal: shutdownController.signal");
  });
});
