import {
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
    rallarBlackBoxLoopChildResultPath,
    rallarBlackBoxLoopChildSourceRecipePath
} from './composite-results.ts';
import { evaluateLoopThresholds, validateLoopThresholds } from './loop/loop-command-thresholds.ts';
import { runLoopUntilFirstSuccess, validateLoopUntilCommand, type LoopIterationOutcome } from './loop/loop-until.ts';
import { toLoopResultValue, type LoopResultMetrics } from './loop/to-loop-result-value.ts';
import {
    computeCommandDeadlineEpochMs,
    isAbortError,
    toBoundedDeadlineCommand,
    toCommandLabelForId,
    toNonNegativeInteger,
    toPositiveInteger,
    toRecord
} from './to-runtime-command-values.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandOutcome,
    type RallarBlackBoxTestCompositeChildResult,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestLoopPacingIteration,
    type RallarBlackBoxTestLoopResultValue,
    type RallarBlackBoxTestLoopThresholdFailure,
    type RallarBlackBoxTestResult
} from './rallar-black-box-test-contracts.ts';

type LoopCommandWithId = RallarBlackBoxTestLoopCommand & Readonly<{ commandId: string; }>;

interface RunLoopIterationInput {
    readonly iterationIndex: number;
    readonly scheduledAtEpochMs: number;
    readonly stopOnChildFailure: boolean;
}

interface LoopContext {
    loopCommandId: string;
    index: number;
    iteration: number;
    elapsedMs: number;
    commandIndex: number;
}
const LOOP_PLACEHOLDER_PATTERN = /\{loop\.(index|iteration|elapsedMs|commandIndex)\}/g;
const LOOP_EXACT_PLACEHOLDER_PATTERN = /^\{loop\.(index|iteration|elapsedMs|commandIndex)\}$/;
function replaceLoopPlaceholders(value: unknown, context: LoopContext): unknown {
    if (typeof value === 'string') {
        const exact = LOOP_EXACT_PLACEHOLDER_PATTERN.exec(value);
        if (exact) {
            return loopPlaceholderValue(exact[1], context);
        }

        return value.replace(
            LOOP_PLACEHOLDER_PATTERN,
            (_match, name: string) => String(loopPlaceholderValue(name, context))
        );
    }

    if (Array.isArray(value)) {
        return value.map((entry) => replaceLoopPlaceholders(entry, context));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                replaceLoopPlaceholders(entry, context)
            ])
        );
    }

    return value;
}
export namespace LoopCommandExecution {
    export interface Ports {
        readonly now: () => number;
        readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
        readonly executeCommand: (
            command: RallarBlackBoxTestCommand,
            options?: Readonly<{ bypassCache?: boolean; }>
        ) => Promise<RallarBlackBoxTestResult>;
        readonly cancelRequested: () => boolean;
        readonly abortSignal: () => AbortSignal;
    }
}

export class LoopCommandExecution {
    private readonly command: LoopCommandWithId;
    private count = 0;
    private durationMs: number | undefined;
    private intervalMs = 0;
    private maxCommands = 0;
    private plannedCommandCount = 0;
    private loopStartedAtEpochMs = 0;
    private deadlineEpochMs: number | undefined;
    private readonly results: RallarBlackBoxTestCompositeChildResult[] = [];
    private readonly pacingIterations: RallarBlackBoxTestLoopPacingIteration[] = [];
    private readonly ports: LoopCommandExecution.Ports;
    constructor(command: LoopCommandWithId, ports: LoopCommandExecution.Ports) {
        this.command = command;
        this.ports = ports;
    }
    async run(): Promise<RallarBlackBoxTestCommandOutcome> {
        const invalid = this.validateBounds() ?? this.validateWorkLimit() ?? this.validatePolicies();
        if (invalid) {
            return invalid;
        }
        this.loopStartedAtEpochMs = this.ports.now();
        this.deadlineEpochMs = computeCommandDeadlineEpochMs(this.command, this.ports.now());
        if (this.command.until === 'first-success') {
            return await this.runUntilFirstSuccess();
        }
        for (let iterationIndex = 0; iterationIndex < this.count; iterationIndex++) {
            const stopped = this.toStoppedOutcome();
            if (stopped) {
                return stopped;
            }
            if (iterationIndex > 0 && this.durationExpired()) {
                break;
            }
            const iteration = await this.runLoopIteration({
                iterationIndex,
                scheduledAtEpochMs: this.loopStartedAtEpochMs + iterationIndex * this.intervalMs,
                stopOnChildFailure: false
            });
            if (iteration.kind === 'outcome') {
                return iteration.outcome;
            }
            if (iterationIndex + 1 >= this.count || this.durationExpired()) {
                break;
            }
            const delayOutcome = await this.waitForNextIteration();
            if (delayOutcome) {
                return delayOutcome;
            }
        }
        return this.toLoopCompletionOutcome(this.toCurrentValue(false));
    }

    private async runLoopIteration(input: RunLoopIterationInput): Promise<LoopIterationOutcome> {
        const measurement = { startedAtEpochMs: this.ports.now(), resultStartIndex: this.results.length };
        const completion = await this.runIterationCommands(input);
        this.recordIteration(input, measurement, completion.kind === 'cancelled');
        return this.toIterationOutcome(completion, input.stopOnChildFailure);
    }

    private async sleepForLoopUntil(ms: number): Promise<'slept' | 'cancelled'> {
        try {
            await this.ports.sleep(ms, this.ports.abortSignal());
            return 'slept';
        }
        catch (error) {
            if (isAbortError(error)) {
                return 'cancelled';
            }
            throw error;
        }
    }

    private toLoopCompletionOutcome(
        value: RallarBlackBoxTestLoopResultValue
    ): RallarBlackBoxTestCommandOutcome {
        const thresholdFailures = evaluateLoopThresholds(this.command.thresholds, value);
        if (thresholdFailures.length > 0) {
            return {
                status: 'failed',
                value: {
                    ...value,
                    thresholdFailures
                },
                error: {
                    code: 'RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED',
                    message: 'Loop did not satisfy configured pacing or send thresholds.',
                    details: {
                        thresholdFailures
                    }
                },
                nextStatus: 'failed'
            };
        }

        return {
            status: 'ok',
            value,
            nextStatus: 'completed'
        };
    }

    private toLoopChildCommand(
        childCommand: RallarBlackBoxTestCommand,
        context: LoopContext,
        deadlineEpochMs: number | undefined
    ): RallarBlackBoxTestCommand {
        const command = this.command;
        const resolved = replaceLoopPlaceholders(childCommand, context) as RallarBlackBoxTestCommand;
        const child = {
            ...resolved,
            commandId: [
                command.commandId,
                `i${context.iteration}`,
                `c${context.commandIndex + 1}`,
                toCommandLabelForId(childCommand, context.commandIndex + 1)
            ].join(':'),
            metadata: {
                ...toRecord(resolved.metadata),
                loop: {
                    commandId: context.loopCommandId,
                    index: context.index,
                    iteration: context.iteration,
                    elapsedMs: context.elapsedMs,
                    commandIndex: context.commandIndex,
                    originalCommandId: childCommand.commandId
                }
            }
        } as RallarBlackBoxTestCommand;

        return deadlineEpochMs === undefined
            ? child
            : toBoundedDeadlineCommand(child, deadlineEpochMs);
    }

    private loopInvalid(
        message: string,
        details?: unknown
    ): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value: toLoopResultValue({
                commandId: this.command.commandId,
                results: [],
                cancelled: false,
                metrics: undefined
            }),
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_INVALID',
                message,
                details
            },
            nextStatus: 'failed'
        };
    }

    private loopLimitExceeded(
        results: readonly RallarBlackBoxTestCompositeChildResult[],
        details: unknown,
        metrics?: LoopResultMetrics
    ): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value: toLoopResultValue({
                commandId: this.command.commandId,
                results: results,
                cancelled: false,
                metrics: metrics
            }),
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED',
                message: 'Loop would exceed the configured maximum child command count.',
                details
            },
            nextStatus: 'failed'
        };
    }

    private loopTimedOut(
        results: readonly RallarBlackBoxTestCompositeChildResult[],
        deadlineEpochMs: number,
        metrics?: LoopResultMetrics
    ): RallarBlackBoxTestCommandOutcome {
        const command = this.command;
        return {
            status: 'failed',
            value: toLoopResultValue({
                commandId: this.command.commandId,
                results: results,
                cancelled: false,
                metrics: metrics
            }),
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_TIMEOUT',
                message: 'Loop reached its timeout before all iterations completed.',
                details: {
                    timeoutMs: command.timeoutMs,
                    deadlineEpochMs,
                    completedCommands: results.length
                }
            },
            nextStatus: 'failed'
        };
    }

    private validateBounds(): RallarBlackBoxTestCommandOutcome | undefined {
        const command = this.command;
        if (!Array.isArray(command.commands) || command.commands.length === 0) {
            return this.loopInvalid('Loop requires at least one child command.');
        }
        this.durationMs = command.durationMs === undefined ? undefined : toPositiveInteger(command.durationMs);
        if (command.durationMs !== undefined && this.durationMs === undefined) {
            return this.loopInvalid('Loop durationMs must be a positive integer.', { durationMs: command.durationMs });
        }
        if (
            this.durationMs !== undefined && this.durationMs > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs
        ) {
            return this.loopInvalid('Loop durationMs exceeds the runtime maximum.', {
                durationMs: this.durationMs,
                maxLoopDurationMs: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs
            });
        }
        const count = command.count === undefined
            ? this.durationMs === undefined ? 1 : RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount
            : toPositiveInteger(command.count);
        if (count === undefined) {
            return this.loopInvalid('Loop count must be a positive integer.', { count: command.count });
        }
        if (count > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount) {
            return this.loopInvalid('Loop count exceeds the runtime maximum.', {
                count,
                maxLoopCount: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount
            });
        }
        this.count = count;
        return undefined;
    }

    private validateWorkLimit(): RallarBlackBoxTestCommandOutcome | undefined {
        const command = this.command;
        const source = command.intervalMs ?? command.delayMs;
        const interval = source === undefined ? 0 : toNonNegativeInteger(source);
        if (interval === undefined) {
            return this.loopInvalid('Loop intervalMs/delayMs must be a non-negative integer.', {
                intervalMs: command.intervalMs,
                delayMs: command.delayMs
            });
        }
        this.intervalMs = interval;
        const requested = command.maxCommands === undefined
            ? RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands
            : toPositiveInteger(command.maxCommands);
        if (requested === undefined) {
            return this.loopInvalid('Loop maxCommands must be a positive integer.', {
                maxCommands: command.maxCommands
            });
        }
        this.maxCommands = Math.min(requested, RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands);
        this.plannedCommandCount = this.count * command.commands.length;
        return this.durationMs === undefined && this.plannedCommandCount > this.maxCommands
            ? this.loopLimitExceeded([], {
                plannedCommandCount: this.plannedCommandCount,
                maxCommands: this.maxCommands
            })
            : undefined;
    }

    private validatePolicies(): RallarBlackBoxTestCommandOutcome | undefined {
        const threshold = validateLoopThresholds(this.command.thresholds);
        if (threshold) {
            return this.loopInvalid(threshold.message, threshold.details);
        }
        const issues = validateLoopUntilCommand(this.command);
        return issues.length ? this.loopInvalid(issues[0].message, issues[0].details) : undefined;
    }

    private durationExpired(): boolean {
        return this.durationMs !== undefined &&
            Math.max(0, this.ports.now() - this.loopStartedAtEpochMs) >= this.durationMs;
    }

    private toCurrentMetrics(thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[]): LoopResultMetrics {
        return {
            intervalMs: this.intervalMs,
            count: this.count,
            durationMs: this.durationMs,
            startedAtEpochMs: this.loopStartedAtEpochMs,
            endedAtEpochMs: this.ports.now(),
            pacingIterations: this.pacingIterations,
            thresholdFailures
        };
    }

    private toCurrentValue(
        cancelled: boolean,
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[]
    ): RallarBlackBoxTestLoopResultValue {
        return toLoopResultValue({
            commandId: this.command.commandId,
            results: this.results,
            cancelled: cancelled,
            metrics: this.toCurrentMetrics(thresholdFailures)
        });
    }

    private toStoppedOutcome(): RallarBlackBoxTestCommandOutcome | undefined {
        if (this.ports.cancelRequested()) {
            return { status: 'cancelled', value: this.toCurrentValue(true), nextStatus: 'cancelled' };
        }
        return this.deadlineEpochMs !== undefined && this.ports.now() >= this.deadlineEpochMs
            ? this.loopTimedOut(this.results, this.deadlineEpochMs, this.toCurrentMetrics())
            : undefined;
    }

    private async waitForNextIteration(): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        if (this.intervalMs <= 0) {
            return undefined;
        }
        const delay = this.deadlineEpochMs === undefined
            ? this.intervalMs
            : Math.max(0, Math.min(this.intervalMs, this.deadlineEpochMs - this.ports.now()));
        if (await this.sleepForLoopUntil(delay) === 'cancelled') {
            return { status: 'cancelled', value: this.toCurrentValue(true), nextStatus: 'cancelled' };
        }
        return this.toStoppedOutcome();
    }

    private async runUntilFirstSuccess(): Promise<RallarBlackBoxTestCommandOutcome> {
        return await runLoopUntilFirstSuccess({
            command: this.command,
            count: this.count,
            durationMs: this.durationMs,
            intervalMs: this.intervalMs,
            deadlineEpochMs: this.deadlineEpochMs,
            loopStartedAtEpochMs: this.loopStartedAtEpochMs,
            now: this.ports.now,
            sleep: (ms) => this.sleepForLoopUntil(ms),
            cancelRequested: this.ports.cancelRequested,
            runIteration: (iterationIndex, scheduledAtEpochMs) =>
                this.runLoopIteration({ iterationIndex, scheduledAtEpochMs, stopOnChildFailure: true }),
            toLoopValue: (cancelled, failures) => this.toCurrentValue(cancelled, failures),
            toTimedOutOutcome: () =>
                this.loopTimedOut(this.results, this.deadlineEpochMs ?? this.ports.now(), this.toCurrentMetrics()),
            toSuccessOutcome: () => this.toLoopCompletionOutcome(this.toCurrentValue(false))
        });
    }

    private async runIterationCommands(input: RunLoopIterationInput): Promise<LoopIterationCompletion> {
        for (let commandIndex = 0; commandIndex < this.command.commands.length; commandIndex++) {
            const stop = this.readIterationStop();
            if (stop) {
                return stop;
            }
            const entry = await this.runChild(input, commandIndex);
            this.results.push(entry);
            if (this.ports.cancelRequested() || entry.result.status === 'cancelled') {
                return { kind: 'cancelled' };
            }
            if (!entry.result.ok && (input.stopOnChildFailure || this.command.continueOnFailure !== true)) {
                return { kind: 'child-failed', entry };
            }
        }
        return { kind: 'completed' };
    }

    private readIterationStop(): LoopIterationCompletion | undefined {
        if (this.ports.cancelRequested()) {
            return { kind: 'cancelled' };
        }
        if (this.deadlineEpochMs !== undefined && this.ports.now() >= this.deadlineEpochMs) {
            return { kind: 'timed-out', deadlineEpochMs: this.deadlineEpochMs };
        }
        return this.results.length >= this.maxCommands ? { kind: 'limit' } : undefined;
    }

    private async runChild(
        input: RunLoopIterationInput,
        commandIndex: number
    ): Promise<RallarBlackBoxTestCompositeChildResult> {
        const template = this.command.commands[commandIndex];
        const context = {
            loopCommandId: this.command.commandId,
            index: this.results.length,
            iteration: input.iterationIndex + 1,
            elapsedMs: Math.max(0, this.ports.now() - this.loopStartedAtEpochMs),
            commandIndex
        };
        const command = this.toLoopChildCommand(template, context, this.deadlineEpochMs);
        const result = await this.ports.executeCommand(command, { bypassCache: true });
        return {
            commandId: result.commandId,
            originalCommandId: template.commandId,
            parentCommandId: this.command.commandId,
            path: rallarBlackBoxLoopChildResultPath(
                RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                input.iterationIndex + 1,
                commandIndex
            ),
            sourceRecipePath: rallarBlackBoxLoopChildSourceRecipePath(
                RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                commandIndex
            ),
            childIndex: this.results.length,
            commandIndex,
            iteration: input.iterationIndex + 1,
            result
        };
    }

    private recordIteration(
        input: RunLoopIterationInput,
        measurement: LoopIterationMeasurement,
        cancelled: boolean
    ): void {
        const results = this.results.slice(measurement.resultStartIndex);
        const endedAtEpochMs = this.ports.now();
        this.pacingIterations.push({
            iteration: input.iterationIndex + 1,
            scheduledAtEpochMs: input.scheduledAtEpochMs,
            startedAtEpochMs: measurement.startedAtEpochMs,
            endedAtEpochMs,
            durationMs: Math.max(0, endedAtEpochMs - measurement.startedAtEpochMs),
            startDriftMs: Math.max(0, measurement.startedAtEpochMs - input.scheduledAtEpochMs),
            commandCount: results.length,
            passed: results.filter((entry) => entry.result.ok).length,
            failed: results.filter((entry) => !entry.result.ok).length,
            cancelled
        });
    }

    private toIterationOutcome(completion: LoopIterationCompletion, stopOnChildFailure: boolean): LoopIterationOutcome {
        switch (completion.kind) {
            case 'completed':
                return { kind: 'completed' };
            case 'cancelled':
                return {
                    kind: 'outcome',
                    outcome: { status: 'cancelled', value: this.toCurrentValue(true), nextStatus: 'cancelled' }
                };
            case 'timed-out':
                return {
                    kind: 'outcome',
                    outcome: this.loopTimedOut(this.results, completion.deadlineEpochMs, this.toCurrentMetrics())
                };
            case 'limit':
                return {
                    kind: 'outcome',
                    outcome: this.loopLimitExceeded(this.results, {
                        plannedCommandCount: this.plannedCommandCount,
                        maxCommands: this.maxCommands
                    }, this.toCurrentMetrics())
                };
            case 'child-failed':
                return stopOnChildFailure ? { kind: 'completed', failedChildResult: completion.entry } : {
                    kind: 'outcome',
                    outcome: {
                        status: 'failed',
                        value: this.toCurrentValue(false),
                        nextStatus: 'failed',
                        error: {
                            code: 'RALLAR_BLACK_BOX_LOOP_CHILD_FAILED',
                            message: 'Loop failed at child command ' + completion.entry.result.commandId + '.',
                            details: completion.entry.result.error
                        }
                    }
                };
        }
    }
}
function loopPlaceholderValue(name: string, context: LoopContext): number {
    switch (name) {
        case 'index':
            return context.index;
        case 'iteration':
            return context.iteration;
        case 'elapsedMs':
            return context.elapsedMs;
        case 'commandIndex':
            return context.commandIndex;
        default:
            return 0;
    }
}
type LoopIterationCompletion =
    | { readonly kind: 'completed' | 'cancelled' | 'limit'; }
    | { readonly kind: 'timed-out'; readonly deadlineEpochMs: number; }
    | { readonly kind: 'child-failed'; readonly entry: RallarBlackBoxTestCompositeChildResult; };
interface LoopIterationMeasurement {
    readonly startedAtEpochMs: number;
    readonly resultStartIndex: number;
}
