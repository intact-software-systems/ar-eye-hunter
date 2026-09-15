import {
    normalizeRallarBlackBoxRuntimeDiagnostic
} from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRtcStreamFrameObservation
} from '../rallar-black-box-test-contracts.ts';
import {
    planRallarBlackBoxRtcStreamFrames,
    replaceRallarBlackBoxRtcStreamPlaceholders,
    sampleRallarBlackBoxRtcStreamObservations,
    summarizeRallarBlackBoxRtcStreamObservations
} from '../rtc-stream.ts';

import { createBrowserCommandAbortScope, sleep, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import { CommandWithId } from './browser-command-contracts.ts';
import { BrowserCommandEnvironment, requireBrowserCommandRuntime } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { toPositiveInteger } from './browser-command-values.ts';
import { toScopedRtcSend } from './browser-rallar-command-input.ts';
import {
    decodeRtcSendResult,
    toRtcSendFailure,
    toRtcSendStatus,
    type RtcSendResult
} from './browser-rtc-send-observation.ts';

interface StreamFrame {
    readonly commandId: string;
    readonly index: number;
    readonly iteration: number;
    readonly scheduledAtEpochMs: number;
    readonly startedAtEpochMs: number;
}
export namespace BrowserRtcStream {
    export interface Input {
        readonly environment: BrowserCommandEnvironment;
        readonly command: Extract<CommandWithId, { kind: 'rtc.stream'; }>;
        readonly context: RallarBlackBoxTestCommandContext;
    }

    export interface SettledFrame {
        readonly frame: StreamFrame;
        readonly completedAtEpochMs: number;
        readonly result: RtcSendResult;
        readonly errorCode: string | undefined;
        readonly ok: boolean;
    }
}
export class BrowserRtcStream {
    readonly environment: BrowserCommandEnvironment;
    readonly command: BrowserRtcStream.Input['command'];
    readonly context: RallarBlackBoxTestCommandContext;
    readonly plan: ReturnType<typeof planRallarBlackBoxRtcStreamFrames>;
    readonly rallarRuntime: ReturnType<typeof requireBrowserCommandRuntime>;
    readonly abort: ReturnType<typeof createBrowserCommandAbortScope>;
    readonly streamStartedAtEpochMs: number;
    readonly maxInFlight: number;
    readonly drainTimeoutMs: number;
    readonly progressEveryMs: number;
    readonly sampleEvery: number;
    readonly observations: RallarBlackBoxTestRtcStreamFrameObservation[];
    readonly active: Map<string, StreamFrame>;
    readonly inFlight: Set<Promise<void>>;
    lastProgressAtEpochMs: number;
    constructor(input: BrowserRtcStream.Input) {
        const { command, context, environment } = input;
        this.command = command;
        this.context = context;
        this.environment = environment;
        const plan = planRallarBlackBoxRtcStreamFrames({
            count: command.count,
            durationMs: command.durationMs,
            intervalMs: command.intervalMs,
            rateHz: command.rateHz
        });
        const rallarRuntime = requireBrowserCommandRuntime(environment);
        const abort = createBrowserCommandAbortScope(command, context, environment.now);
        const streamStartedAtEpochMs = environment.now();
        const maxInFlight = toPositiveInteger(command.maxInFlight, 64);
        const drainTimeoutMs = typeof command.drainTimeoutMs === 'number' && command.drainTimeoutMs >= 0
            ? command.drainTimeoutMs
            : 5_000;
        const progressEveryMs = toPositiveInteger(command.progressEveryMs, 1_000);
        const sampleEvery = toPositiveInteger(command.sampleEvery, 1);
        const observations: RallarBlackBoxTestRtcStreamFrameObservation[] = [];
        const active = new Map<string, StreamFrame>();
        const inFlight = new Set<Promise<void>>();

        this.plan = plan;
        this.rallarRuntime = rallarRuntime;
        this.abort = abort;
        this.streamStartedAtEpochMs = streamStartedAtEpochMs;
        this.maxInFlight = maxInFlight;
        this.drainTimeoutMs = drainTimeoutMs;
        this.progressEveryMs = progressEveryMs;
        this.sampleEvery = sampleEvery;
        this.observations = observations;
        this.active = active;
        this.inFlight = inFlight;
        this.lastProgressAtEpochMs = streamStartedAtEpochMs;
    }
    async start(): Promise<RallarBlackBoxTestCommandOutcome> {
        this.recordStarted();
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

    private recordProgress(force = false): void {
        const { command, context, environment, plan, progressEveryMs, observations, active } = this;

        const now = environment.now();
        if (!force && now - this.lastProgressAtEpochMs < progressEveryMs) {
            return;
        }
        this.lastProgressAtEpochMs = now;
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.stream_progress',
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.bb.rtc.stream_progress',
                severity: 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: {
                    plannedFrames: plan.frames.length,
                    scheduledFrames: observations.length + active.size,
                    completedFrames: observations.filter(
                        (observation) => observation.ok && !observation.dropped
                    ).length,
                    failedFrames: observations.filter((observation) => !observation.ok)
                        .length,
                    droppedFrames: observations.filter(
                        (observation) => observation.dropped
                    ).length,
                    inFlightFrames: active.size
                },
                source: 'browser-adapter'
            })
        });
    }
    private recordStarted(): void {
        const { command, context, plan, maxInFlight, drainTimeoutMs } = this;
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.stream_started',
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.bb.rtc.stream_started',
                severity: 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: {
                    plannedFrames: plan.frames.length,
                    intervalMs: plan.intervalMs,
                    requestedRateHz: plan.requestedRateHz,
                    maxInFlight,
                    drainTimeoutMs
                },
                source: 'browser-adapter'
            })
        });
    }
    private async scheduleFrames(): Promise<void> {
        const {
            command,
            context,
            environment,
            plan,
            abort,
            streamStartedAtEpochMs,
            maxInFlight,
            observations,
            active,
            inFlight
        } = this;
        for (const frame of plan.frames) {
            const scheduledAtEpochMs = streamStartedAtEpochMs + frame.scheduledElapsedMs;
            const delayMs = Math.max(0, scheduledAtEpochMs - environment.now());
            if (delayMs > 0) {
                await sleep(delayMs, abort.signal);
            }

            const startedAtEpochMs = environment.now();
            const frameCommandId = `${command.commandId}:f${frame.iteration}`;
            const activeFrame = {
                commandId: frameCommandId,
                index: frame.index,
                iteration: frame.iteration,
                scheduledAtEpochMs,
                startedAtEpochMs
            };

            if (active.size >= maxInFlight) {
                observations.push({
                    ...activeFrame,
                    completedAtEpochMs: startedAtEpochMs,
                    startDriftMs: Math.max(0, startedAtEpochMs - scheduledAtEpochMs),
                    durationMs: 0,
                    ok: false,
                    dropped: true,
                    status: 'dropped',
                    errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT'
                });
                this.recordProgress();
                continue;
            }

            const scopedSend = this.toScopedRtcStreamSend(command, context, {
                commandId: frameCommandId,
                index: frame.index,
                iteration: frame.iteration,
                elapsedMs: Math.max(0, startedAtEpochMs - streamStartedAtEpochMs),
                scheduledElapsedMs: frame.scheduledElapsedMs
            });
            active.set(frameCommandId, activeFrame);
            const promise = this.sendFrame(activeFrame, scopedSend);
            inFlight.add(promise);
            promise.finally(() => inFlight.delete(promise));
            this.recordProgress();
        }
    }
    private async sendFrame(activeFrame: StreamFrame, scopedSend: unknown): Promise<void> {
        const { environment, rallarRuntime, abort, observations, active } = this;

        try {
            const result = decodeRtcSendResult(
                await withBrowserCommandAbort(rallarRuntime.send(scopedSend), abort.signal)
            );
            const completedAtEpochMs = environment.now();
            const failure = toRtcSendFailure(result);
            observations.push(
                this.toRtcStreamObservation({
                    frame: activeFrame,
                    completedAtEpochMs: completedAtEpochMs,
                    result,
                    errorCode: failure?.code,
                    ok: failure === undefined
                })
            );
        }
        catch (error) {
            const completedAtEpochMs = environment.now();
            observations.push({
                commandId: activeFrame.commandId,
                index: activeFrame.index,
                iteration: activeFrame.iteration,
                scheduledAtEpochMs: activeFrame.scheduledAtEpochMs,
                startedAtEpochMs: activeFrame.startedAtEpochMs,
                completedAtEpochMs,
                startDriftMs: Math.max(
                    0,
                    activeFrame.startedAtEpochMs - activeFrame.scheduledAtEpochMs
                ),
                durationMs: Math.max(
                    0,
                    completedAtEpochMs - activeFrame.startedAtEpochMs
                ),
                ok: false,
                status: 'failed',
                errorCode: error instanceof Error
                    ? error.name
                    : 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED'
            });
        }
        finally {
            active.delete(activeFrame.commandId);
        }
    }
    private async drain(): Promise<void> {
        const { environment, abort, drainTimeoutMs, observations, active, inFlight } = this;
        const drainDeadlineEpochMs = environment.now() + drainTimeoutMs;
        while (inFlight.size > 0 && environment.now() < drainDeadlineEpochMs) {
            const remainingMs = Math.max(0, drainDeadlineEpochMs - environment.now());
            await Promise.race([
                ...inFlight,
                sleep(Math.min(remainingMs, 25), abort.signal)
            ]);
        }
        if (active.size > 0) {
            const now = environment.now();
            for (const frame of active.values()) {
                observations.push({
                    commandId: frame.commandId,
                    index: frame.index,
                    iteration: frame.iteration,
                    scheduledAtEpochMs: frame.scheduledAtEpochMs,
                    startedAtEpochMs: frame.startedAtEpochMs,
                    completedAtEpochMs: now,
                    startDriftMs: Math.max(
                        0,
                        frame.startedAtEpochMs - frame.scheduledAtEpochMs
                    ),
                    durationMs: Math.max(0, now - frame.startedAtEpochMs),
                    ok: false,
                    status: 'drain-timeout',
                    errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_DRAIN_TIMEOUT'
                });
            }
            active.clear();
        }
    }
    private toOutcome(): RallarBlackBoxTestCommandOutcome {
        const { command, context, environment, plan, streamStartedAtEpochMs, sampleEvery, observations } = this;
        const endedAtEpochMs = environment.now();
        const summarizedValue = summarizeRallarBlackBoxRtcStreamObservations({
            commandId: command.commandId,
            transport: command.transport,
            startedAtEpochMs: streamStartedAtEpochMs,
            endedAtEpochMs,
            intervalMs: plan.intervalMs,
            requestedRateHz: plan.requestedRateHz,
            plannedFrames: plan.frames.length,
            observations,
            thresholds: command.thresholds
        });
        const value = {
            ...summarizedValue,
            observations: sampleRallarBlackBoxRtcStreamObservations(
                summarizedValue.observations,
                sampleEvery
            )
        };
        const thresholdFailed = value.thresholdFailures.length > 0;
        const sendFailed = value.failedFrames > 0 && command.continueOnSendFailure !== true;
        const failed = thresholdFailed || sendFailed;
        const topic = failed
            ? 'rallar.bb.rtc.stream_failed'
            : 'rallar.bb.rtc.stream_completed';
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

        this.recordOutcome({ topic, failed, value, message, error });

        return {
            status: failed ? 'failed' : 'ok',
            value,
            error,
            nextStatus: failed ? 'failed' : context.state().status
        };
    }
    private recordOutcome(
        result: {
            readonly topic: string;
            readonly failed: boolean;
            readonly value: RallarBlackBoxTestCommandOutcome['value'];
            readonly message: string | undefined;
            readonly error: RallarBlackBoxTestCommandOutcome['error'];
        }
    ): void {
        const { command, context } = this;
        const { topic, failed, value, message, error } = result;
        context.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: failed ? 'error' : 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity: failed ? 'error' : 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: value,
                payload: value,
                message,
                error,
                source: 'browser-adapter'
            })
        });
    }
    private toScopedRtcStreamSend(
        command: Extract<CommandWithId, { kind: 'rtc.stream'; }>,
        context: RallarBlackBoxTestCommandContext,
        streamContext: Parameters<typeof replaceRallarBlackBoxRtcStreamPlaceholders>[1]
    ): unknown {
        const resolvedSend = replaceCommandPlaceholders(command.send, {
            config: context.config(),
            session: this.environment.readSession()
        });
        const streamSend = replaceRallarBlackBoxRtcStreamPlaceholders(
            resolvedSend,
            streamContext
        );
        return toScopedRtcSend(command, streamSend);
    }
    private toRtcStreamObservation(input: BrowserRtcStream.SettledFrame): RallarBlackBoxTestRtcStreamFrameObservation {
        const { frame, completedAtEpochMs, result, errorCode, ok } = input;
        const status = toRtcSendStatus(result);
        return {
            commandId: frame.commandId,
            index: frame.index,
            iteration: frame.iteration,
            scheduledAtEpochMs: frame.scheduledAtEpochMs,
            startedAtEpochMs: frame.startedAtEpochMs,
            completedAtEpochMs,
            startDriftMs: Math.max(
                0,
                frame.startedAtEpochMs - frame.scheduledAtEpochMs
            ),
            durationMs: Math.max(0, completedAtEpochMs - frame.startedAtEpochMs),
            ok,
            status,
            errorCode
        };
    }
}
