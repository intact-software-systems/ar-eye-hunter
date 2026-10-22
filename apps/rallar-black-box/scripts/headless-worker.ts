import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';

import type { BlackBoxRallarRuntimeInstallationTarget } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    controlRunSnapshotUrlFromControlUrl,
    readHeadlessWorkerConfig,
    type HeadlessWorkerAgentConfig,
    type HeadlessWorkerBrowserEngine,
    type HeadlessWorkerConfig
} from '../src/headless-worker-config.ts';
import {
    attachHeadlessWorkerPageLogging,
    createHeadlessWorkerLogger,
    logHeadlessWorkerUiConfirmationFailure,
    toHeadlessWorkerLogSecrets,
    waitForDistributedRunTerminal,
    waitForHeadlessWorkerAgentRegistration,
    waitForHeadlessWorkerExit,
    type HeadlessWorkerLogger,
    type HeadlessWorkerRegistrationSnapshot
} from '../src/headless-worker-runtime.ts';

interface RunningAgent {
    readonly agent: HeadlessWorkerAgentConfig;
    readonly context: BrowserContext;
    readonly page: Page;
    readonly pageDisconnectTimeoutMs: number;
}

interface ShutdownSignal {
    readonly signal: AbortSignal;
    wait(signal?: AbortSignal): Promise<void>;
    dispose(): void;
}

interface WaitForShutdownOrAbortInput {
    readonly shutdown: Promise<void>;
    readonly signal: AbortSignal;
}

interface OpenAgentInput {
    readonly browser: Browser;
    readonly agent: HeadlessWorkerAgentConfig;
    readonly config: HeadlessWorkerConfig;
    readonly signal: AbortSignal;
}

class HeadlessWorkerSignalShutdownError extends Error {}

const WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS = 5_000;
const SIGN_IN_REFUSAL_SELECTOR = '.auth-panel .workbench-error[role="status"]';
const browserTypes = {
    chromium,
    firefox,
    webkit
} satisfies Record<HeadlessWorkerBrowserEngine, BrowserType>;

let browser: Browser | undefined;
let runningAgents: readonly RunningAgent[] = [];
let shutdown: ShutdownSignal | undefined;
const bootstrapLogSecrets = toHeadlessWorkerLogSecrets(process.env);
let logger = createWorkerLogger(bootstrapLogSecrets);

try {
    const config = readHeadlessWorkerConfig({ env: process.env });
    logger = createWorkerLogger([
        ...bootstrapLogSecrets,
        config.controlToken,
        config.controlReadToken,
        ...config.agentControlTokens,
        ...config.agentCredentials.map((credentials) => credentials.password)
    ]);
    const activeShutdown = createShutdownSignal();
    shutdown = activeShutdown;
    log(
        `Starting rallar-black-box headless worker run=${config.runId} ` +
            `agents=${config.agentCount} entry=${config.headlessEntry} ` +
            `engine=${config.browserEngine} ` +
            `spa=${config.spaUrl} control=${config.controlUrl}`
    );
    // The worker owns SIGINT and SIGTERM: Playwright's own handlers would close the browser under the pages' disconnect.
    const launchedBrowser = await browserTypes[config.browserEngine].launch({
        headless: config.headless,
        timeout: config.launchTimeoutMs,
        handleSIGINT: false,
        handleSIGTERM: false
    });
    browser = launchedBrowser;

    runningAgents = await Promise.all(
        config.agents.map((agent) =>
            openAgent({ browser: launchedBrowser, agent, config, signal: activeShutdown.signal })
        )
    );

    log(
        `All ${runningAgents.length} rallar-black-box headless agents are registered. ` +
            'Waiting for control-server commands.'
    );
    await waitForWorkerExit(config, activeShutdown);
}
catch (error) {
    if (!(error instanceof HeadlessWorkerSignalShutdownError)) {
        logger.error(toError(error));
        process.exitCode = 1;
    }
}
finally {
    await closeAgents(runningAgents);
    await browser?.close().catch(() => undefined);
    shutdown?.dispose();
    log('Rallar black-box headless worker stopped.');
}

async function openAgent(input: OpenAgentInput): Promise<RunningAgent> {
    const { agent, config } = input;
    log(`Opening agent ${agent.agentId} url=${agent.url}`);
    const context = await input.browser.newContext();
    const page = await context.newPage();
    attachHeadlessWorkerPageLogging({
        agentId: agent.agentId,
        browserLogLevel: config.browserLogLevel,
        page,
        logger
    });

    await page.goto(agent.url, {
        waitUntil: 'domcontentloaded',
        timeout: config.readyTimeoutMs
    });

    await signInIfLoginGateIsVisible(page, agent, config);
    await waitForAgentRegistration({ page, agent, config, signal: input.signal });
    log(`Agent ${agent.agentId} registered in control server`);
    void confirmAgentRegistrationUi(page, agent, config).catch((error) => {
        logHeadlessWorkerUiConfirmationFailure({
            agentId: agent.agentId,
            error: toError(error),
            logger
        });
    });
    return {
        agent,
        context,
        page,
        pageDisconnectTimeoutMs: config.pageDisconnectTimeoutMs
    };
}

async function confirmAgentRegistrationUi(
    page: Page,
    agent: HeadlessWorkerAgentConfig,
    config: HeadlessWorkerConfig
): Promise<void> {
    if (config.headlessEntry === 'operator-spa') {
        await confirmWorkbenchRegistrationUi(page, agent, config);
        return;
    }

    await confirmHeadlessRegistrationUi(page, agent, config);
}

async function signInIfLoginGateIsVisible(
    page: Page,
    agent: HeadlessWorkerAgentConfig,
    config: HeadlessWorkerConfig
): Promise<void> {
    const signIn = page.getByRole('button', { name: 'Sign in' });
    const visible = await signIn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
        return;
    }

    log(`Agent ${agent.agentId} signing in`);
    await signIn.click({ timeout: config.readyTimeoutMs });
}

interface WaitForAgentRegistrationInput {
    readonly page: Page;
    readonly agent: HeadlessWorkerAgentConfig;
    readonly config: HeadlessWorkerConfig;
    readonly signal: AbortSignal;
}

async function waitForAgentRegistration(input: WaitForAgentRegistrationInput): Promise<void> {
    const { page, agent, config } = input;
    await waitForHeadlessWorkerAgentRegistration({
        agentId: agent.agentId,
        timeoutMs: config.readyTimeoutMs,
        pollIntervalMs: 500,
        signal: input.signal,
        fetchSnapshot: (signal) => readControlRunSnapshot(config, signal),
        readAgentPageStatus: () => readAgentPageStatus(page),
        readSignInRefusal: () => readSignInRefusal(page),
        sleep: delay,
        now: Date.now
    });
}

/** The agent page's last action and last error: what an agent that refused to start says. */
async function readAgentPageStatus(page: Page): Promise<string | undefined> {
    const parts = await Promise.all(
        ['[data-last-error]', '[data-last-action]'].map(async (selector) =>
            await page.locator(selector).first().textContent({ timeout: 1_000 }).catch(() => undefined)
        )
    );
    const status = parts.filter((part) => part !== null && part !== undefined && part !== '').join(' | ');
    return status === '' ? undefined : status;
}

async function readSignInRefusal(page: Page): Promise<string> {
    const refusals = await page.locator(SIGN_IN_REFUSAL_SELECTOR).allTextContents();
    return refusals.join(' ').trim();
}

async function confirmWorkbenchRegistrationUi(
    page: Page,
    agent: HeadlessWorkerAgentConfig,
    config: HeadlessWorkerConfig
): Promise<void> {
    const timeout = Math.min(
        config.readyTimeoutMs,
        WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS
    );
    await page.getByRole('tab', { name: 'Local Workbench' }).click({
        timeout
    });
    const controlPanel = page.locator('#panel-local-workbench .control-panel');
    await controlPanel.waitFor({
        state: 'visible',
        timeout
    });
    await controlPanel.getByText('registered', { exact: false }).waitFor({
        state: 'visible',
        timeout
    });
    await controlPanel.getByText(agent.agentId, { exact: false }).waitFor({
        state: 'visible',
        timeout
    }).catch(() => undefined);
}

async function confirmHeadlessRegistrationUi(
    page: Page,
    agent: HeadlessWorkerAgentConfig,
    config: HeadlessWorkerConfig
): Promise<void> {
    const timeout = Math.min(
        config.readyTimeoutMs,
        WORKBENCH_UI_CONFIRMATION_TIMEOUT_MS
    );
    await page.locator('[data-headless-agent-root]').waitFor({
        state: 'visible',
        timeout
    });
    await page.locator('[data-agent-id]').getByText(agent.agentId, {
        exact: false
    }).waitFor({
        state: 'visible',
        timeout
    }).catch(() => undefined);
}

async function readControlRunSnapshot(
    config: HeadlessWorkerConfig,
    signal: AbortSignal
): Promise<HeadlessWorkerRegistrationSnapshot> {
    const response = await fetch(
        controlRunSnapshotUrlFromControlUrl(config.controlUrl, config.runId),
        { headers: controlReadHeaders(config), signal }
    );
    if (!response.ok) {
        throw new Error(
            `Control run snapshot returned HTTP ${response.status}: ` +
                `${await response.text()}`
        );
    }
    return await response.json() as HeadlessWorkerRegistrationSnapshot;
}

async function waitForWorkerExit(
    config: HeadlessWorkerConfig,
    shutdown: ShutdownSignal
): Promise<void> {
    if (config.exitMode === 'signal') {
        await shutdown.wait();
        return;
    }

    if (config.exitMode === 'after-idle-ms') {
        const idleExitMs = config.idleExitMs;
        if (!idleExitMs) {
            throw new Error('RALLAR_BLACK_BOX_IDLE_EXIT_MS must be a positive integer');
        }
        log(`Worker will stop after idle timeout ${idleExitMs}ms.`);
        await waitForHeadlessWorkerExit({
            waitForShutdown: (signal) => shutdown.wait(signal),
            waitForCompletion: (signal) => delay(idleExitMs, signal)
        });
        return;
    }

    await waitForHeadlessWorkerExit({
        waitForShutdown: (signal) => shutdown.wait(signal),
        waitForCompletion: (signal) => waitForConfiguredDistributedRunTerminal(config, signal)
    });
}

async function waitForConfiguredDistributedRunTerminal(
    config: HeadlessWorkerConfig,
    signal: AbortSignal
): Promise<void> {
    const runId = config.targetDistributedRunId;
    if (!runId) {
        throw new Error(
            'RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID is required for terminal distributed-run exit mode.'
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
        log
    });
}

function distributedRunUrl(config: HeadlessWorkerConfig): string {
    if (!config.controlHttpUrl) {
        throw new Error('RALLAR_CONTROL_HTTP_URL could not be derived.');
    }
    if (!config.targetDistributedRunId) {
        throw new Error('RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID is required.');
    }

    const url = new URL(config.controlHttpUrl);
    url.pathname = `/distributed-runs/${encodeURIComponent(config.targetDistributedRunId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function controlReadHeaders(config: HeadlessWorkerConfig): HeadersInit | undefined {
    const token = config.controlReadToken ?? config.controlToken;
    if (!token) {
        return undefined;
    }
    return {
        Authorization: `Bearer ${token}`
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
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(signal?.reason ?? new Error('Operation aborted'));
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
    });
}

async function closeAgents(agents: readonly RunningAgent[]): Promise<void> {
    await Promise.all(
        agents.map(async (runningAgent) => {
            await disconnectAgentPage(runningAgent);
            log(`Closing agent ${runningAgent.agent.agentId}`);
            await runningAgent.context.close().catch(() => undefined);
        })
    );
}

async function disconnectAgentPage(runningAgent: RunningAgent): Promise<void> {
    const { agent, page, pageDisconnectTimeoutMs } = runningAgent;
    const exceeded =
        `Agent ${agent.agentId} page disconnect exceeded ${pageDisconnectTimeoutMs}ms; closing its context`;
    const boundController = new AbortController();
    const disconnected = page.evaluate(closeAgentPageRuntime).then(
        () => `Agent ${agent.agentId} page disconnected`,
        (error) => `Agent ${agent.agentId} page disconnect failed: ${toError(error).message}`
    );
    const bound = delay(pageDisconnectTimeoutMs, boundController.signal).then(() => exceeded, () => exceeded);
    log(`Disconnecting agent ${agent.agentId} page`);
    log(await Promise.race([disconnected, bound]));
    boundController.abort();
}

/** Runs in the agent page; the page runtime's close leaves, logs out and disconnects as its launch configured. */
async function closeAgentPageRuntime(): Promise<void> {
    const target: BlackBoxRallarRuntimeInstallationTarget = window;
    await target.__blackBoxRallar?.close();
}

function createShutdownSignal(): ShutdownSignal {
    const shutdownController = new AbortController();
    const settledController = new AbortController();
    const waitPromise = new Promise<void>((resolve) => {
        settledController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const onSigint = () => stop('SIGINT');
    const onSigterm = () => stop('SIGTERM');
    const removeListeners = () => {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
    };
    const dispose = () => {
        removeListeners();
        if (!shutdownController.signal.aborted) {
            shutdownController.abort(new Error('Headless worker shutdown disposed'));
        }
        settledController.abort();
    };
    const stop = (signal: string) => {
        if (settledController.signal.aborted) {
            return;
        }
        log(`Received ${signal}; shutting down`);
        shutdownController.abort(new HeadlessWorkerSignalShutdownError(`Received ${signal}; shutting down`));
        settledController.abort();
    };

    // The listeners stay until dispose: the tsx launcher exits the process on a signal no listener remains for.
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    return {
        signal: shutdownController.signal,
        wait: (signal) =>
            signal === undefined ? waitPromise : waitForShutdownOrAbort({ shutdown: waitPromise, signal }),
        dispose
    };
}

function waitForShutdownOrAbort(input: WaitForShutdownOrAbortInput): Promise<void> {
    const { signal } = input;
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            cleanup();
            reject(signal.reason ?? new Error('Operation aborted'));
        };

        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        void input.shutdown.then(() => {
            cleanup();
            resolve();
        });
    });
}

function log(message: string): void {
    logger.log(message);
}

function createWorkerLogger(
    secrets: readonly (string | undefined)[]
): HeadlessWorkerLogger {
    return createHeadlessWorkerLogger({
        secrets,
        now: () => new Date(),
        writeLog: console.log,
        writeError: console.error
    });
}
