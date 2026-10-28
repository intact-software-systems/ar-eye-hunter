import type { Browser, BrowserContext, ConsoleMessage, LaunchOptions, Page, Request } from '@playwright/test';
import type { InlineConfig, ViteDevServer } from 'vite';
import type { ApiJsonValue } from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';
import type {
    BlackBoxRallarRuntime,
    BlackBoxRallarRuntimeInstallationTarget
} from './rallar-browser-runtime/black-box-rallar-runtime.ts';

import type {
    RallarBrowserDependencies,
    RallarBrowserRtcProviderOptions
} from '../rallar-browser-rtc-provider.ts';
import type {
    RallarRtcClientArgs,
    RallarRtcClientEventDispatcher,
    RallarRtcRuntimeSession
} from '../rallar-rtc-provider.ts';
import { toRallarScopeDiagnostics } from '../recipes/recipe-rallar-scope.ts';
import { toBrowserRuntimeConfig } from './browser-rtc-requests.ts';
import type {
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtCommandDiagnostics,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarEvent,
    BlackBoxRallarSendDiagnostics
} from './rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { toBlackBoxRallarSerializedError } from './rallar-browser-runtime/black-box-rallar-serialized-error.ts';

export interface RallarBrowserProviderState {
    dependencies?: Promise<RallarBrowserDependencies>;
    viteServer?: ViteDevServer;
    harnessUrl?: string;
    browser?: Browser;
    sessions: Map<string, RallarBrowserSession>;
}

interface RallarBrowserCleanupOptions {
    reason?: string;
    closeContext?: boolean;
    diagnostic?: (topic: string, data?: BlackBoxRallarEvent['data']) => void;
}

const RALLAR_BROWSER_STATE_KEY = Symbol.for('rallar.black-box-runner.browser-provider-state');
const RALLAR_BROWSER_HARNESS_PATH = '/packages/shared-test/black-box-runner/browser/rallar-browser-harness.html';

export function initRallarBrowserProviderState(
    context: { [RALLAR_BROWSER_STATE_KEY]?: RallarBrowserProviderState; }
): RallarBrowserProviderState {
    if (!context[RALLAR_BROWSER_STATE_KEY]) {
        context[RALLAR_BROWSER_STATE_KEY] = { sessions: new Map<string, RallarBrowserSession>() };
    }
    return context[RALLAR_BROWSER_STATE_KEY];
}

export namespace RallarBrowserSession {
    export interface LocalDiagnostics {
        readonly status: 'local-only';
        readonly connection: string;
        readonly sessionId?: never;
    }

    export interface BrowserSettings {
        readonly headless?: boolean;
        readonly slowMo?: number;
        readonly launchArgs?: readonly string[];
        readonly timeoutMs?: number;
    }
    export interface HarnessSettings {
        readonly host?: string;
        readonly port?: number;
        readonly strictPort?: boolean;
    }

    export interface Dependencies {
        readonly now: () => number;
        readonly args: RallarRtcClientArgs;
        readonly dispatcher: RallarRtcClientEventDispatcher;
        readonly state: RallarBrowserProviderState;
        readonly options: RallarBrowserRtcProviderOptions;
    }
}

export class RallarBrowserSession implements RallarRtcRuntimeSession {
    private readonly dependencies: RallarBrowserSession.Dependencies;
    private browserContext: BrowserContext | undefined;
    private page: Page | undefined;
    private closed = false;
    private setupPhase = 'dependencies';
    private harnessUrl = '';
    connectDiagnostics: BlackBoxRallarConnectDiagnostics | RallarBrowserSession.LocalDiagnostics | undefined;

    constructor(dependencies: RallarBrowserSession.Dependencies) {
        this.dependencies = dependencies;
    }

    async start(connectRuntime: boolean): Promise<void> {
        const { state, options, args } = this.dependencies;
        const existingSession = state.sessions.get(args.connection);
        if (existingSession && !existingSession.closed) {
            throw new Error('rallar-browser connection is already open: ' + args.connection);
        }
        try {
            state.dependencies = state.dependencies || readBrowserDependencies(options);
            const dependencies = await state.dependencies;
            this.setupPhase = 'harness';
            this.harnessUrl = await startBrowserHarness(state, dependencies, options);
            this.setupPhase = 'browser';
            const browser = await startBrowser(state, dependencies, options);
            const timeoutMs = toBrowserTimeoutMs(args, options);
            this.setupPhase = 'context';
            this.browserContext = await browser.newContext();
            this.setupPhase = 'page';
            this.page = await this.browserContext.newPage();
            state.sessions.set(args.connection, this);
            this.setupPhase = 'runtime-bridge';
            await this.page.exposeFunction('__blackBoxRallarEmit', this.dispatchBrowserEvent.bind(this));
            this.registerPageObservations();
            this.setupPhase = 'page-load';
            await this.page.goto(this.harnessUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            await this.page.waitForFunction(
                () => Boolean((window as Window & BlackBoxRallarRuntimeInstallationTarget).__blackBoxRallar),
                undefined,
                { timeout: timeoutMs }
            );
            if (connectRuntime) {
                this.setupPhase = 'runtime-connect';
            }
            await this.startRuntime(connectRuntime);
        }
        catch (error) {
            this.recordSetupFailure(error);
            await this.closeResources('connect-failed');
            throw error;
        }
    }

    async send(message: ApiJsonValue): Promise<BlackBoxRallarSendDiagnostics> {
        let response: BlackBoxRallarSendDiagnostics | undefined;
        try {
            response = await this.requirePage().evaluate<
                BlackBoxRallarSendDiagnostics,
                Parameters<BlackBoxRallarRuntime['send']>[0]
            >(
                async (input) =>
                    await (window as Window & BlackBoxRallarRuntimeInstallationTarget).__blackBoxRallar!.send(input),
                message
            );
            this.diagnostic('rallar.browser.provider.send_completed', response);
            const validated = validateBrowserSendResult(response);
            if (validated.left) {
                throw validated.left;
            }
            return response;
        }
        catch (error) {
            const diagnostics = { response, error: toBrowserErrorDetails(error) };
            this.diagnostic('rallar.browser.provider.send_failed', diagnostics);
            throw new RallarBrowserOperationError({ cause: toBrowserError(error), sendResult: response, diagnostics });
        }
    }

    async command(action: string, request: ApiJsonValue): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        let response: BlackBoxRallarCrdtCommandDiagnostics | undefined;
        try {
            response = await this.requirePage().evaluate<
                BlackBoxRallarCrdtCommandDiagnostics,
                { action: string; request: Parameters<BlackBoxRallarCrdtRuntime['open']>[0]; }
            >(
                async (input) => {
                    const runtime = (window as Window & BlackBoxRallarRuntimeInstallationTarget).__blackBoxRallar?.crdt;
                    const command = runtime === undefined
                        ? undefined
                        : Object.entries(runtime).find(([name]) => name === input.action)?.[1];
                    if (typeof command !== 'function') {
                        throw new Error('Browser Rallar runtime does not support CRDT action: ' + input.action);
                    }
                    return await command(input.request);
                },
                { action, request }
            );
            this.diagnostic('rallar.browser.provider.crdt_command_completed', { action, request, response });
            return response;
        }
        catch (error) {
            const diagnostics = { action, request, response, error: toBrowserErrorDetails(error) };
            this.diagnostic('rallar.browser.provider.crdt_command_failed', diagnostics);
            throw new RallarBrowserOperationError({ cause: toBrowserError(error), sendResult: undefined, diagnostics });
        }
    }

    async close(): Promise<void> {
        try {
            if (!this.closed) {
                try {
                    await this.requirePage().evaluate(async () =>
                        await (window as Window & BlackBoxRallarRuntimeInstallationTarget).__blackBoxRallar!.close()
                    );
                }
                catch (error) {
                    this.diagnostic('rallar.browser.provider.runtime_close_failed', {
                        error: toBrowserErrorDetails(error)
                    });
                }
                this.dispatchProviderClose({});
            }
        }
        finally {
            await this.closeResources('close');
        }
    }

    private requirePage(): Page {
        if (this.page === undefined) {
            throw new Error('Browser session has no accepted page');
        }
        return this.page;
    }

    private registerPageObservations(): void {
        this.requirePage().on('console', (message) => {
            const diagnostic = toConsoleMessageDiagnostic(message);
            this.diagnostic(toConsoleMessageTopic(diagnostic.type), diagnostic);
        });
        this.requirePage().on('pageerror', (error) => {
            this.diagnostic('rallar.browser.pageerror', { error: toBrowserErrorDetails(error) });
        });
        this.requirePage().on('requestfailed', (request) => {
            const diagnostic = toRequestFailedDiagnostic(request);
            this.diagnostic(
                isRallarRequestUrl(this.dependencies.args, diagnostic.url)
                    ? 'rallar.browser.rallar_request_failed'
                    : 'rallar.browser.requestfailed',
                diagnostic
            );
        });
        this.requirePage().on('close', this.onPageClose.bind(this));
    }

    private async onPageClose(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.dispatchProviderClose({ phase: 'page-close', reason: 'browser page closed' });
        try {
            await this.closeResources('page-close');
        }
        catch (error) {
            this.diagnostic('rallar.browser.provider.page_close_cleanup_failed', {
                error: toBrowserErrorDetails(error)
            });
        }
    }

    private async startRuntime(connectRuntime: boolean): Promise<void> {
        const { args } = this.dependencies;
        this.connectDiagnostics = connectRuntime
            ? await this.requirePage().evaluate(
                async (input: BlackBoxRallarConnectionConfig) =>
                    await (window as Window & BlackBoxRallarRuntimeInstallationTarget).__blackBoxRallar!.connect(input),
                toBrowserRuntimeConfig(args)
            )
            : { status: 'local-only', connection: args.connection };
        this.diagnostic(
            connectRuntime ? 'rallar.browser.provider.connected' : 'rallar.browser.provider.local_crdt_session_ready',
            { harnessUrl: this.harnessUrl, connectDiagnostics: this.connectDiagnostics }
        );
    }

    private recordSetupFailure(error: unknown): void {
        if (this.setupPhase === 'page-load') {
            this.diagnostic('rallar.browser.provider.page_load_failed', {
                harnessUrl: this.harnessUrl,
                error: toBrowserErrorDetails(error)
            });
        }
        else if (this.setupPhase === 'runtime-connect') {
            this.diagnostic('rallar.browser.provider.runtime_connect_failed', {
                harnessUrl: this.harnessUrl,
                error: toBrowserErrorDetails(error)
            });
        }
        this.diagnostic('rallar.browser.provider.connect_failed', {
            phase: this.setupPhase,
            error: toBrowserErrorDetails(error)
        });
    }

    private async closeResources(reason: string): Promise<void> {
        const { state, args } = this.dependencies;
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (state.sessions.get(args.connection) === this) {
            state.sessions.delete(args.connection);
        }
        if (this.browserContext) {
            try {
                await this.browserContext.close();
                this.diagnostic('rallar.browser.provider.context_closed', { connection: args.connection, reason });
            }
            catch (error) {
                this.diagnostic('rallar.browser.provider.context_close_failed', {
                    connection: args.connection,
                    reason,
                    error: toBrowserErrorDetails(error)
                });
            }
        }
        await closeSharedResourcesIfIdle(state, { reason, diagnostic: this.diagnostic.bind(this) });
    }

    private dispatchBrowserEvent(event: BlackBoxRallarEvent): void {
        const { args, dispatcher } = this.dependencies;
        const normalized = {
            ...event,
            connection: event.connection || args.connection,
            actor: event.actor || args.actor,
            provider: args.provider,
            peerId: event.peerId || args.peerId,
            roomId: event.roomId || args.roomId,
            groupId: args.groupId,
            overlayId: args.overlayId,
            ...toRallarScopeDiagnostics(args.request, event.roomId || args.roomId)
        };
        if (event.kind === 'close') {
            dispatcher.emitClose(normalized);
        }
        else {
            dispatcher.emitMessage(normalized);
        }
    }

    private diagnostic(topic: string, data: BlackBoxRallarEvent['data'] = {}): void {
        const { args, dispatcher } = this.dependencies;
        dispatcher.emitMessage({
            kind: 'diagnostic',
            topic,
            atEpochMs: this.dependencies.now(),
            connection: args.connection,
            actor: args.actor,
            provider: args.provider,
            peerId: args.peerId,
            remotePeerId: args.remotePeerId,
            roomId: args.roomId,
            groupId: args.groupId,
            overlayId: args.overlayId,
            ...toRallarScopeDiagnostics(args.request, args.roomId),
            data
        });
    }

    private dispatchProviderClose(data: { readonly phase?: string; readonly reason?: string; }): void {
        const { args, dispatcher } = this.dependencies;
        dispatcher.emitClose({
            phase: 'close',
            reason: 'closed by rallar-browser provider',
            closedBy: 'rallar-browser-provider',
            connection: args.connection,
            actor: args.actor,
            provider: args.provider,
            peerId: args.peerId,
            remotePeerId: args.remotePeerId,
            roomId: args.roomId,
            groupId: args.groupId,
            overlayId: args.overlayId,
            ...toRallarScopeDiagnostics(args.request, args.roomId),
            closedAtEpochMs: this.dependencies.now(),
            ...data
        });
    }
}

namespace RallarBrowserOperationError {
    export interface Input {
        readonly cause: Error;
        readonly sendResult: BlackBoxRallarSendDiagnostics | BlackBoxRallarCrdtCommandDiagnostics | undefined;
        readonly diagnostics: BlackBoxRallarEvent['data'];
    }
}

class RallarBrowserOperationError extends Error {
    readonly sendResult: BlackBoxRallarSendDiagnostics | BlackBoxRallarCrdtCommandDiagnostics | undefined;
    readonly diagnostics: BlackBoxRallarEvent['data'];

    constructor(failure: RallarBrowserOperationError.Input) {
        super(failure.cause.message, { cause: failure.cause });
        this.sendResult = failure.sendResult;
        this.diagnostics = failure.diagnostics;
    }
}

function validateBrowserSendResult(response: BlackBoxRallarSendDiagnostics): Either<Error, true> {
    if ('status' in response && response.status === 'no-peers') {
        return Either.ofLeft(new Error('Rallar browser RTC send resolved no target peers.'));
    }
    const failed = 'results' in response
        ? response.results.filter((entry) => entry?.result?.status === 'closed' || entry?.result?.status === 'dropped')
        : [];
    if (failed.length > 0) {
        const statuses = [...new Set(failed.map((entry) => entry?.result?.status))].filter(Boolean).join(', ');
        return Either.ofLeft(
            new Error('Rallar browser RTC send failed for ' + failed.length + ' peer(s). status=' + statuses)
        );
    }
    return Either.ofRight(true);
}

function isDenoRuntime(): boolean {
    return 'Deno' in globalThis;
}

async function loadDependencies(): Promise<RallarBrowserDependencies> {
    try {
        const playwright = await import(
            isDenoRuntime() ? 'npm:@playwright/test' : '@playwright/test'
        );
        const vite = await import(isDenoRuntime() ? 'npm:vite' : 'vite');
        const path = await import('node:path');
        const url = await import('node:url');

        return {
            chromium: playwright.chromium,
            createServer: vite.createServer,
            path,
            fileURLToPath: url.fileURLToPath
        };
    }
    catch (e) {
        throw new Error(
            'The rallar-browser RTC provider requires Playwright and Vite. ' +
                'Run it in the npm workspace, or use a Deno runtime that can resolve npm:@playwright/test and npm:vite. ' +
                'Cause: ' + (e instanceof Error ? e.message : String(e))
        );
    }
}

async function readBrowserDependencies(
    options: RallarBrowserRtcProviderOptions
): Promise<RallarBrowserDependencies> {
    if (!options.dependencies) {
        return await loadDependencies();
    }

    const dependencies = typeof options.dependencies === 'function'
        ? options.dependencies()
        : options.dependencies;

    return await Promise.resolve(dependencies);
}

function toBrowserLaunchOptions(effectiveOptions: RallarBrowserRtcProviderOptions): LaunchOptions {
    const browser: RallarBrowserSession.BrowserSettings = effectiveOptions.browser ?? {};

    return {
        headless: browser.headless !== false,
        slowMo: browser.slowMo,
        args: Array.isArray(browser.launchArgs) ? browser.launchArgs : []
    };
}

function toBrowserTimeoutMs(
    args: RallarRtcClientArgs,
    effectiveOptions: RallarBrowserRtcProviderOptions
): number {
    const browser: RallarBrowserSession.BrowserSettings = effectiveOptions.browser ?? {};
    return Number(
        [browser.timeoutMs, args.connectTimeoutMs, args.timeoutMs, 10_000].find((value) => value !== undefined)
    );
}

function toRepoRoot(dependencies: RallarBrowserDependencies): string {
    if (!dependencies.path || !dependencies.fileURLToPath) {
        throw new Error(
            'rallar-browser provider needs node:path and node:url dependencies when harnessUrl is not supplied.'
        );
    }

    const currentFile = dependencies.fileURLToPath(import.meta.url);
    const currentDir = dependencies.path.dirname(currentFile);
    return dependencies.path.resolve(currentDir, '../../../..');
}

async function startBrowserHarness(
    state: RallarBrowserProviderState,
    dependencies: RallarBrowserDependencies,
    effectiveOptions: RallarBrowserRtcProviderOptions
): Promise<string> {
    const explicitHarnessUrl = effectiveOptions.harnessUrl;
    if (explicitHarnessUrl) {
        if (state.harnessUrl && state.harnessUrl !== explicitHarnessUrl) {
            throw new Error(
                'rallar-browser provider cannot mix harness URLs in one scenario. Existing=' +
                    state.harnessUrl + ', requested=' + explicitHarnessUrl
            );
        }

        state.harnessUrl = explicitHarnessUrl;
        return explicitHarnessUrl;
    }

    if (state.harnessUrl) {
        return state.harnessUrl;
    }

    if (!dependencies.createServer || !dependencies.path) {
        throw new Error(
            'rallar-browser provider needs Vite dependencies when harnessUrl is not supplied.'
        );
    }

    const repoRoot = toRepoRoot(dependencies);
    const harness: RallarBrowserSession.HarnessSettings = effectiveOptions.harness ?? {};
    const server = await dependencies.createServer(toBrowserHarnessServerConfig(repoRoot, harness));

    await server.listen();
    state.viteServer = server;
    const baseUrl = server.resolvedUrls?.local[0] ??
        `http://${harness.host || '127.0.0.1'}:${harness.port || 5199}/`;
    state.harnessUrl = new URL(RALLAR_BROWSER_HARNESS_PATH, baseUrl).toString();
    return state.harnessUrl;
}

async function startBrowser(
    state: RallarBrowserProviderState,
    dependencies: RallarBrowserDependencies,
    effectiveOptions: RallarBrowserRtcProviderOptions
): Promise<Browser> {
    if (state.browser) {
        return state.browser;
    }

    const browser: Browser = await dependencies.chromium.launch(toBrowserLaunchOptions(effectiveOptions));
    state.browser = browser;
    return browser;
}

function isRallarRequestUrl(args: RallarRtcClientArgs, url: string | undefined): boolean {
    const apiBaseUrl = toRallarApiBaseUrl(args);
    if (!url || !apiBaseUrl) {
        return false;
    }

    try {
        const requestUrl = new URL(url);
        const apiUrl = new URL(apiBaseUrl);
        const apiPath = apiUrl.pathname === '/' ? '' : apiUrl.pathname.replace(/\/$/, '');

        return requestUrl.origin === apiUrl.origin &&
            requestUrl.pathname.startsWith(apiPath);
    }
    catch (_error) {
        return String(url).startsWith(String(apiBaseUrl));
    }
}

function toRallarApiBaseUrl(args: RallarRtcClientArgs): string | undefined {
    return [args.request?.rallar?.apiBaseUrl, args.request?.apiBaseUrl, args.request?.rallarApiBaseUrl].find((value) =>
        value !== undefined
    );
}

interface ConsoleMessageDiagnostic {
    type: string;
    text: string;
    location: ReturnType<ConsoleMessage['location']>;
}

function toConsoleMessageDiagnostic(message: ConsoleMessage): ConsoleMessageDiagnostic {
    return {
        type: message.type(),
        text: message.text(),
        location: message.location()
    };
}

function toConsoleMessageTopic(type: string | undefined): string {
    if (type === 'error') {
        return 'rallar.browser.console_error';
    }

    if (type === 'warning' || type === 'warn') {
        return 'rallar.browser.console_warning';
    }

    return 'rallar.browser.console';
}

interface RequestFailedDiagnostic {
    url: string;
    method: string;
    failure: ReturnType<Request['failure']>;
}

function toRequestFailedDiagnostic(request: Request): RequestFailedDiagnostic {
    return {
        url: request.url(),
        method: request.method(),
        failure: request.failure()
    };
}

async function closeSharedResourcesIfIdle(
    state: RallarBrowserProviderState,
    options: RallarBrowserCleanupOptions = {}
): Promise<void> {
    if (state.sessions.size > 0) {
        return;
    }

    if (state.browser) {
        const browser = state.browser;
        state.browser = undefined;
        try {
            await browser.close();
            options.diagnostic?.('rallar.browser.provider.browser_closed', {
                reason: options.reason || 'idle'
            });
        }
        catch (error) {
            options.diagnostic?.('rallar.browser.provider.browser_close_failed', {
                reason: options.reason || 'idle',
                error: toBrowserErrorDetails(error)
            });
        }
    }

    if (state.viteServer) {
        const server = state.viteServer;
        state.viteServer = undefined;
        state.harnessUrl = undefined;
        try {
            await server.close();
            options.diagnostic?.('rallar.browser.provider.harness_closed', {
                reason: options.reason || 'idle'
            });
        }
        catch (error) {
            options.diagnostic?.('rallar.browser.provider.harness_close_failed', {
                reason: options.reason || 'idle',
                error: toBrowserErrorDetails(error)
            });
        }
    }
}

function toBrowserHarnessServerConfig(repoRoot: string, harness: RallarBrowserSession.HarnessSettings): InlineConfig {
    return {
        configFile: false,
        root: repoRoot,
        logLevel: 'error',
        resolve: {
            alias: {
                '@shared-test': repoRoot + '/packages/shared-test',
                '@shared-server': repoRoot + '/packages/shared-server',
                '@shared-web': repoRoot + '/packages/shared-web',
                '@shared-graph': repoRoot + '/packages/shared-graph',
                '@shared': repoRoot + '/packages/shared'
            }
        },
        server: {
            host: harness.host || '127.0.0.1',
            port: harness.port || 5199,
            strictPort: harness.strictPort === true,
            fs: {
                allow: [repoRoot]
            }
        }
    };
}

function toBrowserErrorDetails(error: unknown): ReturnType<typeof toBlackBoxRallarSerializedError> {
    return toBlackBoxRallarSerializedError(toBrowserError(error));
}

function toBrowserError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
