// deno-lint-ignore-file no-explicit-any
import type {
    RallarRtcClientArgs,
    RallarRtcClientEventDispatcher,
    RallarRtcRuntimeSession,
} from './rallar-rtc-provider.ts';
import {
    createRallarRtcClientEventDispatcher,
    toRallarRtcClientArgs,
} from './rallar-rtc-provider.ts';
import {
    createRtcProviderFromClientFactory,
    toRtcExpectedConnectionName,
    type RtcClient,
    type RtcProvider,
} from './rtc-provider.ts';

type BlackBoxRallarConnectionConfig = {
    connection: string
    actor?: string
    peerId?: string
    remotePeerId?: string
    roomId?: string
    rallar: any
}

type BlackBoxRallarEvent = {
    kind?: 'diagnostic' | 'message' | 'close'
    topic?: string
    atEpochMs?: number
    connection?: string
    actor?: string
    peerId?: string
    roomId?: string
    [key: string]: any
}

export type RallarBrowserRtcProviderOptions = {
    harnessUrl?: string
    harness?: any
    browser?: any
    dependencies?: RallarBrowserDependencies
        | Promise<RallarBrowserDependencies>
        | (() => RallarBrowserDependencies | Promise<RallarBrowserDependencies>)
}

type RallarBrowserRuntimeSession = {
    connection: string
    context: any
    page: any
    closed: boolean
    connectDiagnostics?: any
}

type RallarBrowserProviderState = {
    dependencies?: Promise<RallarBrowserDependencies>
    viteServer?: any
    harnessUrl?: string
    browser?: any
    sessions: Map<string, RallarBrowserRuntimeSession>
}

type RallarBrowserDiagnosticEmitter = (topic: string, data?: any) => void

type RallarBrowserCleanupOptions = {
    reason?: string
    closeContext?: boolean
    diagnostic?: RallarBrowserDiagnosticEmitter
}

export type RallarBrowserDependencies = {
    chromium: any
    createServer?: any
    path?: any
    fileURLToPath?: (url: string) => string
}

const RALLAR_BROWSER_STATE_KEY = Symbol.for(
    'ar-eye-hunter.black-box-runner.rallar-browser-provider-state',
);

const RALLAR_BROWSER_HARNESS_PATH =
    '/packages/shared-test/black-box-runner/browser/rallar-browser-harness.html';

function isDenoRuntime(): boolean {
    return typeof (globalThis as any).Deno !== 'undefined';
}

async function importRuntimeModule(specifier: string): Promise<any> {
    return await import(specifier);
}

async function loadDependencies(): Promise<RallarBrowserDependencies> {
    try {
        const playwright = await importRuntimeModule(
            isDenoRuntime() ? 'npm:@playwright/test' : '@playwright/test',
        );
        const vite = await importRuntimeModule(isDenoRuntime() ? 'npm:vite' : 'vite');
        const path = await importRuntimeModule('node:path');
        const url = await importRuntimeModule('node:url');

        return {
            chromium: playwright.chromium,
            createServer: vite.createServer,
            path,
            fileURLToPath: url.fileURLToPath,
        };
    } catch (e) {
        throw new Error(
            'The rallar-browser RTC provider requires Playwright and Vite. ' +
            'Run it in the npm workspace, or use a Deno runtime that can resolve npm:@playwright/test and npm:vite. ' +
            'Cause: ' + (e instanceof Error ? e.message : String(e)),
        );
    }
}

async function toDependencies(
    options: RallarBrowserRtcProviderOptions,
): Promise<RallarBrowserDependencies> {
    if (!options.dependencies) {
        return await loadDependencies();
    }

    const dependencies = typeof options.dependencies === 'function'
        ? options.dependencies()
        : options.dependencies;

    return await Promise.resolve(dependencies);
}

function toProviderState(context: any): RallarBrowserProviderState {
    if (!context[RALLAR_BROWSER_STATE_KEY]) {
        context[RALLAR_BROWSER_STATE_KEY] = {
            sessions: new Map<string, RallarBrowserRuntimeSession>(),
        };
    }

    return context[RALLAR_BROWSER_STATE_KEY] as RallarBrowserProviderState;
}

function firstDefined(...values: any[]): any {
    return values.find(value => value !== undefined);
}

function asObject(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}

function toContextProviderOptions(context: any): any {
    return {
        ...asObject(context?.options?.rallarBrowser),
        ...asObject(context?.options?.rtc?.rallarBrowser),
    };
}

function toEffectiveProviderOptions(
    args: RallarRtcClientArgs,
    context: any,
    options: RallarBrowserRtcProviderOptions,
): RallarBrowserRtcProviderOptions {
    const request = args.request || {};
    const contextOptions = toContextProviderOptions(context);

    return {
        ...options,
        ...contextOptions,
        browser: {
            ...asObject(options.browser),
            ...asObject(contextOptions.browser),
            ...asObject(request.browser),
        },
        harness: {
            ...asObject(options.harness),
            ...asObject(contextOptions.harness),
            ...asObject(request.harness),
        },
        harnessUrl: firstDefined(
            request.harnessUrl,
            request.harness?.url,
            contextOptions.harnessUrl,
            contextOptions.harness?.url,
            options.harnessUrl,
            options.harness?.url,
        ),
    };
}

function toBrowserRuntimeConfig(
    args: RallarRtcClientArgs,
): BlackBoxRallarConnectionConfig {
    const request = args.request || {};
    const rallar = asObject(request.rallar);

    return {
        connection: args.connection,
        actor: args.actor,
        peerId: args.peerId,
        remotePeerId: args.remotePeerId,
        roomId: args.roomId,
        rallar: {
            ...rallar,
            apiBaseUrl: firstDefined(
                rallar.apiBaseUrl,
                request.apiBaseUrl,
                request.rallarApiBaseUrl,
            ),
            username: firstDefined(rallar.username, request.username),
            password: firstDefined(rallar.password, request.password),
            displayName: firstDefined(rallar.displayName, request.displayName),
            transport: firstDefined(rallar.transport, request.transport),
            laneId: firstDefined(rallar.laneId, request.laneId),
            typeId: firstDefined(rallar.typeId, request.typeId, request.messageTypeId),
            topicId: firstDefined(rallar.topicId, request.topicId),
            contextId: firstDefined(rallar.contextId, request.contextId),
            resourceId: firstDefined(rallar.resourceId, request.resourceId),
            messageSelector: firstDefined(rallar.messageSelector, request.messageSelector),
            openTimeoutMs: firstDefined(rallar.openTimeoutMs, request.openTimeoutMs),
            timeoutMs: firstDefined(
                rallar.timeoutMs,
                request.timeoutMs,
                request.connectTimeoutMs,
            ),
            peerIds: firstDefined(
                rallar.peerIds,
                request.peerIds,
                request.remotePeerId ? [String(request.remotePeerId)] : undefined,
            ),
            nextHopPeerIds: firstDefined(rallar.nextHopPeerIds, request.nextHopPeerIds),
        },
    };
}

function toBrowserLaunchOptions(effectiveOptions: RallarBrowserRtcProviderOptions): any {
    const browser = asObject(effectiveOptions.browser);

    return {
        headless: browser.headless !== false,
        slowMo: browser.slowMo,
        args: Array.isArray(browser.launchArgs) ? browser.launchArgs : [],
    };
}

function toBrowserTimeoutMs(
    args: RallarRtcClientArgs,
    effectiveOptions: RallarBrowserRtcProviderOptions,
): number {
    const browser = asObject(effectiveOptions.browser);
    return Number(firstDefined(
        browser.timeoutMs,
        args.connectTimeoutMs,
        args.timeoutMs,
        10_000,
    ));
}

function toHarnessServerOptions(effectiveOptions: RallarBrowserRtcProviderOptions): any {
    return asObject(effectiveOptions.harness);
}

function toRepoRoot(dependencies: RallarBrowserDependencies): string {
    if (!dependencies.path || !dependencies.fileURLToPath) {
        throw new Error(
            'rallar-browser provider needs node:path and node:url dependencies when harnessUrl is not supplied.',
        );
    }

    const currentFile = dependencies.fileURLToPath(import.meta.url);
    const currentDir = dependencies.path.dirname(currentFile);
    return dependencies.path.resolve(currentDir, '../../..');
}

async function ensureHarnessUrl(
    state: RallarBrowserProviderState,
    dependencies: RallarBrowserDependencies,
    effectiveOptions: RallarBrowserRtcProviderOptions,
): Promise<string> {
    const explicitHarnessUrl = effectiveOptions.harnessUrl;
    if (explicitHarnessUrl) {
        if (state.harnessUrl && state.harnessUrl !== explicitHarnessUrl) {
            throw new Error(
                'rallar-browser provider cannot mix harness URLs in one scenario. Existing=' +
                state.harnessUrl + ', requested=' + explicitHarnessUrl,
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
            'rallar-browser provider needs Vite dependencies when harnessUrl is not supplied.',
        );
    }

    const repoRoot = toRepoRoot(dependencies);
    const harness = toHarnessServerOptions(effectiveOptions);
    const server = await dependencies.createServer({
        configFile: false,
        root: repoRoot,
        logLevel: 'error',
        resolve: {
            alias: {
                '@shared-test': dependencies.path.resolve(repoRoot, 'packages/shared-test'),
                '@shared-server': dependencies.path.resolve(repoRoot, 'packages/shared-server'),
                '@shared-web': dependencies.path.resolve(repoRoot, 'packages/shared-web'),
                '@shared-graph': dependencies.path.resolve(repoRoot, 'packages/shared-graph'),
                '@shared': dependencies.path.resolve(repoRoot, 'packages/shared'),
                '@relic-hunters': dependencies.path.resolve(repoRoot, 'packages/relic-hunters'),
            },
        },
        server: {
            host: harness.host || '127.0.0.1',
            port: harness.port || 5199,
            strictPort: harness.strictPort === true,
            fs: {
                allow: [repoRoot],
            },
        },
    });

    await server.listen();
    state.viteServer = server;
    const baseUrl = server.resolvedUrls?.local[0] ??
        `http://${harness.host || '127.0.0.1'}:${harness.port || 5199}/`;
    state.harnessUrl = new URL(RALLAR_BROWSER_HARNESS_PATH, baseUrl).toString();
    return state.harnessUrl;
}

async function ensureBrowser(
    state: RallarBrowserProviderState,
    dependencies: RallarBrowserDependencies,
    effectiveOptions: RallarBrowserRtcProviderOptions,
): Promise<any> {
    if (state.browser) {
        return state.browser;
    }

    state.browser = await dependencies.chromium.launch(
        toBrowserLaunchOptions(effectiveOptions),
    );
    return state.browser;
}

function dispatchBrowserEvent(
    event: BlackBoxRallarEvent,
    args: RallarRtcClientArgs,
    dispatcher: RallarRtcClientEventDispatcher,
): void {
    const normalized = {
        ...event,
        connection: event.connection || args.connection,
        actor: event.actor || args.actor,
        provider: args.provider,
        peerId: event.peerId || args.peerId,
        roomId: event.roomId || args.roomId,
        groupId: args.groupId,
        overlayId: args.overlayId,
    };

    if (event.kind === 'close') {
        dispatcher.emitClose(normalized);
        return;
    }

    dispatcher.emitMessage(normalized);
}

function dispatchProviderDiagnostic(
    topic: string,
    args: RallarRtcClientArgs,
    dispatcher: RallarRtcClientEventDispatcher,
    data: any = {},
): void {
    dispatcher.emitMessage({
        kind: 'diagnostic',
        topic,
        atEpochMs: Date.now(),
        connection: args.connection,
        actor: args.actor,
        provider: args.provider,
        peerId: args.peerId,
        remotePeerId: args.remotePeerId,
        roomId: args.roomId,
        groupId: args.groupId,
        overlayId: args.overlayId,
        data,
    });
}

function dispatchProviderClose(
    args: RallarRtcClientArgs,
    dispatcher: RallarRtcClientEventDispatcher,
    data: any = {},
): void {
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
        closedAtEpochMs: Date.now(),
        ...data,
    });
}

function serializeError(error: any): any {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return error;
}

function toRallarApiBaseUrl(args: RallarRtcClientArgs): string | undefined {
    return firstDefined(
        args.request?.rallar?.apiBaseUrl,
        args.request?.apiBaseUrl,
        args.request?.rallarApiBaseUrl,
    );
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
    } catch (_error) {
        return String(url).startsWith(String(apiBaseUrl));
    }
}

function toConsoleMessageDiagnostic(message: any): any {
    return {
        type: typeof message.type === 'function' ? message.type() : undefined,
        text: typeof message.text === 'function' ? message.text() : undefined,
        location: typeof message.location === 'function' ? message.location() : undefined,
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

function toRequestFailedDiagnostic(request: any): any {
    return {
        url: typeof request.url === 'function' ? request.url() : undefined,
        method: typeof request.method === 'function' ? request.method() : undefined,
        failure: typeof request.failure === 'function' ? request.failure() : undefined,
    };
}

function assertBrowserSendSucceeded(response: any): void {
    if (response?.status === 'no-peers') {
        throw new Error('Rallar browser RTC send resolved no target peers.');
    }

    const failed = Array.isArray(response?.results)
        ? response.results.filter((entry: any) => {
            const status = entry?.result?.status;
            return status === 'closed' || status === 'dropped';
        })
        : [];

    if (failed.length > 0) {
        const statuses = [...new Set(failed.map((entry: any) => entry?.result?.status))]
            .filter(Boolean)
            .join(', ');
        throw new Error(
            'Rallar browser RTC send failed for ' + failed.length +
            ' peer(s). status=' + statuses,
        );
    }
}

function isRecord(value: any): boolean {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: any, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function toArgsTransport(args: RallarRtcClientArgs): string {
    return String(firstDefined(
        args.request?.rallar?.transport,
        args.request?.transport,
        'realtime',
    ));
}

function isBrowserRealtimeSendEnvelope(message: any): boolean {
    return isRecord(message) &&
        (
            hasOwn(message, 'data') ||
            hasOwn(message, 'laneId') ||
            hasOwn(message, 'roomId') ||
            hasOwn(message, 'peerIds') ||
            hasOwn(message, 'remotePeerId') ||
            hasOwn(message, 'openTimeoutMs') ||
            hasOwn(message, 'key') ||
            hasOwn(message, 'maxAgeMs')
        );
}

function isBrowserMessagesRtcSendEnvelope(message: any): boolean {
    return isRecord(message) &&
        (
            hasOwn(message, 'payload') ||
            hasOwn(message, 'data') ||
            hasOwn(message, 'typeId') ||
            hasOwn(message, 'topicId') ||
            hasOwn(message, 'contextId') ||
            hasOwn(message, 'resourceId') ||
            hasOwn(message, 'roomId') ||
            hasOwn(message, 'peerIds') ||
            hasOwn(message, 'nextHopPeerIds') ||
            hasOwn(message, 'ttlHops') ||
            hasOwn(message, 'ttlMs') ||
            hasOwn(message, 'reliability') ||
            hasOwn(message, 'ack') ||
            hasOwn(message, 'ownership') ||
            hasOwn(message, 'membershipEpoch') ||
            hasOwn(message, 'seq') ||
            hasOwn(message, 'orderingKey') ||
            hasOwn(message, 'overlayId') ||
            hasOwn(message, 'fanoutLimit')
        );
}

function toBrowserSendInputBase(message: any, args: RallarRtcClientArgs): any {
    if (toArgsTransport(args) === 'messages.rtc') {
        return isBrowserMessagesRtcSendEnvelope(message)
            ? { ...message }
            : { payload: message };
    }

    return isBrowserRealtimeSendEnvelope(message)
        ? { ...message }
        : { data: message };
}

function toStringArray(value: any): string[] {
    if (value === undefined || value === null) {
        return [];
    }

    return (Array.isArray(value) ? value : [value]).map(String);
}

function toExpectedTargetConnectionNames(
    interaction: any,
    args: RallarRtcClientArgs,
): string[] {
    if (!interaction) {
        return [];
    }

    const explicitTargets = [
        ...toStringArray(interaction.request?.deliverTo),
        ...toStringArray(interaction.request?.to),
        ...toStringArray(interaction.request?.toConnection),
        ...toStringArray(interaction.response?.connection),
        ...toStringArray(interaction.response?.onConnection),
        ...toStringArray(interaction.request?.expectConnection),
    ];

    const targets = explicitTargets.length > 0
        ? explicitTargets
        : [toRtcExpectedConnectionName(interaction)];

    return [...new Set(targets)]
        .filter(connectionName => connectionName && connectionName !== args.connection);
}

function toTargetPeerIds(
    state: RallarBrowserProviderState,
    interaction: any,
    args: RallarRtcClientArgs,
): string[] {
    return toExpectedTargetConnectionNames(interaction, args)
        .map(connectionName => state.sessions.get(connectionName)?.connectDiagnostics?.sessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0);
}

function toBrowserTransportSendInput(
    message: any,
    interaction: any,
    args: RallarRtcClientArgs,
    context: any,
): any {
    const input = toBrowserSendInputBase(message, args);
    const state = toProviderState(context);
    const transport = toArgsTransport(args);

    if (transport === 'messages.rtc' && !input.nextHopPeerIds && !input.peerIds) {
        const peerIds = toTargetPeerIds(state, interaction, args);
        if (peerIds.length > 0) {
            input.nextHopPeerIds = peerIds;
        }
    } else if (transport !== 'messages.rtc' && !input.peerIds && !input.remotePeerId) {
        const peerIds = toTargetPeerIds(state, interaction, args);
        if (peerIds.length > 0) {
            input.peerIds = peerIds;
        }
    }

    if (input.roomId === undefined && args.roomId !== undefined) {
        input.roomId = args.roomId;
    }

    return input;
}

async function closeSharedResourcesIfIdle(
    state: RallarBrowserProviderState,
    options: RallarBrowserCleanupOptions = {},
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
                reason: options.reason || 'idle',
            });
        } catch (error) {
            options.diagnostic?.('rallar.browser.provider.browser_close_failed', {
                reason: options.reason || 'idle',
                error: serializeError(error),
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
                reason: options.reason || 'idle',
            });
        } catch (error) {
            options.diagnostic?.('rallar.browser.provider.harness_close_failed', {
                reason: options.reason || 'idle',
                error: serializeError(error),
            });
        }
    }
}

async function closeSession(
    state: RallarBrowserProviderState,
    session: RallarBrowserRuntimeSession,
    options: RallarBrowserCleanupOptions = {},
): Promise<void> {
    if (session.closed && !state.sessions.has(session.connection)) {
        return;
    }

    session.closed = true;
    state.sessions.delete(session.connection);

    if (options.closeContext !== false) {
        try {
            await session.context.close();
            options.diagnostic?.('rallar.browser.provider.context_closed', {
                connection: session.connection,
                reason: options.reason || 'close',
            });
        } catch (error) {
            options.diagnostic?.('rallar.browser.provider.context_close_failed', {
                connection: session.connection,
                reason: options.reason || 'close',
                error: serializeError(error),
            });
        }
    }

    await closeSharedResourcesIfIdle(state, options);
}

async function createBrowserSession(
    args: RallarRtcClientArgs,
    dispatcher: RallarRtcClientEventDispatcher,
    context: any,
    options: RallarBrowserRtcProviderOptions,
): Promise<RallarRtcRuntimeSession> {
    const state = toProviderState(context);
    const existingSession = state.sessions.get(args.connection);
    if (existingSession && !existingSession.closed) {
        throw new Error('rallar-browser connection is already open: ' + args.connection);
    }

    const diagnostic: RallarBrowserDiagnosticEmitter = (topic, data) => {
        dispatchProviderDiagnostic(topic, args, dispatcher, data);
    };

    let setupPhase = 'dependencies';
    let browserContext: any;
    let page: any;
    let session: RallarBrowserRuntimeSession | undefined;
    let harnessUrl = '';

    try {
        state.dependencies = state.dependencies || toDependencies(options);
        const dependencies = await state.dependencies;
        const effectiveOptions = toEffectiveProviderOptions(args, context, options);

        setupPhase = 'harness';
        harnessUrl = await ensureHarnessUrl(state, dependencies, effectiveOptions);

        setupPhase = 'browser';
        const browser = await ensureBrowser(state, dependencies, effectiveOptions);
        const timeoutMs = toBrowserTimeoutMs(args, effectiveOptions);

        setupPhase = 'context';
        browserContext = await browser.newContext();

        setupPhase = 'page';
        page = await browserContext.newPage();
        session = {
            connection: args.connection,
            context: browserContext,
            page,
            closed: false,
        };
        state.sessions.set(args.connection, session);

        setupPhase = 'runtime-bridge';
        await page.exposeFunction('__blackBoxRallarEmit', (event: BlackBoxRallarEvent) => {
            dispatchBrowserEvent(event, args, dispatcher);
        });

        page.on('console', (message: any) => {
            const consoleDiagnostic = toConsoleMessageDiagnostic(message);
            dispatchProviderDiagnostic(
                toConsoleMessageTopic(consoleDiagnostic.type),
                args,
                dispatcher,
                consoleDiagnostic,
            );
        });

        page.on('pageerror', (error: any) => {
            dispatchProviderDiagnostic('rallar.browser.pageerror', args, dispatcher, {
                error: serializeError(error),
            });
        });

        page.on('requestfailed', (request: any) => {
            const requestDiagnostic = toRequestFailedDiagnostic(request);
            dispatchProviderDiagnostic(
                isRallarRequestUrl(args, requestDiagnostic.url)
                    ? 'rallar.browser.rallar_request_failed'
                    : 'rallar.browser.requestfailed',
                args,
                dispatcher,
                requestDiagnostic,
            );
        });

        page.on('close', async () => {
            if (!session || session.closed) {
                return;
            }

            dispatchProviderClose(args, dispatcher, {
                phase: 'page-close',
                reason: 'browser page closed',
            });

            try {
                await closeSession(state, session, {
                    reason: 'page-close',
                    diagnostic,
                });
            } catch (error) {
                diagnostic('rallar.browser.provider.page_close_cleanup_failed', {
                    error: serializeError(error),
                });
            }
        });

        setupPhase = 'page-load';
        await page.goto(harnessUrl, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
        });
        await page.waitForFunction(
            () => Boolean((window as any).__blackBoxRallar),
            undefined,
            { timeout: timeoutMs },
        );

        setupPhase = 'runtime-connect';
        const runtimeConfig = toBrowserRuntimeConfig(args);
        const connectDiagnostics = await page.evaluate(
            async (input: BlackBoxRallarConnectionConfig) => {
                return await (window as any).__blackBoxRallar.connect(input);
            },
            runtimeConfig,
        );
        session.connectDiagnostics = connectDiagnostics;

        dispatchProviderDiagnostic(
            'rallar.browser.provider.connected',
            args,
            dispatcher,
            {
                harnessUrl,
                connectDiagnostics,
            },
        );
    } catch (e) {
        if (setupPhase === 'page-load') {
            diagnostic('rallar.browser.provider.page_load_failed', {
                harnessUrl,
                error: serializeError(e),
            });
        } else if (setupPhase === 'runtime-connect') {
            diagnostic('rallar.browser.provider.runtime_connect_failed', {
                harnessUrl,
                error: serializeError(e),
            });
        }

        diagnostic('rallar.browser.provider.connect_failed', {
            phase: setupPhase,
            error: serializeError(e),
        });

        if (session) {
            await closeSession(state, session, {
                reason: 'connect-failed',
                diagnostic,
            });
        } else {
            if (browserContext) {
                try {
                    await browserContext.close();
                    diagnostic('rallar.browser.provider.context_closed', {
                        connection: args.connection,
                        reason: 'connect-failed',
                    });
                } catch (error) {
                    diagnostic('rallar.browser.provider.context_close_failed', {
                        connection: args.connection,
                        reason: 'connect-failed',
                        error: serializeError(error),
                    });
                }
            }

            await closeSharedResourcesIfIdle(state, {
                reason: 'connect-failed',
                diagnostic,
            });
        }

        throw e;
    }

    if (!session || !page) {
        throw new Error('rallar-browser session was not initialized.');
    }

    return {
        send: async (message: any) => {
            let response: any;

            try {
                response = await page.evaluate(
                    async (input: any) => {
                        return await (window as any).__blackBoxRallar.send(input);
                    },
                    message,
                );
                dispatchProviderDiagnostic(
                    'rallar.browser.provider.send_completed',
                    args,
                    dispatcher,
                    response,
                );
                assertBrowserSendSucceeded(response);
            } catch (error) {
                dispatchProviderDiagnostic(
                    'rallar.browser.provider.send_failed',
                    args,
                    dispatcher,
                    {
                        sent: message,
                        response,
                        error: serializeError(error),
                    },
                );
                throw error;
            }
        },

        close: async () => {
            try {
                if (!session.closed) {
                    await page.evaluate(async () => {
                        return await (window as any).__blackBoxRallar.close();
                    }).catch(() => undefined);
                    dispatchProviderClose(args, dispatcher);
                }
            } finally {
                await closeSession(state, session, {
                    reason: 'close',
                    diagnostic,
                });
            }
        },
    };
}

/**
 * Browser-backed Rallar RTC provider.
 *
 * This is an opt-in provider named `rallar-browser`. It loads a minimal harness
 * page in Playwright and delegates real RTC behavior to the existing browser
 * `rallar` facade instead of reimplementing WebRTC in the runner.
 */
export function createRallarBrowserRtcProvider(
    options: RallarBrowserRtcProviderOptions = {},
): RtcProvider {
    return createRtcProviderFromClientFactory({
        createClient: (request, _config, context) => {
            return createRallarBrowserRtcClient(request, context || {}, options);
        },
    });
}

function createRallarBrowserRtcClient(
    request: any,
    context: any,
    options: RallarBrowserRtcProviderOptions,
): RtcClient {
    const args = toRallarRtcClientArgs(request);
    const dispatcher = createRallarRtcClientEventDispatcher();
    let runtimeSession: RallarRtcRuntimeSession | undefined;

    return {
        connect: async () => {
            runtimeSession = await createBrowserSession(
                args,
                dispatcher,
                context,
                options,
            );
        },

        send: async (message: any, interaction?: any, _config?: any, sendContext?: any) => {
            if (!runtimeSession) {
                throw new Error(
                    'Rallar browser RTC client is not connected for connection: ' +
                    args.connection,
                );
            }

            await runtimeSession.send(toBrowserTransportSendInput(
                message,
                interaction,
                args,
                sendContext || context,
            ));
        },

        close: async () => {
            if (!runtimeSession) {
                return;
            }

            await runtimeSession.close();
            runtimeSession = undefined;
        },

        onMessage(handler: (message: any) => void): void {
            dispatcher.onMessage(handler);
        },

        onClose(handler: (event: any) => void): void {
            dispatcher.onClose(handler);
        },
    };
}
