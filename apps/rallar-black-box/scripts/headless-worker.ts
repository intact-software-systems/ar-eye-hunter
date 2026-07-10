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
import {
  attachHeadlessWorkerPageLogging,
  createHeadlessWorkerLogger,
  headlessWorkerLogSecretsFromEnv,
  type HeadlessWorkerLogger,
  logHeadlessWorkerUiConfirmationFailure,
  waitForDistributedRunTerminal,
} from "../src/headless-worker-runtime.ts";

type ControlRunAgentSnapshot = Readonly<{
  agentId?: string;
  connected?: boolean;
  status?: string;
}>;

type ControlRunSnapshot = Readonly<{
  agents?: readonly ControlRunAgentSnapshot[];
}>;

type RunningAgent = Readonly<{
  agent: HeadlessWorkerAgentConfig;
  context: BrowserContext;
  page: Page;
}>;

const WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS = 5_000;
const browserTypes = {
  chromium,
  firefox,
  webkit,
} satisfies Record<HeadlessWorkerBrowserEngine, BrowserType>;

let browser: Browser | undefined;
let runningAgents: readonly RunningAgent[] = [];
const bootstrapLogSecrets = headlessWorkerLogSecretsFromEnv(process.env);
let logger = createWorkerLogger(bootstrapLogSecrets);

try {
  const config = readHeadlessWorkerConfig({ env: process.env });
  logger = createWorkerLogger([
    ...bootstrapLogSecrets,
    config.controlToken,
    config.controlReadToken,
    ...config.agentControlTokens,
    ...config.agentCredentials.map((credentials) => credentials.password),
  ]);
  const shutdown = createShutdownSignal();
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
    config.agents.map((agent) => openAgent(browser!, agent, config)),
  );

  log(
    `All ${runningAgents.length} rallar-black-box headless agents are registered. ` +
      "Waiting for control-server commands.",
  );
  await waitForWorkerExit(config, shutdown);
} catch (error) {
  logger.error(error);
  process.exitCode = 1;
} finally {
  await closeAgents(runningAgents);
  await browser?.close().catch(() => undefined);
  log("Rallar black-box headless worker stopped.");
}

async function openAgent(
  browser: Browser,
  agent: HeadlessWorkerAgentConfig,
  config: HeadlessWorkerConfig,
): Promise<RunningAgent> {
  log(`Opening agent ${agent.agentId} url=${agent.url}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  attachHeadlessWorkerPageLogging({
    agentId: agent.agentId,
    browserLogLevel: config.browserLogLevel,
    page,
    logger,
  });

  await page.goto(agent.url, {
    waitUntil: "domcontentloaded",
    timeout: config.readyTimeoutMs,
  });

  await signInIfLoginGateIsVisible(page, agent, config);
  await waitForAgentRegistration(agent, config);
  log(`Agent ${agent.agentId} registered in control server`);
  void confirmAgentRegistrationUi(page, agent, config).catch((error) => {
    logHeadlessWorkerUiConfirmationFailure({
      agentId: agent.agentId,
      error,
      logger,
    });
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
  config: HeadlessWorkerConfig,
): Promise<void> {
  if (config.headlessEntry === "operator-spa") {
    await confirmWorkbenchRegistrationUi(page, agent, config);
    return;
  }

  await confirmHeadlessRegistrationUi(page, agent, config);
}

async function signInIfLoginGateIsVisible(
  page: Page,
  agent: HeadlessWorkerAgentConfig,
  config: HeadlessWorkerConfig,
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
  config: HeadlessWorkerConfig,
): Promise<void> {
  const deadline = Date.now() + config.readyTimeoutMs;
  let lastState = "not seen";
  while (Date.now() < deadline) {
    const snapshot = await fetchControlRunSnapshot(config).catch((error) => {
      lastState = error instanceof Error ? error.stack ?? error.message : String(error);
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
  config: HeadlessWorkerConfig,
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
  config: HeadlessWorkerConfig,
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

async function fetchControlRunSnapshot(
  config: HeadlessWorkerConfig,
): Promise<ControlRunSnapshot> {
  const response = await fetch(
    controlRunSnapshotUrlFromControlUrl(config.controlUrl, config.runId),
    { headers: controlReadHeaders(config) },
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

  await Promise.race([
    shutdown.wait(),
    waitForConfiguredDistributedRunTerminal(config),
  ]);
}

async function waitForConfiguredDistributedRunTerminal(
  config: HeadlessWorkerConfig,
): Promise<void> {
  const runId = config.targetDistributedRunId;
  if (!runId) {
    throw new Error(
      "RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID is required for terminal distributed-run exit mode.",
    );
  }

  await waitForDistributedRunTerminal({
    runId,
    url: distributedRunUrl(config),
    headers: controlReadHeaders(config),
    deadline: config.idleExitMs === undefined
      ? undefined
      : Date.now() + config.idleExitMs,
    timeoutMs: config.idleExitMs,
    pollIntervalMs: config.distributedPollIntervalMs,
    fetch,
    sleep: delay,
    now: Date.now,
    log,
  });
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

function controlReadHeaders(config: HeadlessWorkerConfig): HeadersInit | undefined {
  const token = config.controlReadToken ?? config.controlToken;
  if (!token) {
    return undefined;
  }
  return {
    Authorization: `Bearer ${token}`,
  };
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
  logger.log(message);
}

function createWorkerLogger(
  secrets: readonly (string | undefined)[],
): HeadlessWorkerLogger {
  return createHeadlessWorkerLogger({
    secrets,
    now: () => new Date(),
    writeLog: console.log,
    writeError: console.error,
  });
}
