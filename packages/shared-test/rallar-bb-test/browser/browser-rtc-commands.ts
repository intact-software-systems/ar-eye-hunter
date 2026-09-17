import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import type { CommandWithId, RallarBlackBoxBrowserRallarConnectionConfig } from './browser-command-contracts.ts';
import { requireBrowserCommandRuntime, type BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { decodeBrowserCommandRecord, decodeRtcTransport, toPositiveInteger } from './browser-command-values.ts';
import { toRallarConnectionConfig } from './browser-rallar-command-input.ts';
import {
    decodeRtcSendResult,
    toRtcSendFailure,
    toRtcSendObservation,
    type RtcSendResult
} from './browser-rtc-send-observation.ts';
import {
    decodeRtcReadyPeerIds,
    waitForRtcConnectReadiness,
    type RtcConnectReadinessOptions,
    type RtcConnectReadinessResult
} from './rtc-connect-readiness.ts';
import { replaceRtcReadyPeerPlaceholders, requiresRtcReadyPeerPlaceholder } from './rtc-ready-peer-placeholders.ts';
import { decodeRtcSendPayload, toScopedRtcSend } from './to-scoped-rtc-send.ts';

type RtcConnectCommand = Extract<CommandWithId, { kind: 'rtc.connect'; }>;
type RtcSendCommand = Extract<CommandWithId, { kind: 'rtc.send'; }>;

export namespace BrowserRtcCommands {
    export interface ConnectedRtc {
        readonly command: RtcConnectCommand;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig;
        /** Absent when the page runtime answered the connect with no result record. */
        readonly diagnostics: RallarBlackBoxTestRecord | undefined;
    }

    export interface SentRtc {
        readonly command: RtcSendCommand;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly result: Either<RallarBlackBoxTestError, RtcSendResult>;
        readonly sendStartedAtEpochMs: number;
    }

    export interface ReadinessDiagnostic {
        readonly topic: string;
        readonly severity: 'info' | 'error';
        readonly payload: RallarBlackBoxTestRecord;
    }
}

interface RtcSendDiagnostic {
    readonly command: RtcSendCommand;
    readonly context: RallarBlackBoxTestCommandContext;
    /** Absent when the page runtime returned no rtc.send result record. */
    readonly diagnostics: RallarBlackBoxTestRecord | undefined;
    readonly failure: RallarBlackBoxTestError | undefined;
    readonly sendObservation: RallarBlackBoxTestSendObservation;
}

const DEFAULT_READINESS_OPTIONS: RtcConnectReadinessOptions = { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 100 };

export class BrowserRtcCommands {
    private readonly environment: BrowserCommandEnvironment;

    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }

    async connectRtc(
        command: RtcConnectCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connectionConfig = toRallarConnectionConfig(
            replaceCommandPlaceholders(command, {
                config: context.config(),
                session: this.environment.readSession(),
                wsTicket: undefined
            }),
            context.config()
        );
        const diagnostics = await this.connectRuntime(command, context, connectionConfig);
        const connected = { command, context, connectionConfig, diagnostics };
        const readiness = command.readiness ? await this.waitForRtcReadiness(connected) : undefined;
        if (readiness && !readiness.ready) {
            return toRtcReadinessFailure(connected, readiness);
        }
        const value = readiness ? { ...diagnostics, readiness } : diagnostics;
        recordRtcConnected(connected, value);
        return {
            status: 'ok',
            value,
            nextStatus: context.state().status === 'idle' ? 'configured' : context.state().status
        };
    }

    async sendRtc(
        command: RtcSendCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        return await decodeRtcSendPayload(command.send).fold<Promise<RallarBlackBoxTestCommandOutcome>>(
            async (error) => ({ status: 'failed', error, nextStatus: 'failed' }),
            async (payload) => await this.sendRtcPayload(command, context, payload)
        );
    }

    private async connectRuntime(
        command: RtcConnectCommand,
        context: RallarBlackBoxTestCommandContext,
        connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig
    ): Promise<RallarBlackBoxTestRecord | undefined> {
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        try {
            const runtime = requireBrowserCommandRuntime(this.environment);
            return decodeBrowserCommandRecord(
                await withBrowserCommandAbort(runtime.connect(connectionConfig), abort.signal)
            );
        }
        finally {
            abort.cleanup();
        }
    }

    private async sendRtcPayload(
        command: RtcSendCommand,
        context: RallarBlackBoxTestCommandContext,
        payload: RallarMessagePayload
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const send = await this.readRtcSendInput(command, context, payload);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        const sendStartedAtEpochMs = this.environment.now();
        try {
            const result = decodeRtcSendResult(
                await withBrowserCommandAbort(requireBrowserCommandRuntime(this.environment).send(send), abort.signal)
            );
            return this.recordRtcSendOutcome({ command, context, result, sendStartedAtEpochMs });
        }
        finally {
            abort.cleanup();
        }
    }

    private async waitForRtcReadiness(connected: BrowserRtcCommands.ConnectedRtc): Promise<RtcConnectReadinessResult> {
        const { command, context, connectionConfig } = connected;
        const options: RtcConnectReadinessOptions = {
            minReadyPeers: toPositiveInteger(command.readiness?.minReadyPeers, DEFAULT_READINESS_OPTIONS.minReadyPeers),
            timeoutMs: toPositiveInteger(command.readiness?.timeoutMs, DEFAULT_READINESS_OPTIONS.timeoutMs),
            intervalMs: toPositiveInteger(command.readiness?.intervalMs, DEFAULT_READINESS_OPTIONS.intervalMs)
        };
        recordRtcReadinessDiagnostic(connected, {
            topic: 'rallar.bb.rtc.readiness_wait_started',
            severity: 'info',
            payload: { ...options }
        });
        const readiness = await waitForRtcConnectReadiness({
            runtime: requireBrowserCommandRuntime(this.environment),
            transport: decodeRtcTransport(connectionConfig.rallar.transport),
            options,
            parentSignal: context.abortSignal?.()
        });
        recordRtcReadinessDiagnostic(connected, {
            topic: readiness.ready ? 'rallar.bb.rtc.readiness_ready' : 'rallar.bb.rtc.readiness_timeout',
            severity: readiness.ready ? 'info' : 'error',
            payload: {
                ...readiness,
                ...(readiness.ready ? {} : { message: toReadinessTimeoutMessage(connectionConfig) })
            }
        });
        return readiness;
    }

    private async readRtcSendInput(
        command: RtcSendCommand,
        context: RallarBlackBoxTestCommandContext,
        payload: RallarMessagePayload
    ): Promise<RallarMessagePayload> {
        const resolvedSend = replaceCommandPlaceholders(payload, {
            config: context.config(),
            session: this.environment.readSession(),
            wsTicket: undefined
        });
        const send = toScopedRtcSend(command, resolvedSend);
        if (!requiresRtcReadyPeerPlaceholder(send)) {
            return send;
        }
        const health = await requireBrowserCommandRuntime(this.environment).health();
        return replaceRtcReadyPeerPlaceholders(send, decodeRtcReadyPeerIds(health));
    }

    private recordRtcSendOutcome(sent: BrowserRtcCommands.SentRtc): RallarBlackBoxTestCommandOutcome {
        const { command, context } = sent;
        const durationMs = Math.max(0, this.environment.now() - sent.sendStartedAtEpochMs);
        return sent.result.fold(
            (failure) => {
                const sendObservation: RallarBlackBoxTestSendObservation = {
                    commandId: command.commandId,
                    kind: command.kind,
                    transport: command.transport,
                    durationMs,
                    ok: false,
                    errorCode: failure.code
                };
                recordRtcSendDiagnostic({ command, context, diagnostics: undefined, failure, sendObservation });
                return { status: 'failed', value: { sendObservation }, error: failure, nextStatus: 'failed' };
            },
            (result) => {
                const failure = toRtcSendFailure(result);
                const sendObservation = toRtcSendObservation({
                    command,
                    result,
                    durationMs,
                    ok: failure === undefined,
                    errorCode: failure?.code
                });
                const diagnostics = result.diagnostics;
                recordRtcSendDiagnostic({ command, context, diagnostics, failure, sendObservation });
                const value = { ...diagnostics, sendObservation };
                return failure
                    ? { status: 'failed', value, error: failure, nextStatus: 'failed' }
                    : { status: 'ok', value, nextStatus: context.state().status };
            }
        );
    }
}

function toReadinessTimeoutMessage(connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig): string {
    return decodeRtcTransport(connectionConfig.rallar.transport) === 'messages.rtc'
        ? 'RTC connect timed out waiting for room transport readiness.'
        : 'RTC connect timed out waiting for ready peers.';
}

function toRtcReadinessFailure(
    connected: BrowserRtcCommands.ConnectedRtc,
    readiness: RtcConnectReadinessResult
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: { ...connected.diagnostics, readiness },
        error: {
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: toReadinessTimeoutMessage(connected.connectionConfig),
            details: readiness
        },
        nextStatus: 'failed'
    };
}

function recordRtcReadinessDiagnostic(
    connected: BrowserRtcCommands.ConnectedRtc,
    diagnostic: BrowserRtcCommands.ReadinessDiagnostic
): void {
    const { context, command } = connected;
    const { topic, severity, payload } = diagnostic;
    context.recordEvent({
        kind: 'diagnostic',
        topic,
        commandId: command.commandId,
        connection: command.connection,
        transport: command.transport,
        severity,
        payload: toRallarBlackBoxRuntimeDiagnostic({
            topic,
            severity,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            detail: payload,
            payload,
            message: typeof payload.message === 'string' ? payload.message : undefined,
            source: 'browser-adapter'
        })
    });
}

function recordRtcConnected(
    connected: BrowserRtcCommands.ConnectedRtc,
    value: RallarBlackBoxTestRecord | undefined
): void {
    const { command, context, connectionConfig } = connected;
    const transport = decodeRtcTransport(connectionConfig.rallar.transport);
    context.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.rtc.connected',
        commandId: command.commandId,
        connection: connectionConfig.connection,
        actor: connectionConfig.actor,
        transport,
        severity: 'info',
        payload: toRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.rtc.connected',
            severity: 'info',
            commandId: command.commandId,
            connection: connectionConfig.connection,
            actor: connectionConfig.actor,
            transport,
            roomId: connectionConfig.roomId,
            detail: value,
            payload: value,
            source: 'browser-adapter'
        })
    });
}

function recordRtcSendDiagnostic(diagnostic: RtcSendDiagnostic): void {
    const { command, context, diagnostics, failure, sendObservation } = diagnostic;
    const topic = failure ? 'rallar.bb.rtc.send_failed' : 'rallar.bb.rtc.send_completed';
    const severity = failure ? 'error' : 'info';
    context.recordEvent({
        kind: 'diagnostic',
        topic,
        commandId: command.commandId,
        connection: command.connection,
        transport: command.transport,
        severity,
        payload: toRallarBlackBoxRuntimeDiagnostic({
            topic,
            severity,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            detail: diagnostics,
            payload: failure ? { diagnostics, failure, sendObservation } : { ...diagnostics, sendObservation },
            message: failure?.message,
            error: failure,
            source: 'browser-adapter'
        })
    });
}
