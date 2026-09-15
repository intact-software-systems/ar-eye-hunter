import { normalizeRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcSendCommand,
    RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import type {
    CommandWithId,
    RallarBlackBoxBrowserRallarConnectionConfig,
    RallarBlackBoxBrowserRallarRuntimeResult
} from './browser-command-contracts.ts';
import { requireBrowserCommandRuntime, type BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { decodeRtcTransport, isBrowserCommandRecord, toPositiveInteger } from './browser-command-values.ts';
import { toRallarConnectionConfig, toScopedRtcSend } from './browser-rallar-command-input.ts';
import {
    decodeRtcSendResult,
    toRtcSendFailure,
    toRtcSendObservation,
    withSendObservationValue
} from './browser-rtc-send-observation.ts';
import {
    toRtcReadyPeerIds,
    waitForRtcConnectReadiness,
    type RtcConnectReadinessOptions,
    type RtcConnectReadinessResult
} from './rtc-connect-readiness.ts';
import { replaceRtcReadyPeerPlaceholders, requiresRtcReadyPeerPlaceholder } from './rtc-ready-peer-placeholders.ts';

type RtcConnectCommand = Extract<CommandWithId, { kind: 'rtc.connect'; }>;
type RtcSendCommand = Extract<CommandWithId, { kind: 'rtc.send'; }>;

export namespace BrowserRtcCommands {
    export interface ConnectedRtc {
        readonly command: RtcConnectCommand;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig;
        readonly diagnostics: RallarBlackBoxBrowserRallarRuntimeResult;
    }

    export interface SentRtc {
        readonly command: RtcSendCommand;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly diagnostics: RallarBlackBoxBrowserRallarRuntimeResult;
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
    readonly diagnostics: RallarBlackBoxBrowserRallarRuntimeResult;
    readonly failure: RallarBlackBoxTestError | undefined;
    readonly sendObservation: RallarBlackBoxTestSendObservation;
}

const DEFAULT_READINESS_OPTIONS: RtcConnectReadinessOptions = { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 100 };

/** Runs rtc.connect (with its optional readiness wait) and rtc.send against the page runtime. */
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
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        let diagnostics: RallarBlackBoxBrowserRallarRuntimeResult;
        try {
            const runtime = requireBrowserCommandRuntime(this.environment);
            diagnostics = await withBrowserCommandAbort(runtime.connect(connectionConfig), abort.signal);
        }
        finally {
            abort.cleanup();
        }
        const connected = { command, context, connectionConfig, diagnostics };
        const readiness = command.readiness ? await this.waitForRtcReadiness(connected) : undefined;
        if (readiness && !readiness.ready) {
            return toRtcReadinessFailure(connected, readiness);
        }
        const value = readiness ? withRtcConnectReadinessValue(diagnostics, readiness) : diagnostics;
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
        const send = await this.readRtcSendInput(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        const sendStartedAtEpochMs = this.environment.now();
        let diagnostics: RallarBlackBoxBrowserRallarRuntimeResult;
        try {
            diagnostics = await withBrowserCommandAbort(
                requireBrowserCommandRuntime(this.environment).send(send),
                abort.signal
            );
        }
        finally {
            abort.cleanup();
        }
        return this.recordRtcSendOutcome({ command, context, diagnostics, sendStartedAtEpochMs });
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

    /** `{rtc.readyPeerIds}` placeholders read the page's ready peers just before the send. */
    private async readRtcSendInput(
        command: RtcSendCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestRtcSendCommand['send']> {
        const resolvedSend = replaceCommandPlaceholders(command.send ?? {}, {
            config: context.config(),
            session: this.environment.readSession(),
            wsTicket: undefined
        });
        const send = toScopedRtcSend(command, resolvedSend);
        if (!requiresRtcReadyPeerPlaceholder(send)) {
            return send;
        }
        const health = await requireBrowserCommandRuntime(this.environment).health();
        return replaceRtcReadyPeerPlaceholders(send, toRtcReadyPeerIds(health));
    }

    private recordRtcSendOutcome(sent: BrowserRtcCommands.SentRtc): RallarBlackBoxTestCommandOutcome {
        const { command, context, diagnostics } = sent;
        const result = decodeRtcSendResult(diagnostics);
        const failure = toRtcSendFailure(result);
        const sendObservation = toRtcSendObservation({
            command,
            result,
            durationMs: Math.max(0, this.environment.now() - sent.sendStartedAtEpochMs),
            ok: failure === undefined,
            errorCode: failure?.code
        });
        recordRtcSendDiagnostic({ command, context, diagnostics, failure, sendObservation });
        const value = withSendObservationValue(diagnostics, sendObservation);
        return failure
            ? { status: 'failed', value, error: failure, nextStatus: 'failed' }
            : { status: 'ok', value, nextStatus: context.state().status };
    }
}

function toReadinessTimeoutMessage(connectionConfig: RallarBlackBoxBrowserRallarConnectionConfig): string {
    return decodeRtcTransport(connectionConfig.rallar.transport) === 'messages.rtc'
        ? 'RTC connect timed out waiting for room transport readiness.'
        : 'RTC connect timed out waiting for ready peers.';
}

function withRtcConnectReadinessValue(
    diagnostics: RallarBlackBoxBrowserRallarRuntimeResult,
    readiness: RtcConnectReadinessResult
): RallarBlackBoxTestRecord {
    return isBrowserCommandRecord(diagnostics) ? { ...diagnostics, readiness } : { diagnostics, readiness };
}

function toRtcReadinessFailure(
    connected: BrowserRtcCommands.ConnectedRtc,
    readiness: RtcConnectReadinessResult
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: withRtcConnectReadinessValue(connected.diagnostics, readiness),
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

function recordRtcConnected(
    connected: BrowserRtcCommands.ConnectedRtc,
    value: RallarBlackBoxBrowserRallarRuntimeResult
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
        payload: normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.rtc.connected',
            severity: 'info',
            commandId: command.commandId,
            connection: connectionConfig.connection,
            actor: connectionConfig.actor,
            transport,
            roomId: connectionConfig.roomId,
            data: value,
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
        payload: normalizeRallarBlackBoxRuntimeDiagnostic({
            topic,
            severity,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            data: diagnostics,
            payload: failure
                ? { diagnostics, failure, sendObservation }
                : withSendObservationValue(diagnostics, sendObservation),
            message: failure?.message,
            error: failure,
            source: 'browser-adapter'
        })
    });
}
