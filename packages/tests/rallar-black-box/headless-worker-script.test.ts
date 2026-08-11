import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

async function runHeadlessWorker(
  env: NodeJS.ProcessEnv,
): Promise<Readonly<{ exitCode: number | null; output: string }>> {
  return await startHeadlessWorker(env).result;
}

function startHeadlessWorker(env: NodeJS.ProcessEnv) {
  const worker = spawn(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    ["apps/rallar-black-box/scripts/headless-worker.ts"],
    { cwd: repoRoot, env },
  );
  let output = "";
  worker.stdout.on("data", (chunk) => output += String(chunk));
  worker.stderr.on("data", (chunk) => output += String(chunk));
  const result = new Promise<Readonly<{
    exitCode: number | null;
    output: string;
  }>>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (exitCode) => resolve({ exitCode, output }));
  });

  return { worker, result };
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe("rallar-black-box headless worker script", () => {

  it("redacts URL secrets by known key and sensitive key pattern", async () => {
    const runtime = await readFile(
      path.join(repoRoot, "apps/rallar-black-box/src/headless-worker-runtime.ts"),
      "utf8",
    );

    expect(runtime).toContain("redactHeadlessWorkerLogText");
    expect(runtime).toContain("(?:token|password|secret)");
    expect(runtime).toContain("[REDACTED]");
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

  it("exits gracefully when SIGTERM interrupts agent registration", async () => {
    let markRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    const spaServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><html><body>worker test</body></html>");
    });
    const controlServer = createServer(() => {
      markRegistrationStarted();
    });
    let runningWorker: ReturnType<typeof startHeadlessWorker> | undefined;

    try {
      const spaPort = await listenOnLoopback(spaServer);
      const controlPort = await listenOnLoopback(controlServer);
      const spaUrl = `http://127.0.0.1:${spaPort}`;
      const controlUrl = `http://127.0.0.1:${controlPort}`;
      runningWorker = startHeadlessWorker({
        ...process.env,
        RALLAR_BLACK_BOX_SPA_URL: spaUrl,
        RALLAR_BLACK_BOX_CONTROL_URL: controlUrl,
        RALLAR_CONTROL_HTTP_URL: controlUrl,
        RALLAR_API_BASE_URL: `${spaUrl}/api`,
        RALLAR_BLACK_BOX_RUN_ID: "run-sigterm-registration",
        RALLAR_BLACK_BOX_ROOM_ID: "room-sigterm-registration",
        RALLAR_BLACK_BOX_AGENT_COUNT: "1",
        RALLAR_BLACK_BOX_AGENT_START_INDEX: "1",
        RALLAR_BLACK_BOX_AGENT_PREFIX: "signal-agent",
        RALLAR_BLACK_BOX_USERNAME: "operator",
        RALLAR_BLACK_BOX_PASSWORD: "signal-password",
        RALLAR_BLACK_BOX_AGENT_1_USERNAME: "operator",
        RALLAR_BLACK_BOX_AGENT_1_PASSWORD: "signal-password",
        RALLAR_BLACK_BOX_BROWSER_ENGINE: "chromium",
        RALLAR_BLACK_BOX_HEADLESS_ENTRY: "operator-spa",
        RALLAR_BLACK_BOX_HEADLESS: "1",
        RALLAR_BLACK_BOX_EXIT_MODE: "signal",
        RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS: "10000",
        RALLAR_BLACK_BOX_READY_TIMEOUT_MS: "30000",
      });

      await within(
        registrationStarted,
        10_000,
        "Worker did not start registration",
      );
      expect(runningWorker.worker.kill("SIGTERM")).toBe(true);
      const result = await within(
        runningWorker.result,
        5_000,
        "Worker did not exit after SIGTERM",
      );

      expect.soft(result.exitCode).toBe(0);
      expect.soft(result.output).toContain("Received SIGTERM; shutting down");
      expect.soft(result.output).not.toContain(
        "Error: Received SIGTERM; shutting down",
      );
      expect.soft(result.output).toContain(
        "Rallar black-box headless worker stopped.",
      );
    } finally {
      if (
        runningWorker &&
        runningWorker.worker.exitCode === null &&
        runningWorker.worker.signalCode === null
      ) {
        runningWorker.worker.kill("SIGKILL");
        await runningWorker.result.catch(() => undefined);
      }
      await closeServer(controlServer);
      await closeServer(spaServer);
    }
  }, 20_000);
});
