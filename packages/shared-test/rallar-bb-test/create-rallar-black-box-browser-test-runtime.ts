import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import {
    dispatchAlmBrowserCommand,
    type RallarBlackBoxAlmBrowserPort,
    type RallarBlackBoxAlmCommandWithId
} from './alm/browser-adapter-alm-commands.ts';
import {
    toRtcReadyPeerIds,
    waitForRtcConnectReadiness,
    type RtcConnectReadinessOptions,
    type RtcConnectReadinessResult
} from './browser/rtc-connect-readiness.ts';
import {
    normalizeRallarBlackBoxRuntimeDiagnostic
} from './diagnostics.ts';
import { createRallarBlackBoxTestRuntime } from './create-rallar-black-box-test-runtime.ts';
import type {
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig
} from './rallar-black-box-test-contracts.ts';

import {
    createBrowserCommandAbortScope,
    sleep,
    withBrowserCommandAbort
} from './browser/browser-command-cancellation.ts';
import type {
    RallarBlackBoxBrowserRallarConnectionConfig,
    RtcSendFailure
} from './browser/browser-command-contracts.ts';
import {
    CommandWithId,
    CreateRallarBlackBoxBrowserTestRuntimeOptions,
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser/browser-command-contracts.ts';
import { BrowserCommandEnvironment, requireBrowserCommandRuntime } from './browser/browser-command-environment.ts';
import {
    replaceCommandPlaceholders,
    replaceRtcReadyPeerPlaceholders,
    requiresRtcReadyPeerPlaceholder
} from './browser/browser-command-placeholders.ts';
import {
    toBrowserCommandRecord,
    toPositiveInteger,
    toRtcTransport,
    toStringValue
} from './browser/browser-command-values.ts';
import { BrowserHttpRequests } from './browser/browser-http-requests.ts';
import { toRallarConnectionConfig, toScopedRtcSend } from './browser/browser-rallar-command-input.ts';
import { BrowserRallarFeatureCommands } from './browser/browser-rallar-feature-commands.ts';
import {
    rtcSendFailureFromDiagnostics,
    rtcSendObservation,
    withRtcConnectReadinessValue,
    withSendObservationValue
} from './browser/browser-rtc-send-observation.ts';
import { BrowserRtcStream } from './browser/browser-rtc-stream.ts';
import { toRallarBrowserEventInput } from './browser/to-rallar-browser-event-input.ts';
import { BrowserWebSocketCommands } from './browser/browser-websocket-commands.ts';

export type {
    CreateRallarBlackBoxBrowserTestRuntimeOptions,
    RallarBlackBoxBrowserRallarConnectionConfig,
    RallarBlackBoxBrowserRallarCrdtRuntime,
    RallarBlackBoxBrowserRallarDirectorRuntime,
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserRallarFormationRuntime,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserRallarRuntimeMethod,
    RallarBlackBoxBrowserRallarTransport,
    RallarBlackBoxBrowserRoomRefreshOptions,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser/browser-command-contracts.ts';

const DEFAULT_WS_OPEN_TIMEOUT_MS = 5_000;

const DEFAULT_HTTP_BODY_LIMIT = 64_000;

function commandLocalDelayMs(command: CommandWithId): number {
    const value = command.metadata?.localDelayMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, value);
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

function toAlmConnectionName(
    command: RallarBlackBoxAlmCommandWithId,
    config: RallarBlackBoxTestConfig | undefined
): string {
    const commandConnection = 'connection' in command ? command.connection : undefined;
    return (
        commandConnection ??
            toStringValue(toBrowserCommandRecord(config?.defaults).connection) ??
            config?.actor ??
            'default'
    );
}
namespace BrowserCommandAdapter {
    export interface ReadinessInput {
        readonly command: Extract<CommandWithId, { kind: 'rtc.connect'; }>;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig;
        readonly diagnostics: unknown;
    }
    export interface ConnectedInput {
        readonly command: CommandWithId;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig;
        readonly value: unknown;
    }
    export interface ReadinessDiagnostic {
        readonly context: RallarBlackBoxTestCommandContext;
        readonly command: Extract<CommandWithId, { kind: 'rtc.connect'; }>;
        readonly topic: string;
        readonly severity: 'info' | 'error';
        readonly payload: Readonly<Record<string, unknown>>;
    }
    export interface SendOutcomeInput {
        readonly command: Extract<CommandWithId, { kind: 'rtc.send'; }>;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly diagnostics: unknown;
        readonly sendStartedAtEpochMs: number;
    }
    export interface SendDiagnostic {
        readonly command: Extract<CommandWithId, { kind: 'rtc.send'; }>;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly diagnostics: unknown;
        readonly failure: RtcSendFailure | undefined;
        readonly sendObservation: ReturnType<typeof rtcSendObservation>;
    }
    export interface CloseOptions {
        readonly rallar: boolean;
        readonly tolerant: boolean;
    }
    export interface ReadinessOutcome {
        readiness: RtcConnectReadinessResult | undefined;
        failure: RallarBlackBoxTestCommandOutcome | undefined;
    }
    export interface ClosedResources {
        webSocketCount: number;
        rallar?: unknown;
        errors?: unknown[];
    }
}
class BrowserCommandAdapter {
    private readonly environment: BrowserCommandEnvironment;
    private readonly sockets: BrowserWebSocketCommands;
    private readonly http: BrowserHttpRequests;
    private readonly features: BrowserRallarFeatureCommands;
    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
        this.sockets = new BrowserWebSocketCommands(environment);
        this.http = new BrowserHttpRequests(environment);
        this.features = new BrowserRallarFeatureCommands(environment);
    }
    async dispatch(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const delayMs = commandLocalDelayMs(command);
        if (delayMs > 0) {
            await sleep(delayMs, context.abortSignal?.());
        }

        if (
            command.kind.startsWith('crdt.') || command.kind.startsWith('director.') ||
            command.kind.startsWith('formation.')
        ) {
            return await this.features.dispatch(command, context);
        }
        switch (command.kind) {
            case 'rtc.connect':
                return await this.connectRtc(command, context);
            case 'rtc.send':
                return await this.sendRtc(command, context);
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
                return await dispatchAlmBrowserCommand(
                    this.almBrowserPort(),
                    command,
                    context
                );
            case 'health':
                return await this.health(command, context);
            case 'close':
                return await this.close(command, context);
            case 'reset':
                return await this.reset();
            default:
                return undefined;
        }
    }

    private almBrowserPort(): RallarBlackBoxAlmBrowserPort {
        return {
            requireRuntime: () => requireBrowserCommandRuntime(this.environment),
            commandAbortScope: (command, context) =>
                createBrowserCommandAbortScope(command, context, this.environment.now),
            withAbort: (operation, signal) => withBrowserCommandAbort(operation, signal),
            resolveCommandFields: (command, context) =>
                toBrowserCommandRecord(replaceCommandPlaceholders(command, {
                    config: context.config(),
                    session: this.environment.readSession()
                })),
            resolveConnection: (command, context) => toAlmConnectionName(command, context.config()),
            sleep: (ms) => sleep(ms),
            now: () => this.environment.now()
        };
    }

    private async connectRtc(
        command: Extract<CommandWithId, { kind: 'rtc.connect'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connectionConfig = toRallarConnectionConfig(
            replaceCommandPlaceholders(command, {
                config: context.config(),
                session: this.environment.readSession()
            }),
            context.config()
        );
        let diagnostics: unknown;
        const connectAbort = createBrowserCommandAbortScope(command, context, this.environment.now);
        try {
            diagnostics = await withBrowserCommandAbort(
                requireBrowserCommandRuntime(this.environment).connect(connectionConfig),
                connectAbort.signal
            );
        }
        finally {
            connectAbort.cleanup();
        }
        const { readiness, failure } = await this.waitForRtcReadiness({
            command,
            context,
            connectionConfig,
            diagnostics
        });
        if (failure) {
            return failure;
        }
        const value = readiness
            ? withRtcConnectReadinessValue(diagnostics, readiness)
            : diagnostics;
        this.recordRtcConnected({ command, context, connectionConfig, value });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status === 'idle'
                ? 'configured'
                : context.state().status
        };
    }

    private async sendRtc(
        command: Extract<CommandWithId, { kind: 'rtc.send'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const scopedSend = await this.readRtcSendInput(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        let diagnostics: unknown;
        const sendStartedAtEpochMs = this.environment.now();
        try {
            diagnostics = await withBrowserCommandAbort(
                requireBrowserCommandRuntime(this.environment).send(scopedSend),
                abort.signal
            );
        }
        finally {
            abort.cleanup();
        }

        return this.recordRtcSendOutcome({ command, context, diagnostics, sendStartedAtEpochMs });
    }

    private rtcConnectReadinessOptions(
        command: Extract<CommandWithId, { kind: 'rtc.connect'; }>
    ): RtcConnectReadinessOptions | undefined {
        if (!command.readiness) {
            return undefined;
        }

        return {
            minReadyPeers: toPositiveInteger(command.readiness.minReadyPeers, 1),
            timeoutMs: toPositiveInteger(command.readiness.timeoutMs, 5_000),
            intervalMs: toPositiveInteger(command.readiness.intervalMs, 100)
        };
    }

    private recordRtcReadinessDiagnostic(
        input: BrowserCommandAdapter.ReadinessDiagnostic
    ): void {
        const { context, command, topic, severity, payload } = input;
        context.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity,
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity,
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: payload,
                payload,
                message: typeof payload.message === 'string' ? payload.message : undefined,
                source: 'browser-adapter'
            })
        });
    }

    private async health(
        command: Extract<CommandWithId, { kind: 'health'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const rallar = this.environment.rallarRuntime
            ? await this.environment.rallarRuntime.health({
                includeRtcDiagnostics: command.includeRtcDiagnostics === true
            })
            : undefined;
        return {
            status: 'ok',
            value: {
                rallar,
                stats: context.updateStats(command.commandId),
                webSockets: this.sockets.connectionNames()
            },
            nextStatus: context.state().status
        };
    }

    private async close(
        command: Extract<CommandWithId, { kind: 'close'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const resources = await this.closeOwnedResources({
            rallar: true,
            tolerant: false
        });
        const value = {
            closed: true,
            rallar: resources.rallar,
            webSocketCount: resources.webSocketCount
        };
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.closed',
            commandId: command.commandId,
            severity: 'info',
            payload: value
        });
        return {
            status: 'ok',
            value,
            nextStatus: 'idle'
        };
    }

    private async reset(): Promise<RallarBlackBoxTestCommandOutcome> {
        const value = await this.closeOwnedResources({
            rallar: true,
            tolerant: false
        });
        return {
            status: 'ok',
            value: {
                reset: true,
                rallar: value.rallar,
                webSocketCount: value.webSocketCount
            },
            nextStatus: 'idle'
        };
    }

    async cleanupOwnedResources(
        input: RallarBlackBoxTestCleanupInput,
        context: RallarBlackBoxTestCommandContext
    ): Promise<void> {
        const value = await this.closeOwnedResources({
            rallar: true,
            tolerant: true
        });
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.cleanup.resources_closed',
            commandId: input.commandId,
            severity: 'info',
            payload: {
                ...input,
                ...value
            }
        });
    }

    private async closeOwnedResources(
        options: BrowserCommandAdapter.CloseOptions
    ): Promise<BrowserCommandAdapter.ClosedResources> {
        const { webSocketCount, errors } = this.sockets.closeAll();
        let rallar: unknown;
        if (options.rallar && this.environment.rallarRuntime) {
            try {
                rallar = await this.environment.rallarRuntime.close();
            }
            catch (error) {
                errors.push({
                    connection: 'rallar',
                    error
                });
            }
        }

        if (errors.length > 0 && !options.tolerant) {
            throw new Error('Failed to close one or more browser adapter resources.');
        }

        return {
            webSocketCount,
            rallar,
            ...(errors.length > 0 ? { errors } : {})
        };
    }

    private async waitForRtcReadiness(
        input: BrowserCommandAdapter.ReadinessInput
    ): Promise<BrowserCommandAdapter.ReadinessOutcome> {
        const { command, context, connectionConfig, diagnostics } = input;
        let readiness: RtcConnectReadinessResult | undefined;
        const readinessOptions = this.rtcConnectReadinessOptions(command);
        if (readinessOptions) {
            const transport = toRtcTransport(connectionConfig.rallar.transport);
            const readinessTimeoutMessage = transport === 'messages.rtc'
                ? 'RTC connect timed out waiting for room transport readiness.'
                : 'RTC connect timed out waiting for ready peers.';
            this.recordRtcReadinessDiagnostic({
                context: context,
                command: command,
                topic: 'rallar.bb.rtc.readiness_wait_started',
                severity: 'info',
                payload: {
                    minReadyPeers: readinessOptions.minReadyPeers,
                    timeoutMs: readinessOptions.timeoutMs,
                    intervalMs: readinessOptions.intervalMs
                }
            });
            readiness = await waitForRtcConnectReadiness({
                runtime: requireBrowserCommandRuntime(this.environment),
                transport,
                options: readinessOptions,
                parentSignal: context.abortSignal?.()
            });
            this.recordRtcReadinessDiagnostic({
                context: context,
                command: command,
                topic: readiness.ready
                    ? 'rallar.bb.rtc.readiness_ready'
                    : 'rallar.bb.rtc.readiness_timeout',
                severity: readiness.ready ? 'info' : 'error',
                payload: {
                    ...readiness,
                    ...(!readiness.ready ? { message: readinessTimeoutMessage } : {})
                }
            });
            if (!readiness.ready) {
                return {
                    readiness,
                    failure: this.toRtcReadinessFailure(readiness, diagnostics, readinessTimeoutMessage)
                };
            }
        }

        return { readiness, failure: undefined };
    }

    private recordRtcConnected(
        input: BrowserCommandAdapter.ConnectedInput
    ): void {
        const { command, context, connectionConfig, value } = input;
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.connected',
            commandId: command.commandId,
            connection: connectionConfig.connection,
            actor: connectionConfig.actor,
            transport: toRtcTransport(connectionConfig.rallar.transport),
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.bb.rtc.connected',
                severity: 'info',
                commandId: command.commandId,
                connection: connectionConfig.connection,
                actor: connectionConfig.actor,
                transport: toRtcTransport(connectionConfig.rallar.transport),
                roomId: connectionConfig.roomId,
                data: value,
                payload: value,
                source: 'browser-adapter'
            })
        });
    }

    private async readRtcSendInput(
        command: Extract<CommandWithId, { kind: 'rtc.send'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<unknown> {
        const resolvedSend = replaceCommandPlaceholders(command.send ?? {}, {
            config: context.config(),
            session: this.environment.readSession()
        });
        let scopedSend = toScopedRtcSend(command, resolvedSend);
        if (requiresRtcReadyPeerPlaceholder(scopedSend)) {
            const health = await requireBrowserCommandRuntime(this.environment).health();
            scopedSend = replaceRtcReadyPeerPlaceholders(
                scopedSend,
                toRtcReadyPeerIds(health)
            );
        }

        return scopedSend;
    }

    private recordRtcSendOutcome(
        input: BrowserCommandAdapter.SendOutcomeInput
    ): RallarBlackBoxTestCommandOutcome {
        const { command, context, diagnostics, sendStartedAtEpochMs } = input;
        const failure = rtcSendFailureFromDiagnostics(diagnostics);
        const sendObservation = rtcSendObservation({
            command,
            diagnostics: toBrowserCommandRecord(diagnostics),
            durationMs: Math.max(0, this.environment.now() - sendStartedAtEpochMs),
            ok: failure === undefined,
            errorCode: failure?.code
        });
        this.recordRtcSendDiagnostic({ command, context, diagnostics, failure, sendObservation });

        if (failure) {
            return {
                status: 'failed',
                value: withSendObservationValue(diagnostics, sendObservation),
                error: {
                    code: failure.code,
                    message: failure.message,
                    details: failure.details
                },
                nextStatus: 'failed'
            };
        }

        return {
            status: 'ok',
            value: withSendObservationValue(diagnostics, sendObservation),
            nextStatus: context.state().status
        };
    }

    private recordRtcSendDiagnostic(
        input: BrowserCommandAdapter.SendDiagnostic
    ): void {
        const { command, context, diagnostics, failure, sendObservation } = input;
        context.recordEvent({
            kind: 'diagnostic',
            topic: failure
                ? 'rallar.bb.rtc.send_failed'
                : 'rallar.bb.rtc.send_completed',
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: failure ? 'error' : 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: failure
                    ? 'rallar.bb.rtc.send_failed'
                    : 'rallar.bb.rtc.send_completed',
                severity: failure ? 'error' : 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: diagnostics,
                payload: failure
                    ? {
                        diagnostics,
                        failure,
                        sendObservation
                    }
                    : withSendObservationValue(diagnostics, sendObservation),
                message: failure?.message,
                error: failure,
                source: 'browser-adapter'
            })
        });
    }

    private toRtcReadinessFailure(
        readiness: RtcConnectReadinessResult,
        diagnostics: unknown,
        readinessTimeoutMessage: string
    ): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value: withRtcConnectReadinessValue(diagnostics, readiness),
            error: {
                code: 'RALLAR_BB_RTC_READY_TIMEOUT',
                message: readinessTimeoutMessage,
                details: readiness
            },
            nextStatus: 'failed'
        };
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
function createDefaultBrowserWebSocketFactory(): RallarBlackBoxBrowserWebSocketFactory | undefined {
    const WebSocketConstructor = globalThis.WebSocket;
    if (!WebSocketConstructor) {
        return undefined;
    }

    return (url, protocols) =>
        new WebSocketConstructor(
            url,
            protocols as string | string[] | undefined
        ) as RallarBlackBoxBrowserWebSocket;
}
