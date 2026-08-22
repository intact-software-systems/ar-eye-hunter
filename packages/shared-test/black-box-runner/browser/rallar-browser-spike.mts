import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

type JsonObject = Record<string, unknown>;

type SpikeConfig = {
    browser?: {
        headless?: boolean;
        slowMo?: number;
        timeoutMs?: number;
        launchArgs?: readonly string[];
    };
    harness?: {
        url?: string;
        host?: string;
        port?: number;
    };
    report?: {
        outFile?: string;
        stdout?: boolean;
    };
    connections: Record<string, JsonObject>;
    steps: SpikeStep[];
};

type SpikeStep = {
    name?: string;
    type?: string;
    connection?: string;
    request?: JsonObject;
    expect?: JsonObject;
    withinMs?: number;
};

type RuntimeEvent = {
    kind?: string;
    topic?: string;
    atEpochMs?: number;
    data?: unknown;
    error?: unknown;
    [key: string]: unknown;
};

type ConnectionState = {
    connection: string;
    active: boolean;
    context: BrowserContext;
    page: Page;
    events: RuntimeEvent[];
    diagnostics: RuntimeEvent[];
    messages: RuntimeEvent[];
    closes: RuntimeEvent[];
    connectDiagnostics?: JsonObject;
};

type StepReport = {
    name: string;
    type: string;
    connection?: string;
    status: 'passed' | 'failed';
    startedAtEpochMs: number;
    finishedAtEpochMs: number;
    durationMs: number;
    response?: unknown;
    error?: unknown;
};

type SpikeReport = {
    summary: {
        status: 'passed' | 'failed';
        totalSteps: number;
        executedSteps: number;
        passedSteps: number;
        failedSteps: number;
        startedAtEpochMs: number;
        finishedAtEpochMs: number;
        durationMs: number;
    };
    harnessUrl: string;
    steps: StepReport[];
    connections: Record<string, {
        connected: boolean;
        diagnostics: RuntimeEvent[];
        messages: RuntimeEvent[];
        closeEvents: RuntimeEvent[];
        connectDiagnostics?: JsonObject;
    }>;
};

const RALLAR_HARNESS_PATH = '/packages/shared-test/black-box-runner/browser/rallar-browser-harness.html';
const DEFAULT_TIMEOUT_MS = 10_000;

function usage(): string {
    return [
        'Usage:',
        '  tsx packages/shared-test/black-box-runner/browser/rallar-browser-spike.mts --config <file>',
        '',
        'Options:',
        '  --config <file>       JSON spike config.',
        '  --harness-url <url>   Reuse an already served harness page.',
        '  --headless <bool>     Override browser.headless.',
        '  --help                Print this help.'
    ].join('\n');
}

function parseArgs(argv: readonly string[]): {
    configPath?: string;
    harnessUrl?: string;
    headless?: boolean;
    help?: boolean;
} {
    const parsed: {
        configPath?: string;
        harnessUrl?: string;
        headless?: boolean;
        help?: boolean;
    } = {};

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }
        if (arg === '--config') {
            parsed.configPath = argv[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--harness-url') {
            parsed.harnessUrl = argv[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--headless') {
            parsed.headless = parseBoolean(argv[i + 1], '--headless');
            i += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return parsed;
}

function parseBoolean(value: string | undefined, flag: string): boolean {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`${flag} must be true or false.`);
}

async function readConfig(configPath: string): Promise<SpikeConfig> {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as SpikeConfig;
    const expanded = expandEnv(parsed) as SpikeConfig;
    if (!expanded.connections || typeof expanded.connections !== 'object') {
        throw new Error('Config must define connections.');
    }
    if (!Array.isArray(expanded.steps)) {
        throw new Error('Config must define steps.');
    }
    return expanded;
}

function expandEnv(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => {
            const envValue = process.env[name];
            if (envValue === undefined) {
                throw new Error(`Missing environment variable: ${name}`);
            }
            return envValue;
        });
    }
    if (Array.isArray(value)) {
        return value.map(expandEnv);
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, expandEnv(entry)])
        );
    }
    return value;
}

async function startHarnessServer(config: SpikeConfig): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const currentFile = fileURLToPath(import.meta.url);
    const browserDir = path.dirname(currentFile);
    const repoRoot = path.resolve(browserDir, '../../../..');
    const server: ViteDevServer = await createServer({
        configFile: false,
        root: repoRoot,
        logLevel: 'error',
        resolve: {
            alias: {
                '@shared-test': path.resolve(repoRoot, 'packages/shared-test'),
                '@shared-server': path.resolve(repoRoot, 'packages/shared-server'),
                '@shared-web': path.resolve(repoRoot, 'packages/shared-web'),
                '@shared-graph': path.resolve(repoRoot, 'packages/shared-graph'),
                '@shared': path.resolve(repoRoot, 'packages/shared'),
                '@relic-hunters': path.resolve(repoRoot, 'packages/relic-hunters')
            }
        },
        server: {
            host: config.harness?.host ?? '127.0.0.1',
            port: config.harness?.port ?? 5199,
            strictPort: false,
            fs: {
                allow: [repoRoot]
            }
        }
    });

    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0] ??
        `http://${config.harness?.host ?? '127.0.0.1'}:${config.harness?.port ?? 5199}/`;
    return {
        url: new URL(RALLAR_HARNESS_PATH, baseUrl).toString(),
        close: async () => {
            await server.close();
        }
    };
}

async function createConnectionState(
    browser: Browser,
    harnessUrl: string,
    config: SpikeConfig,
    connection: string
): Promise<ConnectionState> {
    const timeoutMs = config.browser?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const context = await browser.newContext();
    const page = await context.newPage();
    const state: ConnectionState = {
        connection,
        active: true,
        context,
        page,
        events: [],
        diagnostics: [],
        messages: [],
        closes: []
    };

    const record = (event: RuntimeEvent): void => {
        state.events.push(event);
        if (event.kind === 'message') {
            state.messages.push(event);
        }
        else if (event.kind === 'close') {
            state.closes.push(event);
        }
        else {
            state.diagnostics.push(event);
        }
    };

    await page.exposeFunction('__blackBoxRallarEmit', (event: RuntimeEvent) => {
        record(event);
    });

    page.on('console', (message) => {
        record({
            kind: 'diagnostic',
            topic: 'browser.console',
            atEpochMs: Date.now(),
            connection,
            data: {
                type: message.type(),
                text: message.text(),
                location: message.location()
            }
        });
    });
    page.on('pageerror', (error) => {
        record({
            kind: 'diagnostic',
            topic: 'browser.pageerror',
            atEpochMs: Date.now(),
            connection,
            error: serializeError(error)
        });
    });
    page.on('requestfailed', (request) => {
        record({
            kind: 'diagnostic',
            topic: 'browser.requestfailed',
            atEpochMs: Date.now(),
            connection,
            data: {
                url: request.url(),
                method: request.method(),
                failure: request.failure()
            }
        });
    });

    await page.goto(harnessUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
    });
    await page.waitForFunction(
        () => Boolean((window as unknown as { __blackBoxRallar?: unknown; }).__blackBoxRallar),
        undefined,
        { timeout: timeoutMs }
    );
    return state;
}

async function runConnectStep(
    browser: Browser,
    harnessUrl: string,
    config: SpikeConfig,
    states: Map<string, ConnectionState>,
    step: SpikeStep
): Promise<unknown> {
    const connectionName = requireConnectionName(step);
    const existing = states.get(connectionName);
    if (existing?.active) {
        throw new Error(`Connection already exists: ${connectionName}`);
    }

    const connectionConfig = config.connections[connectionName];
    if (!connectionConfig) {
        throw new Error(`Unknown connection: ${connectionName}`);
    }

    const state = await createConnectionState(browser, harnessUrl, config, connectionName);
    states.set(connectionName, state);
    const requestRallar = isRecord(step.request?.rallar) ? step.request.rallar : {};
    const connectionRallar = isRecord(connectionConfig.rallar)
        ? connectionConfig.rallar
        : {};
    const runtimeConfig = {
        ...connectionConfig,
        ...step.request,
        rallar: {
            ...connectionRallar,
            ...requestRallar
        },
        connection: connectionName,
        actor: String(connectionConfig.actor ?? step.request?.actor ?? connectionName)
    };
    const response = await state.page.evaluate(
        async (input) =>
            await (window as unknown as {
                __blackBoxRallar: {
                    connect(config: unknown): Promise<JsonObject>;
                };
            }).__blackBoxRallar.connect(input),
        runtimeConfig
    );
    state.connectDiagnostics = response;
    return response;
}

async function runSendStep(
    states: Map<string, ConnectionState>,
    step: SpikeStep
): Promise<unknown> {
    const connectionName = requireConnectionName(step);
    const state = requireState(states, connectionName);
    const request = step.request ?? {};
    const rawSend = hasOwn(request, 'send') ? request.send : request;
    const sendInput = normalizeDriverSendInput(rawSend);
    const expectedConnection = readString(step.expect?.connection);
    const targetState = expectedConnection ? requireState(states, expectedConnection) : undefined;
    const targetStartIndex = targetState?.events.length ?? 0;
    if (
        targetState?.connectDiagnostics?.sessionId &&
        !hasOwn(sendInput, 'peerIds') &&
        !hasOwn(sendInput, 'remotePeerId')
    ) {
        sendInput.peerIds = [String(targetState.connectDiagnostics.sessionId)];
    }

    const response = await state.page.evaluate(
        async (input) =>
            await (window as unknown as {
                __blackBoxRallar: {
                    send(message: unknown): Promise<JsonObject>;
                };
            }).__blackBoxRallar.send(input),
        sendInput
    );

    assertSendResponse(response, Boolean(step.expect));

    if (step.expect && hasOwn(step.expect, 'message')) {
        if (!expectedConnection || !targetState) {
            throw new Error('rtc.send expect.message requires expect.connection.');
        }
        const withinMs = readNumber(step.expect.withinMs) ?? step.withinMs ??
            DEFAULT_TIMEOUT_MS;
        const event = await waitForMessage(
            targetState,
            step.expect.message,
            withinMs,
            targetStartIndex
        );
        return {
            send: response,
            received: event
        };
    }

    return response;
}

async function runWaitStep(
    states: Map<string, ConnectionState>,
    step: SpikeStep
): Promise<unknown> {
    const connectionName = requireConnectionName(step);
    const state = requireState(states, connectionName);
    const request = step.request ?? {};
    const expected = step.expect?.message ?? request.message ?? request.expect;
    if (expected === undefined) {
        throw new Error('rtc.wait requires expect.message or request.message.');
    }
    const withinMs = readNumber(step.expect?.withinMs) ?? readNumber(request.withinMs) ??
        step.withinMs ?? DEFAULT_TIMEOUT_MS;
    return await waitForMessage(state, expected, withinMs, state.events.length);
}

async function runHealthStep(
    states: Map<string, ConnectionState>,
    step: SpikeStep
): Promise<unknown> {
    const state = requireState(states, requireConnectionName(step));
    return await state.page.evaluate(
        async () =>
            await (window as unknown as {
                __blackBoxRallar: {
                    health(): Promise<JsonObject>;
                };
            }).__blackBoxRallar.health()
    );
}

async function runCloseStep(
    states: Map<string, ConnectionState>,
    step: SpikeStep
): Promise<unknown> {
    const connectionName = requireConnectionName(step);
    const state = requireState(states, connectionName);
    const response = await state.page.evaluate(
        async () =>
            await (window as unknown as {
                __blackBoxRallar: {
                    close(): Promise<JsonObject>;
                };
            }).__blackBoxRallar.close()
    );
    await state.context.close();
    state.active = false;
    return response;
}

function assertSendResponse(response: unknown, hasExpectation: boolean): void {
    if (!isRecord(response)) {
        return;
    }
    if (response.status === 'no-peers' && hasExpectation) {
        throw new Error('Realtime send resolved no target peers.');
    }
    const failed = Array.isArray(response.results)
        ? response.results.filter((entry) =>
            isRecord(entry) &&
            isRecord(entry.result) &&
            (entry.result.status === 'closed' || entry.result.status === 'dropped')
        )
        : [];
    if (failed.length > 0) {
        throw new Error(`Realtime send failed for ${failed.length} peer(s).`);
    }
}

async function waitForMessage(
    state: ConnectionState,
    expected: unknown,
    timeoutMs: number,
    fromIndex: number
): Promise<RuntimeEvent> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const event = state.events.slice(fromIndex).find((candidate) =>
            candidate.kind === 'message' && matchesExpectedMessage(candidate, expected)
        );
        if (event) {
            return event;
        }
        await delay(50);
    }

    throw new Error(
        `Timed out after ${timeoutMs}ms waiting for message on ${state.connection}.`
    );
}

function matchesExpectedMessage(event: RuntimeEvent, expected: unknown): boolean {
    if (
        isRecord(expected) &&
        ['kind', 'topic', 'data', 'roomId', 'laneId', 'peerId', 'remotePeerId']
            .some((key) => hasOwn(expected, key))
    ) {
        return isSubset(expected, event);
    }

    return isSubset(expected, event.data);
}

function isSubset(expected: unknown, actual: unknown): boolean {
    if (expected === actual) {
        return true;
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length < expected.length) {
            return false;
        }
        return expected.every((entry, index) => isSubset(entry, actual[index]));
    }
    if (isRecord(expected)) {
        if (!isRecord(actual)) {
            return false;
        }
        return Object.entries(expected).every(([key, value]) => hasOwn(actual, key) && isSubset(value, actual[key]));
    }
    return false;
}

function normalizeDriverSendInput(raw: unknown): JsonObject {
    if (isRecord(raw) && !Array.isArray(raw)) {
        return { ...raw };
    }
    return { data: raw };
}

async function runStep(
    browser: Browser,
    harnessUrl: string,
    config: SpikeConfig,
    states: Map<string, ConnectionState>,
    step: SpikeStep,
    index: number
): Promise<StepReport> {
    const startedAtEpochMs = Date.now();
    const type = actionType(step);
    const name = step.name ?? `step-${index + 1}`;
    try {
        const response = await runStepAction(browser, harnessUrl, config, states, step, type);
        const finishedAtEpochMs = Date.now();
        return {
            name,
            type,
            connection: step.connection,
            status: 'passed',
            startedAtEpochMs,
            finishedAtEpochMs,
            durationMs: finishedAtEpochMs - startedAtEpochMs,
            response
        };
    }
    catch (error) {
        const finishedAtEpochMs = Date.now();
        return {
            name,
            type,
            connection: step.connection,
            status: 'failed',
            startedAtEpochMs,
            finishedAtEpochMs,
            durationMs: finishedAtEpochMs - startedAtEpochMs,
            error: serializeError(error)
        };
    }
}

async function runStepAction(
    browser: Browser,
    harnessUrl: string,
    config: SpikeConfig,
    states: Map<string, ConnectionState>,
    step: SpikeStep,
    type: string
): Promise<unknown> {
    switch (type) {
        case 'connect':
            return await runConnectStep(browser, harnessUrl, config, states, step);
        case 'send':
            return await runSendStep(states, step);
        case 'wait':
            return await runWaitStep(states, step);
        case 'health':
            return await runHealthStep(states, step);
        case 'close':
            return await runCloseStep(states, step);
        default:
            throw new Error(`Unsupported RTC spike step type: ${type}`);
    }
}

function actionType(step: SpikeStep): string {
    const raw = step.type ?? readString(step.request?.action);
    if (!raw) {
        throw new Error(`Step ${step.name ?? '<unnamed>'} is missing type.`);
    }
    const segments = raw.split('.');
    return segments[segments.length - 1] ?? raw;
}

function requireConnectionName(step: SpikeStep): string {
    if (!step.connection) {
        throw new Error(`Step ${step.name ?? '<unnamed>'} is missing connection.`);
    }
    return step.connection;
}

function requireState(
    states: Map<string, ConnectionState>,
    connection: string
): ConnectionState {
    const state = states.get(connection);
    if (!state || !state.active) {
        throw new Error(`Connection is not active: ${connection}`);
    }
    return state;
}

async function closeRemaining(states: Map<string, ConnectionState>): Promise<void> {
    await Promise.all(
        [...states.values()].filter((state) => state.active).map(async (state) => {
            try {
                await state.page.evaluate(
                    async () =>
                        await (window as unknown as {
                            __blackBoxRallar?: {
                                close(): Promise<unknown>;
                            };
                        }).__blackBoxRallar?.close()
                );
            }
            catch {
                // The report already contains page diagnostics; cleanup should not hide it.
            }
            await state.context.close().catch(() => undefined);
            state.active = false;
        })
    );
}

function toConnectionReport(states: Map<string, ConnectionState>): SpikeReport['connections'] {
    return Object.fromEntries(
        [...states.entries()].map(([connection, state]) => [
            connection,
            {
                connected: state.active,
                diagnostics: state.diagnostics,
                messages: state.messages,
                closeEvents: state.closes,
                connectDiagnostics: state.connectDiagnostics
            }
        ])
    );
}

function serializeError(error: unknown): unknown {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }
    return error;
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null;
}

function hasOwn(value: JsonObject, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        return;
    }
    if (!args.configPath) {
        throw new Error(`Missing --config.\n${usage()}`);
    }

    const configPath = path.resolve(args.configPath);
    const configDir = path.dirname(configPath);
    const config = await readConfig(configPath);
    const configuredHarnessUrl = args.harnessUrl ?? config.harness?.url;
    const harness = configuredHarnessUrl
        ? {
            url: configuredHarnessUrl,
            close: async () => undefined
        }
        : await startHarnessServer(config);
    const headless = args.headless ?? config.browser?.headless ?? true;
    const startedAtEpochMs = Date.now();
    const states = new Map<string, ConnectionState>();
    const browser = await chromium.launch({
        headless,
        slowMo: config.browser?.slowMo,
        args: [...(config.browser?.launchArgs ?? [])]
    });

    try {
        const steps: StepReport[] = [];
        for (let index = 0; index < config.steps.length; index += 1) {
            const step = config.steps[index];
            const report = await runStep(
                browser,
                harness.url,
                config,
                states,
                step,
                index
            );
            steps.push(report);
            if (report.status === 'failed') {
                break;
            }
        }

        const finishedAtEpochMs = Date.now();
        const failedSteps = steps.filter((step) => step.status === 'failed').length;
        const report: SpikeReport = {
            summary: {
                status: failedSteps === 0 ? 'passed' : 'failed',
                totalSteps: config.steps.length,
                executedSteps: steps.length,
                passedSteps: steps.length - failedSteps,
                failedSteps,
                startedAtEpochMs,
                finishedAtEpochMs,
                durationMs: finishedAtEpochMs - startedAtEpochMs
            },
            harnessUrl: harness.url,
            steps,
            connections: toConnectionReport(states)
        };

        if (config.report?.outFile) {
            const outFile = path.resolve(configDir, config.report.outFile);
            await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
        }
        if (config.report?.stdout ?? true) {
            console.log(JSON.stringify(report, null, 2));
        }
        process.exitCode = failedSteps === 0 ? 0 : 1;
    }
    finally {
        await closeRemaining(states);
        await browser.close();
        await harness.close();
    }
}

main().catch((error) => {
    console.error(JSON.stringify(
        {
            status: 'failed',
            error: serializeError(error)
        },
        null,
        2
    ));
    process.exitCode = 1;
});
