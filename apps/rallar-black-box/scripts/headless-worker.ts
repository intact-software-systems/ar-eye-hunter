import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  firefox,
  type Page,
  webkit,
} from "playwright";
import {
  controlRunSnapshotUrlFromControlUrl,
  type HeadlessWorkerAgentConfig,
  type HeadlessWorkerBrowserEngine,
  type HeadlessWorkerConfig,
  readHeadlessWorkerConfig,
} from "../src/headless-worker-config.ts";

type ControlRunAgentSnapshot = Readonly<{
  agentId?: string;
  connected?: boolean;
  status?: string;
}>;

type ControlRunSnapshot = Readonly<{
  agents?: readonly ControlRunAgentSnapshot[];
}>;

type DistributedRunSnapshot = Readonly<{
  state?: string;
}>;

type RunningAgent = Readonly<{
  agent: HeadlessWorkerAgentConfig;
  context: BrowserContext;
  page: Page;
}>;

const WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS = 5_000;
const TERMINAL_DISTRIBUTED_RUN_STATES = new Set(["passed", "failed", "cancelled", "timed-out"]);
const browserTypes = {
  chromium,
  firefox,
  webkit,
} satisfies Record<HeadlessWorkerBrowserEngine, BrowserType>;

const config = readHeadlessWorkerConfig({ env: process.env });
const shutdown = createShutdownSignal();

let browser: Browser | undefined;
let runningAgents: readonly RunningAgent[] = [];

try {
  log(
    `Starting rallar-black-box headless worker run=${config.runId} ` +
      `agents=${config.agentCount} entry=${config.headlessEntry} ` +
      `engine=${config.browserEngine} ` +
      `spa=${config.spaUrl} control=${config.controlUrl}`,
  );
  browser = await browserTypes[config.browserEngine].launch({
    headless: config.headless,
    timeout: config.launchTimeoutMs,
  });

  runningAgents = await Promise.all(
    config.agents.map((agent) => openAgent(browser!, agent)),
  );

  log(
    `All ${runningAgents.length} rallar-black-box headless agents are registered. ` +
      "Waiting for control-server commands.",
  );
  await waitForWorkerExit(config, shutdown);
} catch (error) {
  console.error(`[rallar-black-box-worker] ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await closeAgents(runningAgents);
  await browser?.close().catch(() => undefined);
  log("Rallar black-box headless worker stopped.");
}

async function openAgent(
  browser: Browser,
  agent: HeadlessWorkerAgentConfig,
): Promise<RunningAgent> {
  log(`Opening agent ${agent.agentId} url=${redactAgentUrlForLog(agent.url)}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => {
    const type = message.type();
    if (shouldLogBrowserConsole(type)) {
      log(`agent=${agent.agentId} browser.console.${type}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    log(`agent=${agent.agentId} browser.pageerror: ${error.message}`);
  });
  if (config.browserLogLevel === "debug") {
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "unknown";
      log(
        `agent=${agent.agentId} browser.requestfailed: ${request.method()} ` +
          `${redactUrlForLog(request.url())} ${failure}`,
      );
    });
  }

  await page.goto(agent.url, {
    waitUntil: "domcontentloaded",
    timeout: config.readyTimeoutMs,
  });

  await signInIfLoginGateIsVisible(page, agent);
  await waitForAgentRegistration(agent);
  log(`Agent ${agent.agentId} registered in control server`);
  void confirmAgentRegistrationUi(page, agent).catch((error) => {
    log(
      `Agent ${agent.agentId} registered in control server; UI confirmation skipped: ${
        errorMessage(error)
      }`,
    );
  });
  return {
    agent,
    context,
    page,
  };
}

async function confirmAgentRegistrationUi(
  page: Page,
  agent: HeadlessWorkerAgentConfig,
): Promise<void> {
  if (config.headlessEntry === "operator-spa") {
    await confirmWorkbenchRegistrationUi(page, agent);
    return;
  }

  await confirmHeadlessRegistrationUi(page, agent);
}

async function signInIfLoginGateIsVisible(
  page: Page,
  agent: HeadlessWorkerAgentConfig,
): Promise<void> {
  const signIn = page.getByRole("button", { name: "Sign in" });
  const visible = await signIn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!visible) {
    return;
  }

  log(`Agent ${agent.agentId} signing in`);
  await signIn.click({ timeout: config.readyTimeoutMs });
}

async function waitForAgentRegistration(
  agent: HeadlessWorkerAgentConfig,
): Promise<void> {
  const deadline = Date.now() + config.readyTimeoutMs;
  let lastState = "not seen";
  while (Date.now() < deadline) {
    const snapshot = await fetchControlRunSnapshot().catch((error) => {
      lastState = errorMessage(error);
      return undefined;
    });
    const registeredAgent = snapshot?.agents?.find((candidate) =>
      candidate.agentId === agent.agentId
    );
    if (registeredAgent?.connected) {
      if (registeredAgent.status === "failed") {
        throw new Error(
          `Agent ${agent.agentId} registered with failed runtime status.`,
        );
      }
      return;
    }
    lastState = registeredAgent
      ? `connected=${registeredAgent.connected} status=${
        registeredAgent.status ?? "unknown"
      }`
      : "not in run snapshot";
    await delay(500);
  }

  throw new Error(
    `Timed out waiting ${config.readyTimeoutMs}ms for agent ${agent.agentId} ` +
      `to register in control server snapshot. Last state: ${lastState}`,
  );
}

async function confirmWorkbenchRegistrationUi(
  page: Page,
  agent: HeadlessWorkerAgentConfig,
): Promise<void> {
  const timeout = Math.min(
    config.readyTimeoutMs,
    WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS,
  );
  await page.getByRole("tab", { name: "Local Workbench" }).click({
    timeout,
  });
  const controlPanel = page.locator("#panel-local-workbench .control-panel");
  await controlPanel.waitFor({
    state: "visible",
    timeout,
  });
  await controlPanel.getByText("registered", { exact: false }).waitFor({
    state: "visible",
    timeout,
  });
  await controlPanel.getByText(agent.agentId, { exact: false }).waitFor({
    state: "visible",
    timeout,
  }).catch(() => undefined);
}

async function confirmHeadlessRegistrationUi(
  page: Page,
  agent: HeadlessWorkerAgentConfig,
): Promise<void> {
  const timeout = Math.min(
    config.readyTimeoutMs,
    WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS,
  );
  await page.locator("[data-headless-agent-root]").waitFor({
    state: "visible",
    timeout,
  });
  await page.locator("[data-agent-id]").getByText(agent.agentId, {
    exact: false,
  }).waitFor({
    state: "visible",
    timeout,
  }).catch(() => undefined);
}

async function fetchControlRunSnapshot(): Promise<ControlRunSnapshot> {
  const response = await fetch(
    controlRunSnapshotUrlFromControlUrl(config.controlUrl, config.runId),
  );
  if (!response.ok) {
    throw new Error(
      `Control run snapshot returned HTTP ${response.status}: ` +
        `${await response.text()}`,
    );
  }
  return await response.json() as ControlRunSnapshot;
}

async function waitForWorkerExit(
  config: HeadlessWorkerConfig,
  shutdown: Readonly<{ wait(): Promise<void> }>,
): Promise<void> {
  if (config.exitMode === "signal") {
    await shutdown.wait();
    return;
  }

  if (config.exitMode === "after-idle-ms") {
    if (!config.idleExitMs) {
      throw new Error("RALLAR_BLACK_BOX_IDLE_EXIT_MS must be a positive integer");
    }
    log(`Worker will stop after idle timeout ${config.idleExitMs}ms.`);
    await Promise.race([shutdown.wait(), delay(config.idleExitMs)]);
    return;
  }

  await Promise.race([shutdown.wait(), waitForDistributedRunTerminal(config)]);
}

async function waitForDistributedRunTerminal(
  config: HeadlessWorkerConfig,
): Promise<void> {
  const runId = config.targetDistributedRunId;
  if (!runId) {
    throw new Error(
      "RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID is required for terminal distributed-run exit mode.",
    );
  }

  const url = distributedRunUrl(config);
  const deadline = config.idleExitMs === undefined
    ? undefined
    : Date.now() + config.idleExitMs;
  let lastObservedState = "";
  let malformedJsonCount = 0;

  while (deadline === undefined || Date.now() < deadline) {
    const response = await fetch(url);
    if (response.status === 404) {
      const state = "not-created";
      if (lastObservedState !== state) {
        log(`Distributed run ${runId} is not created yet.`);
        lastObservedState = state;
      }
      malformedJsonCount = 0;
      await delay(config.distributedPollIntervalMs);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Distributed run ${runId} returned HTTP ${response.status}; ` +
          `check GitHub/operator control token configuration for ${
            redactUrlForLog(url)
          }.`,
      );
    }

    if (!response.ok) {
      const state = `http-${response.status}`;
      if (lastObservedState !== state) {
        log(`Distributed run ${runId} returned HTTP ${response.status}; retrying.`);
        lastObservedState = state;
      }
      malformedJsonCount = 0;
      await delay(config.distributedPollIntervalMs);
      continue;
    }

    let snapshot: DistributedRunSnapshot;
    try {
      snapshot = await response.json() as DistributedRunSnapshot;
    } catch {
      malformedJsonCount += 1;
      if (malformedJsonCount >= 3) {
        throw new Error(
          `Distributed run ${runId} returned malformed JSON from ${
            redactUrlForLog(url)
          } for ${malformedJsonCount} consecutive polls.`,
        );
      }
      await delay(config.distributedPollIntervalMs);
      continue;
    }

    malformedJsonCount = 0;
    const state = snapshot.state ?? "unknown";
    if (lastObservedState !== state) {
      log(`Distributed run ${runId} state=${state}`);
      lastObservedState = state;
    }
    if (TERMINAL_DISTRIBUTED_RUN_STATES.has(state)) {
      return;
    }
    await delay(config.distributedPollIntervalMs);
  }

  throw new Error(
    `Timed out after ${config.idleExitMs}ms waiting for distributed run ${runId} ` +
      `to become terminal at ${redactUrlForLog(url)}.`,
  );
}

function distributedRunUrl(config: HeadlessWorkerConfig): string {
  if (!config.controlHttpUrl) {
    throw new Error("RALLAR_CONTROL_HTTP_URL could not be derived.");
  }
  if (!config.targetDistributedRunId) {
    throw new Error("RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID is required.");
  }

  const url = new URL(config.controlHttpUrl);
  url.pathname = `/distributed-runs/${
    encodeURIComponent(config.targetDistributedRunId)
  }`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeAgents(agents: readonly RunningAgent[]): Promise<void> {
  await Promise.all(
    agents.map(async ({ agent, context }) => {
      log(`Closing agent ${agent.agentId}`);
      await context.close().catch(() => undefined);
    }),
  );
}

function createShutdownSignal(): Readonly<{ wait(): Promise<void> }> {
  let resolve!: () => void;
  const waitPromise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  const stop = (signal: string) => {
    log(`Received ${signal}; shutting down`);
    resolve();
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  return {
    wait: () => waitPromise,
  };
}

function log(message: string): void {
  console.log(
    `[rallar-black-box-worker] ${new Date().toISOString()} ${message}`,
  );
}

function shouldLogBrowserConsole(type: string): boolean {
  if (config.browserLogLevel === "debug") {
    return true;
  }
  if (config.browserLogLevel === "info") {
    return type !== "debug";
  }
  return type === "error" || type === "warning";
}

function redactUrlForLog(value: string): string {
  return redactAgentUrlForLog(value);
}

function redactAgentUrlForLog(value: string): string {
  const sensitiveParams = new Set([
    "controlToken",
    "rallarPassword",
    "rallarToken",
    "token",
    "password",
    "secret",
  ]);
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (sensitiveParams.has(key) || /(token|password|secret)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value.replace(
      /((?:token|password|secret)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
