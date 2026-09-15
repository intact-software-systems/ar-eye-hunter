import { normalizeRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcSendCommand,
    RallarBlackBoxTestRtcStreamFrameObservation,
    RallarBlackBoxTestRtcStreamResultValue
} from '../rallar-black-box-test-contracts.ts';
import {
    planRallarBlackBoxRtcStreamFrames,
    replaceRallarBlackBoxRtcStreamPlaceholders,
    sampleRallarBlackBoxRtcStreamObservations,
    summarizeRallarBlackBoxRtcStreamObservations,
    type RallarBlackBoxRtcStreamPlaceholderContext
} from '../rtc-stream.ts';

import {
    createBrowserCommandAbortScope,
    sleep,
    withBrowserCommandAbort,
    type BrowserCommandAbortScope
} from './browser-command-cancellation.ts';
import type { CommandWithId, RallarBlackBoxBrowserRallarRuntime } from './browser-command-contracts.ts';
import { requireBrowserCommandRuntime, type BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { toPositiveInteger } from './browser-command-values.ts';
import { toScopedRtcSend } from './browser-rallar-command-input.ts';
import { decodeRtcSendResult, toRtcSendFailure, toRtcSendStatus } from './browser-rtc-send-observation.ts';

type RtcStreamCommand = Extract<CommandWithId, { kind: 'rtc.stream'; }>;

interface StreamFrame {
    readonly commandId: string;
    readonly index: number;
    readonly iteration: number;
    readonly scheduledAtEpochMs: number;
    readonly startedAtEpochMs: number;
}

interface UnsentFrameEnd {
    readonly completedAtEpochMs: number;
    readonly status: 'dropped' | 'failed' | 'drain-timeout';
    readonly errorCode: string;
}

interface StreamOutcome {
    readonly topic: string;
    readonly failed: boolean;
    readonly value: RallarBlackBoxTestRtcStreamResultValue;
    readonly message: string | undefined;
    readonly error: RallarBlackBoxTestError | undefined;
}

const DEFAULT_MAX_IN_FLIGHT = 64;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_PROGRESS_EVERY_MS = 1_000;
const DRAIN_POLL_MS = 25;

export namespace BrowserRtcStream {
    export interface Input {
        readonly environment: BrowserCommandEnvironment;
        readonly command: RtcStreamCommand;
        readonly context: RallarBlackBoxTestCommandContext;
    }
}

export class BrowserRtcStream {
    private readonly environment: BrowserCommandEnvironment;
    private readonly command: RtcStreamCommand;
    private readonly context: RallarBlackBoxTestCommandContext;
    private readonly plan: ReturnType<typeof planRallarBlackBoxRtcStreamFrames>;
    private readonly rallarRuntime: RallarBlackBoxBrowserRallarRuntime;
    private readonly abort: BrowserCommandAbortScope;
    private readonly streamStartedAtEpochMs: number;
    private readonly maxInFlight: number;
    private readonly drainTimeoutMs: number;
    private readonly progressEveryMs: number;
    private readonly observations: RallarBlackBoxTestRtcStreamFrameObservation[] = [];
    private readonly active = new Map<string, StreamFrame>();
    private readonly inFlight = new Set<Promise<void>>();
    private lastProgressAtEpochMs: number;

    constructor(input: BrowserRtcStream.Input) {
        const { command, context, environment } = input;
        this.command = command;
        this.context = context;
        this.environment = environment;
        this.plan = planRallarBlackBoxRtcStreamFrames({
            count: command.count,
            durationMs: command.durationMs,
            intervalMs: command.intervalMs,
            rateHz: command.rateHz
        });
        this.rallarRuntime = requireBrowserCommandRuntime(environment);
        this.abort = createBrowserCommandAbortScope(command, context, environment.now);
        this.streamStartedAtEpochMs = environment.now();
        this.maxInFlight = toPositiveInteger(command.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
        this.drainTimeoutMs = command.drainTimeoutMs !== undefined && command.drainTimeoutMs >= 0
            ? command.drainTimeoutMs
            : DEFAULT_DRAIN_TIMEOUT_MS;
        this.progressEveryMs = toPositiveInteger(command.progressEveryMs, DEFAULT_PROGRESS_EVERY_MS);
        this.lastProgressAtEpochMs = this.streamStartedAtEpochMs;
    }

    async start(): Promise<RallarBlackBoxTestCommandOutcome> {
        this.recordDiagnostic('rallar.bb.rtc.stream_started', {
            plannedFrames: this.plan.frames.length,
            intervalMs: this.plan.intervalMs,
            requestedRateHz: this.plan.requestedRateHz,
            maxInFlight: this.maxInFlight,
            drainTimeoutMs: this.drainTimeoutMs
        });
        try {
            await this.scheduleFrames();
            await this.drain();
        }
        finally {
            this.abort.cleanup();
        }
        this.recordProgress(true);
        return this.toOutcome();
    }

    private async scheduleFrames(): Promise<void> {
        for (const planned of this.plan.frames) {
            const scheduledAtEpochMs = this.streamStartedAtEpochMs + planned.scheduledElapsedMs;
            const delayMs = scheduledAtEpochMs - this.environment.now();
            if (delayMs > 0) {
                await sleep(delayMs, this.abort.signal);
            }
            const startedAtEpochMs = this.environment.now();
            const frame: StreamFrame = {
                commandId: `${this.command.commandId}:f${planned.iteration}`,
                index: planned.index,
                iteration: planned.iteration,
                scheduledAtEpochMs,
                startedAtEpochMs
            };
            if (this.active.size >= this.maxInFlight) {
                this.observations.push(toUnsentFrameObservation(frame, {
                    completedAtEpochMs: startedAtEpochMs,
                    status: 'dropped',
                    errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT'
                }));
            }
            else {
                this.startFrame(frame, {
                    commandId: frame.commandId,
                    index: planned.index,
                    iteration: planned.iteration,
                    elapsedMs: Math.max(0, startedAtEpochMs - this.streamStartedAtEpochMs),
                    scheduledElapsedMs: planned.scheduledElapsedMs
                });
            }
            this.recordProgress(false);
        }
    }

    private startFrame(frame: StreamFrame, streamContext: RallarBlackBoxRtcStreamPlaceholderContext): void {
        const resolvedSend = replaceCommandPlaceholders(this.command.send, {
            config: this.context.config(),
            session: this.environment.readSession(),
            wsTicket: undefined
        });
        const scopedSend = toScopedRtcSend(
            this.command,
            replaceRallarBlackBoxRtcStreamPlaceholders(resolvedSend, streamContext)
        );
        this.active.set(frame.commandId, frame);
        const sending = this.sendFrame(frame, scopedSend);
        this.inFlight.add(sending);
        void sending.finally(() => this.inFlight.delete(sending));
    }

    private async sendFrame(frame: StreamFrame, send: RallarBlackBoxTestRtcSendCommand['send']): Promise<void> {
        try {
            const result = decodeRtcSendResult(
                await withBrowserCommandAbort(this.rallarRuntime.send(send), this.abort.signal)
            );
            const failure = toRtcSendFailure(result);
            const completedAtEpochMs = this.environment.now();
            this.observations.push({
                ...toFrameTiming(frame, completedAtEpochMs),
                ok: failure === undefined,
                status: toRtcSendStatus(result),
                errorCode: failure?.code
            });
        }
        catch (error) {
            this.observations.push(toUnsentFrameObservation(frame, {
                completedAtEpochMs: this.environment.now(),
                status: 'failed',
                errorCode: error instanceof Error ? error.name : 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED'
            }));
        }
        finally {
            this.active.delete(frame.commandId);
        }
    }

    /** Frames still in flight when the drain window closes are recorded as drain timeouts, not left pending. */
    private async drain(): Promise<void> {
        const drainDeadlineEpochMs = this.environment.now() + this.drainTimeoutMs;
        while (this.inFlight.size > 0 && this.environment.now() < drainDeadlineEpochMs) {
            const remainingMs = Math.max(0, drainDeadlineEpochMs - this.environment.now());
            await Promise.race([...this.inFlight, sleep(Math.min(remainingMs, DRAIN_POLL_MS), this.abort.signal)]);
        }
        const completedAtEpochMs = this.environment.now();
        for (const frame of this.active.values()) {
            this.observations.push(toUnsentFrameObservation(frame, {
                completedAtEpochMs,
                status: 'drain-timeout',
                errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_DRAIN_TIMEOUT'
            }));
        }
        this.active.clear();
    }

    private recordProgress(force: boolean): void {
        const now = this.environment.now();
        if (!force && now - this.lastProgressAtEpochMs < this.progressEveryMs) {
            return;
        }
        this.lastProgressAtEpochMs = now;
        this.recordDiagnostic('rallar.bb.rtc.stream_progress', {
            plannedFrames: this.plan.frames.length,
            scheduledFrames: this.observations.length + this.active.size,
            completedFrames: this.observations.filter((observation) => observation.ok && !observation.dropped).length,
            failedFrames: this.observations.filter((observation) => !observation.ok).length,
            droppedFrames: this.observations.filter((observation) => observation.dropped).length,
            inFlightFrames: this.active.size
        });
    }

    private toOutcome(): RallarBlackBoxTestCommandOutcome {
        const summarized = summarizeRallarBlackBoxRtcStreamObservations({
            commandId: this.command.commandId,
            transport: this.command.transport,
            startedAtEpochMs: this.streamStartedAtEpochMs,
            endedAtEpochMs: this.environment.now(),
            intervalMs: this.plan.intervalMs,
            requestedRateHz: this.plan.requestedRateHz,
            plannedFrames: this.plan.frames.length,
            observations: this.observations,
            thresholds: this.command.thresholds
        });
        const outcome = toStreamOutcome(this.command, {
            ...summarized,
            observations: sampleRallarBlackBoxRtcStreamObservations(
                summarized.observations,
                toPositiveInteger(this.command.sampleEvery, 1)
            )
        });
        this.recordStreamOutcome(outcome);
        return {
            status: outcome.failed ? 'failed' : 'ok',
            value: outcome.value,
            error: outcome.error,
            nextStatus: outcome.failed ? 'failed' : this.context.state().status
        };
    }

    private recordStreamOutcome(outcome: StreamOutcome): void {
        const { command, context } = this;
        const severity = outcome.failed ? 'error' : 'info';
        context.recordEvent({
            kind: 'diagnostic',
            topic: outcome.topic,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity,
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: outcome.topic,
                severity,
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: outcome.value,
                payload: outcome.value,
                message: outcome.message,
                error: outcome.error,
                source: 'browser-adapter'
            })
        });
    }

    private recordDiagnostic(topic: string, data: RallarBlackBoxTestRecord): void {
        const { command, context } = this;
        context.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity: 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data,
                source: 'browser-adapter'
            })
        });
    }
}

function toStreamOutcome(command: RtcStreamCommand, value: RallarBlackBoxTestRtcStreamResultValue): StreamOutcome {
    const thresholdFailed = value.thresholdFailures.length > 0;
    const sendFailed = value.failedFrames > 0 && command.continueOnSendFailure !== true;
    const failed = thresholdFailed || sendFailed;
    const message = thresholdFailed
        ? 'RTC stream did not satisfy configured thresholds.'
        : sendFailed
        ? 'RTC stream had failed frame sends.'
        : undefined;
    const error = failed
        ? {
            code: thresholdFailed
                ? 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED'
                : 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
            message: message ?? 'RTC stream failed.',
            details: thresholdFailed
                ? { thresholdFailures: value.thresholdFailures, value }
                : { failedFrames: value.failedFrames, droppedFrames: value.droppedFrames, value }
        }
        : undefined;
    return {
        topic: failed ? 'rallar.bb.rtc.stream_failed' : 'rallar.bb.rtc.stream_completed',
        failed,
        value,
        message,
        error
    };
}

function toFrameTiming(frame: StreamFrame, completedAtEpochMs: number): RallarBlackBoxTestRtcStreamFrameObservation {
    return {
        commandId: frame.commandId,
        index: frame.index,
        iteration: frame.iteration,
        scheduledAtEpochMs: frame.scheduledAtEpochMs,
        startedAtEpochMs: frame.startedAtEpochMs,
        completedAtEpochMs,
        startDriftMs: Math.max(0, frame.startedAtEpochMs - frame.scheduledAtEpochMs),
        durationMs: Math.max(0, completedAtEpochMs - frame.startedAtEpochMs),
        ok: false
    };
}

function toUnsentFrameObservation(
    frame: StreamFrame,
    end: UnsentFrameEnd
): RallarBlackBoxTestRtcStreamFrameObservation {
    return {
        ...toFrameTiming(frame, end.completedAtEpochMs),
        ok: false,
        ...(end.status === 'dropped' ? { dropped: true } : {}),
        status: end.status,
        errorCode: end.errorCode
    };
}
