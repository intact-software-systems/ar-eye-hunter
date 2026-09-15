import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    dispatchAlmBrowserCommand,
    type RallarBlackBoxAlmBrowserPort,
    type RallarBlackBoxAlmCommandWithId
} from './alm/browser-adapter-alm-commands.ts';
import {
    createBrowserCommandAbortScope,
    sleep,
    withBrowserCommandAbort
} from './browser/browser-command-cancellation.ts';
import type {
    CommandWithId,
    CreateRallarBlackBoxBrowserTestRuntimeOptions,
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserRallarRuntimeResult,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser/browser-command-contracts.ts';
import { requireBrowserCommandRuntime, type BrowserCommandEnvironment } from './browser/browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser/browser-command-placeholders.ts';
import { decodeBrowserCommandString } from './browser/browser-command-values.ts';
import { BrowserHttpRequests } from './browser/browser-http-requests.ts';
import { BrowserRallarFeatureCommands } from './browser/browser-rallar-feature-commands.ts';
import { BrowserRtcCommands } from './browser/browser-rtc-commands.ts';
import { BrowserRtcStream } from './browser/browser-rtc-stream.ts';
import { BrowserWebSocketCommands } from './browser/browser-web-socket-commands.ts';
import { toRallarBrowserEventInput } from './browser/to-rallar-browser-event-input.ts';
import type {
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig
} from './rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from './runtime/create-rallar-black-box-test-runtime.ts';

const DEFAULT_WS_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_HTTP_BODY_LIMIT = 64_000;

const FEATURE_COMMAND_PREFIXES: readonly string[] = ['crdt.', 'director.', 'formation.'];

namespace BrowserCommandAdapter {
    export interface ClosedResources {
        readonly webSocketCount: number;
        readonly rallar: RallarBlackBoxBrowserRallarRuntimeResult;
        readonly errors: readonly BrowserWebSocketCommands.CloseError[];
    }
}

class BrowserCommandAdapter {
    private readonly environment: BrowserCommandEnvironment;
    private readonly sockets: BrowserWebSocketCommands;
    private readonly http: BrowserHttpRequests;
    private readonly rtc: BrowserRtcCommands;
    private readonly features: BrowserRallarFeatureCommands;

    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
        this.sockets = new BrowserWebSocketCommands(environment);
        this.http = new BrowserHttpRequests(environment);
        this.rtc = new BrowserRtcCommands(environment);
        this.features = new BrowserRallarFeatureCommands(environment);
    }

    async dispatch(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const delayMs = toCommandLocalDelayMs(command);
        if (delayMs > 0) {
            await sleep(delayMs, context.abortSignal?.());
        }
        if (FEATURE_COMMAND_PREFIXES.some((prefix) => command.kind.startsWith(prefix))) {
            return await this.features.dispatch(command, context);
        }
        switch (command.kind) {
            case 'rtc.connect':
                return await this.rtc.connectRtc(command, context);
            case 'rtc.send':
                return await this.rtc.sendRtc(command, context);
            case 'rtc.stream':
                return await new BrowserRtcStream({ environment: this.environment, command, context }).start();
            case 'ws.open':
                return await this.sockets.openWebSocket(command, context);
            case 'ws.send':
                return await this.sockets.sendWebSocket(command, context);
            case 'ws.close':
                return this.sockets.closeWebSocket(command);
            case 'http.request':
                return await this.http.httpRequest(command, context);
            case 'messages.send':
            case 'messages.observe':
            case 'messages.cancel':
            case 'messages.received':
            case 'messages.receipts':
            case 'fault.inject':
            case 'storage.counters':
            case 'agent.reload':
                return await dispatchAlmBrowserCommand(this.createAlmBrowserPort(), command, context);
            default:
                return await this.dispatchLifecycleCommand(command, context);
        }
    }

    async cleanupOwnedResources(
        input: RallarBlackBoxTestCleanupInput,
        context: RallarBlackBoxTestCommandContext
    ): Promise<void> {
        const resources = await this.closeOwnedResources(true);
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.cleanup.resources_closed',
            commandId: input.commandId,
            severity: 'info',
            payload: {
                ...input,
                webSocketCount: resources.webSocketCount,
                rallar: resources.rallar,
                ...(resources.errors.length > 0 ? { errors: resources.errors } : {})
            }
        });
    }

    private async dispatchLifecycleCommand(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        switch (command.kind) {
            case 'health':
                return {
                    status: 'ok',
                    value: {
                        rallar: await this.environment.rallarRuntime?.health({
                            includeRtcDiagnostics: command.includeRtcDiagnostics === true
                        }),
                        stats: context.updateStats(command.commandId),
                        webSockets: this.sockets.connectionNames()
                    },
                    nextStatus: context.state().status
                };
            case 'close':
                return await this.close(command, context);
            case 'reset': {
                const resources = await this.closeOwnedResources(false);
                return {
                    status: 'ok',
                    value: { reset: true, rallar: resources.rallar, webSocketCount: resources.webSocketCount },
                    nextStatus: 'idle'
                };
            }
            default:
                return undefined;
        }
    }

    private createAlmBrowserPort(): RallarBlackBoxAlmBrowserPort {
        return {
            requireRuntime: () => requireBrowserCommandRuntime(this.environment),
            commandAbortScope: (command, context) =>
                createBrowserCommandAbortScope(command, context, this.environment.now),
            withAbort: (operation, signal) => withBrowserCommandAbort(operation, signal),
            resolveCommandFields: (command, context) =>
                replaceCommandPlaceholders(command, {
                    config: context.config(),
                    session: this.environment.readSession(),
                    wsTicket: undefined
                }),
            resolveConnection: (command, context) => resolveAlmConnectionName(command, context.config()),
            sleep: (ms) => sleep(ms),
            now: () => this.environment.now()
        };
    }

    private async close(
        command: Extract<CommandWithId, { kind: 'close'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const resources = await this.closeOwnedResources(false);
        const value = { closed: true, rallar: resources.rallar, webSocketCount: resources.webSocketCount };
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.closed',
            commandId: command.commandId,
            severity: 'info',
            payload: value
        });
        return { status: 'ok', value, nextStatus: 'idle' };
    }

    private async closeOwnedResources(tolerant: boolean): Promise<BrowserCommandAdapter.ClosedResources> {
        const { webSocketCount, errors } = this.sockets.closeAll();
        const closeErrors = [...errors];
        let rallar: RallarBlackBoxBrowserRallarRuntimeResult;
        try {
            rallar = await this.environment.rallarRuntime?.close();
        }
        catch (caught) {
            closeErrors.push({ connection: 'rallar', error: toError(caught) });
        }
        if (closeErrors.length > 0 && !tolerant) {
            throw new Error('Failed to close one or more browser adapter resources.');
        }
        return { webSocketCount, rallar, errors: closeErrors };
    }
}

export function createRallarBlackBoxBrowserTestRuntime(
    options: CreateRallarBlackBoxBrowserTestRuntimeOptions = {}
): RallarBlackBoxBrowserTestRuntime {
    const adapter = new BrowserCommandAdapter({
        rallarRuntime: options.rallarRuntime,
        fetch: options.fetch ?? globalThis.fetch?.bind(globalThis),
        webSocketFactory: options.webSocketFactory ?? createDefaultBrowserWebSocketFactory(),
        defaultWsOpenTimeoutMs: options.defaultWsOpenTimeoutMs ?? DEFAULT_WS_OPEN_TIMEOUT_MS,
        defaultHttpBodyLimit: options.defaultHttpBodyLimit ?? DEFAULT_HTTP_BODY_LIMIT,
        now: options.now ?? Date.now,
        readSession: readOptionalBrowserSession,
        requestId: () => crypto.randomUUID()
    });
    const runtime = createRallarBlackBoxTestRuntime({
        now: options.now,
        sleep: options.sleep,
        idFactory: options.idFactory,
        commandExecutor: (command, context) => adapter.dispatch(command, context),
        cleanup: (input, context) => adapter.cleanupOwnedResources(input, context)
    });

    return Object.assign(runtime, {
        receiveRallarBrowserEvent(event: RallarBlackBoxBrowserRallarEvent): void {
            runtime.recordEvent(toRallarBrowserEventInput(event));
        }
    });
}

function toCommandLocalDelayMs(command: CommandWithId): number {
    const value = command.metadata?.localDelayMs;
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readOptionalBrowserSession(): AuthSession | undefined {
    if (typeof localStorage === 'undefined') {
        return undefined;
    }
    try {
        return readSession();
    }
    catch {
        return undefined;
    }
}

function resolveAlmConnectionName(
    command: RallarBlackBoxAlmCommandWithId,
    config: RallarBlackBoxTestConfig | undefined
): string {
    const commandConnection = 'connection' in command ? command.connection : undefined;
    return commandConnection ?? decodeBrowserCommandString(config?.defaults?.connection) ?? config?.actor ?? 'default';
}

function createDefaultBrowserWebSocketFactory(): RallarBlackBoxBrowserWebSocketFactory | undefined {
    const WebSocketConstructor = globalThis.WebSocket;
    if (!WebSocketConstructor) {
        return undefined;
    }
    return (url, protocols) =>
        new WebSocketConstructor(
            url,
            typeof protocols === 'string' || protocols === undefined ? protocols : [...protocols]
        ) as RallarBlackBoxBrowserWebSocket;
}
