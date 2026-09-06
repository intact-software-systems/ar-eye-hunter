import {
    isLocalOnlyCrdtOpen,
    toBrowserTransportSendInput,
    toExpectedTargetConnectionNames
} from './browser/browser-rtc-requests.ts';
import { toBlackBoxRallarSerializedError } from './browser/rallar-browser-runtime/black-box-rallar-serialized-error.ts';
import {
    initRallarBrowserProviderState,
    RallarBrowserSession,
    type RallarBrowserProviderState
} from './browser/rallar-browser-session.ts';
import type { RallarRtcClientArgs, RallarRtcClientEventDispatcher } from './rallar-rtc-provider.ts';
import { createRallarRtcClientEventDispatcher, toRallarRtcClientArgs } from './rallar-rtc-provider.ts';
import { toRallarScopeDiagnostics } from './recipes/recipe-rallar-scope.ts';
import { createRtcProviderFromClientFactory, type RtcClient, type RtcProvider } from './rtc-provider.ts';
import { toRtcConnectionName } from './rtc/rtc-wait-expectations.ts';

export interface RallarBrowserRtcProviderOptions {
    harnessUrl?: string;
    harness?: any;
    browser?: any;
    dependencies?:
        | RallarBrowserDependencies
        | Promise<RallarBrowserDependencies>
        | (() => RallarBrowserDependencies | Promise<RallarBrowserDependencies>);
}

export interface RallarBrowserDependencies {
    chromium: any;
    createServer?: any;
    path?: any;
    fileURLToPath?: (url: string) => string;
}

interface BrowserCrdtCommandInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly options: RallarBrowserRtcProviderOptions;
}

interface BrowserCrdtFailureInput {
    readonly config: any;
    readonly interaction: any;
    readonly result: string;
    readonly details: any;
}

export function createRallarBrowserRtcProvider(options: RallarBrowserRtcProviderOptions = {}): RtcProvider {
    const provider = createRtcProviderFromClientFactory({
        createClient: (request, _config, context) => new RallarBrowserRtcClient(request, context || {}, options)
    });
    return {
        ...provider,
        command: (interaction, config, context) => writeBrowserCrdtCommand({ interaction, config, context, options })
    };
}

class RallarBrowserRtcClient implements RtcClient {
    private readonly args: RallarRtcClientArgs;
    private readonly dispatcher: RallarRtcClientEventDispatcher;
    private readonly state: RallarBrowserProviderState;
    private readonly options: RallarBrowserRtcProviderOptions;
    private runtimeSession: RallarBrowserSession | undefined;
    private connectDiagnostics: any;
    private lastSendDiagnostics: any;
    private lastCrdtCommandDiagnostics: any;

    constructor(request: any, context: any, options: RallarBrowserRtcProviderOptions) {
        this.args = toRallarRtcClientArgs(request);
        this.dispatcher = createRallarRtcClientEventDispatcher();
        this.state = initRallarBrowserProviderState(context);
        this.options = {
            ...toEffectiveProviderOptions(this.args, context, options),
            dependencies: options.dependencies
        };
    }

    async connect(): Promise<void> {
        const session = new RallarBrowserSession({
            args: this.args,
            dispatcher: this.dispatcher,
            state: this.state,
            options: this.options
        });
        await session.start(true);
        this.runtimeSession = session;
        this.connectDiagnostics = session.connectDiagnostics;
    }

    async send(message: any, interaction?: any): Promise<any> {
        if (!this.runtimeSession) {
            throw new Error('Rallar browser RTC client is not connected for connection: ' + this.args.connection);
        }
        const targetPeerIds = toExpectedTargetConnectionNames(interaction, this.args)
            .map((name) => this.state.sessions.get(name)?.connectDiagnostics?.sessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0);
        const send = toBrowserTransportSendInput({ message, interaction, args: this.args, targetPeerIds });
        this.lastSendDiagnostics = await this.runtimeSession.send(send);
        return this.lastSendDiagnostics;
    }

    async command(action: string, request: any): Promise<any> {
        if (!this.runtimeSession && isLocalOnlyCrdtOpen(action, request)) {
            const session = new RallarBrowserSession({
                args: this.args,
                dispatcher: this.dispatcher,
                state: this.state,
                options: this.options
            });
            await session.start(false);
            this.runtimeSession = session;
            this.connectDiagnostics = session.connectDiagnostics;
        }
        if (!this.runtimeSession) {
            throw new Error('Rallar browser RTC client is not connected for CRDT command: ' + this.args.connection);
        }
        const command = {
            ...request,
            connection: request.connection ?? this.args.connection,
            actor: request.actor ?? this.args.request.actor,
            roomId: request.roomId ?? this.args.roomId,
            roomRef: request.roomRef ?? this.args.request.roomRef,
            rallar: { ...(this.args.request.rallar || {}), ...(request.rallar || {}) }
        };
        this.lastCrdtCommandDiagnostics = await this.runtimeSession.command(action, command);
        return this.lastCrdtCommandDiagnostics;
    }

    async close(): Promise<void> {
        if (this.runtimeSession) {
            await this.runtimeSession.close();
            this.runtimeSession = undefined;
        }
    }

    onMessage(handler: (message: any) => void): void {
        this.dispatcher.onMessage(handler);
    }

    onClose(handler: (event: any) => void): void {
        this.dispatcher.onClose(handler);
    }

    diagnostics(): any {
        return {
            ...toRallarScopeDiagnostics(this.args.request, this.args.roomId),
            connect: this.connectDiagnostics,
            lastSend: this.lastSendDiagnostics,
            lastCrdtCommand: this.lastCrdtCommandDiagnostics
        };
    }
}

async function writeBrowserCrdtCommand(input: BrowserCrdtCommandInput): Promise<any> {
    const { interaction, config, context } = input;
    const connectionName = toRtcConnectionName(interaction.request);
    const action = String(interaction.request.action || 'open');
    context.rtcConnections = context.rtcConnections || {};
    let connection = context.rtcConnections[connectionName];
    if (!connection?.client?.command && isLocalOnlyCrdtOpen(action, interaction.request)) {
        connection = initBrowserCrdtConnection(input, connectionName, Date.now());
    }
    const client: RtcClient | undefined = connection?.client;
    if (!client?.command) {
        return toCrdtProviderFailureStatus({
            config,
            interaction,
            result: 'CRDT connection is not open',
            details: { connection: connectionName, action }
        });
    }
    try {
        const startedAtEpochMs = Date.now();
        const result = await client.command(action, interaction.request);
        const endedAtEpochMs = Date.now();
        connection.lastCrdtCommandResult = result;
        connection.lastCrdtCommandAction = action;
        connection.lastCrdtCommandLatencyMs = endedAtEpochMs - startedAtEpochMs;
        return toCrdtProviderSuccessStatus(config, interaction, {
            connection: connectionName,
            action,
            result,
            startedAtEpochMs,
            endedAtEpochMs,
            latencyMs: endedAtEpochMs - startedAtEpochMs
        });
    }
    catch (error) {
        return toCrdtProviderFailureStatus({
            config,
            interaction,
            result: 'CRDT browser command failed',
            details: {
                connection: connectionName,
                action,
                error: toBlackBoxRallarSerializedError(error instanceof Error ? error : new Error(String(error)))
            }
        });
    }
}

function initBrowserCrdtConnection(input: BrowserCrdtCommandInput, connectionName: string, atEpochMs: number): any {
    const { interaction, context, options } = input;
    const client = new RallarBrowserRtcClient(
        {
            ...interaction.request,
            connection: connectionName,
            provider: interaction.request.provider || 'rallar-browser'
        },
        context,
        options
    );
    const connection = {
        client,
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
        request: interaction.request,
        connectStartedAtEpochMs: atEpochMs,
        connectedAtEpochMs: atEpochMs,
        connectLatencyMs: 0,
        diagnostics: { localOnlyCrdt: true }
    };
    context.rtcConnections[connectionName] = connection;
    return connection;
}

function toEffectiveProviderOptions(
    args: RallarRtcClientArgs,
    context: any,
    options: RallarBrowserRtcProviderOptions
): RallarBrowserRtcProviderOptions {
    const request = args.request || {};
    const contextOptions = toContextProviderOptions(context);

    return {
        ...options,
        ...contextOptions,
        browser: {
            ...asObject(options.browser),
            ...asObject(contextOptions.browser),
            ...asObject(request.browser)
        },
        harness: {
            ...asObject(options.harness),
            ...asObject(contextOptions.harness),
            ...asObject(request.harness)
        },
        harnessUrl: [
            request.harnessUrl,
            request.harness?.url,
            contextOptions.harnessUrl,
            contextOptions.harness?.url,
            options.harnessUrl,
            options.harness?.url
        ].find((value) => value !== undefined)
    };
}

function toContextProviderOptions(context: any): any {
    return {
        ...asObject(context?.options?.rallarBrowser),
        ...asObject(context?.options?.rtc?.rallarBrowser)
    };
}

function asObject(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}

function toCrdtProviderReportFields(interaction: any): any {
    return {
        provider: interaction.request.provider,
        action: interaction.request.action,
        connection: interaction.request.connection,
        handle: interaction.request.handle,
        documentName: interaction.request.name,
        applicationId: interaction.request.applicationId,
        workspaceId: interaction.request.workspaceId,
        documentId: interaction.request.documentId,
        documentType: interaction.request.documentType,
        scope: interaction.request.scope,
        roomRef: interaction.request.roomRef,
        transportStrategy: interaction.request.transport,
        durableCatchUp: interaction.request.durableCatchUp
    };
}

function toCrdtProviderSuccessStatus(config: any, interaction: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: 'SUCCESS',
        transport: 'CRDT',
        ...toCrdtProviderReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtProviderReportFields(interaction),
            ...details
        },
        ...config
    };
}

function toCrdtProviderFailureStatus(input: BrowserCrdtFailureInput): any {
    const { config, interaction, result, details } = input;
    return {
        name: config.interactionName,
        status: 'FAILURE',
        result,
        transport: 'CRDT',
        ...toCrdtProviderReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtProviderReportFields(interaction),
            ...details
        },
        ...config
    };
}
