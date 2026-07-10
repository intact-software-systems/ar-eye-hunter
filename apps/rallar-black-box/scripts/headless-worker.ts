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
  waitForHeadlessWorkerExit,
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

type ShutdownSignal = Readonly<{
  wait(signal?: AbortSignal): Promise<void>;
  dispose(): void;
}>;

const WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS = 5_000;
const browserTypes = {
  chromium,
  firefox,
  webkit,
} satisfies Record<HeadlessWorkerBrowserEngine, BrowserType>;

let browser: Browser | undefined;
let runningAgents: readonly RunningAgent[] = [];
let shutdown: ShutdownSignal | undefined;
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
  shutdown = createShutdownSignal();
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
  shutdown?.dispose();
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
  shutdown: ShutdownSignal,
): Promise<void> {
  if (config.exitMode === "signal") {
    await shutdown.wait();
    return;
  }

  if (config.exitMode === "after-idle-ms") {
    const idleExitMs = config.idleExitMs;
    if (!idleExitMs) {
      throw new Error("RALLAR_BLACK_BOX_IDLE_EXIT_MS must be a positive integer");
    }
    log(`Worker will stop after idle timeout ${idleExitMs}ms.`);
    await waitForHeadlessWorkerExit({
      waitForShutdown: (signal) => shutdown.wait(signal),
      waitForCompletion: (signal) => delay(idleExitMs, signal),
    });
    return;
  }

  await waitForHeadlessWorkerExit({
    waitForShutdown: (signal) => shutdown.wait(signal),
    waitForCompletion: (signal) =>
      waitForConfiguredDistributedRunTerminal(config, signal),
  });
}

async function waitForConfiguredDistributedRunTerminal(
  config: HeadlessWorkerConfig,
  signal: AbortSignal,
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
    signal,
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Operation aborted"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

async function closeAgents(agents: readonly RunningAgent[]): Promise<void> {
  await Promise.all(
    agents.map(async ({ agent, context }) => {
      log(`Closing agent ${agent.agentId}`);
      await context.close().catch(() => undefined);
    }),
  );
}

function createShutdownSignal(): ShutdownSignal {
  let resolve!: () => void;
  let settled = false;
  const waitPromise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  const dispose = () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
  const stop = (signal: string) => {
    if (settled) {
      return;
    }
    settled = true;
    dispose();
    log(`Received ${signal}; shutting down`);
    resolve();
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    wait: (signal) => {
      if (!signal) {
        return waitPromise;
      }
      return new Promise<void>((innerResolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
          cleanup();
          dispose();
          reject(signal.reason ?? new Error("Operation aborted"));
        };

        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        waitPromise.then(() => {
          cleanup();
          innerResolve();
        });
      });
    },
    dispose,
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
