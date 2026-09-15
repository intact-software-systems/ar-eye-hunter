import {
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
    rallarBlackBoxLoopChildResultPath,
    rallarBlackBoxLoopChildSourceRecipePath
} from '../composite-results.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestCompositeChildResult,
    RallarBlackBoxTestLoopPacingIteration,
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestLoopThresholdFailure,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { isAbortError } from '../runtime/sleep-with-abort.ts';
import { computeCommandDeadlineEpochMs } from '../runtime/to-runtime-command-values.ts';
import { computeLoopThresholdFailures } from './loop-command-thresholds.ts';
import { runLoopUntilFirstSuccess, type LoopCommandWithId, type LoopIterationOutcome } from './loop-until.ts';
import { resolveLoopPlan, type LoopPlan } from './resolve-loop-plan.ts';
import { toLoopChildCommand } from './to-loop-child-command.ts';
import {
    toLoopCancelledOutcome,
    toLoopChildFailedOutcome,
    toLoopCompletionOutcome,
    toLoopLimitExceededOutcome,
    toLoopTimedOutOutcome,
    type LoopOutcomeEvidence
} from './to-loop-outcome.ts';
import { toLoopResultValue } from './to-loop-result-value.ts';

export namespace LoopCommandExecution {
    export interface Ports {
        readonly now: () => number;
        readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
        readonly runChildCommand: (command: RallarBlackBoxTestCommand) => Promise<RallarBlackBoxTestResult>;
        readonly cancelRequested: () => boolean;
        readonly abortSignal: () => AbortSignal;
    }

    export interface Run {
        readonly plan: LoopPlan;
        readonly startedAtEpochMs: number;
        /** Absent when neither the loop nor its parent sets a deadline. */
        readonly deadlineEpochMs?: number;
    }

    export interface IterationInput {
        readonly run: Run;
        readonly iterationIndex: number;
        readonly scheduledAtEpochMs: number;
        readonly stopOnChildFailure: boolean;
    }

    export type IterationCompletion =
        | Readonly<{ kind: 'completed' | 'cancelled' | 'limit'; }>
        | Readonly<{ kind: 'timed-out'; deadlineEpochMs: number; }>
        | Readonly<{ kind: 'child-failed'; entry: RallarBlackBoxTestCompositeChildResult; }>;
}

/** Owns scheduling and collected evidence for one loop command; child commands run through the runtime. */
export class LoopCommandExecution {
    private readonly command: LoopCommandWithId;
    private readonly ports: LoopCommandExecution.Ports;
    private readonly results: RallarBlackBoxTestCompositeChildResult[] = [];
    private readonly pacingIterations: RallarBlackBoxTestLoopPacingIteration[] = [];

    constructor(command: LoopCommandWithId, ports: LoopCommandExecution.Ports) {
        this.command = command;
        this.ports = ports;
    }

    async run(): Promise<RallarBlackBoxTestCommandOutcome> {
        return await resolveLoopPlan(this.command).fold(
            (invalid) => Promise.resolve(invalid),
            (plan) => {
                const run = {
                    plan,
                    startedAtEpochMs: this.ports.now(),
                    deadlineEpochMs: computeCommandDeadlineEpochMs(this.command, this.ports.now())
                };
                return this.command.until === 'first-success'
                    ? this.runUntilFirstSuccess(run)
                    : this.runIterations(run);
            }
        );
    }

    private async runIterations(run: LoopCommandExecution.Run): Promise<RallarBlackBoxTestCommandOutcome> {
        for (let iterationIndex = 0; iterationIndex < run.plan.count; iterationIndex++) {
            const stopped = this.toStoppedOutcome(run);
            if (stopped) {
                return stopped;
            }
            if (iterationIndex > 0 && this.isDurationExpired(run)) {
                break;
            }
            const scheduledAtEpochMs = run.startedAtEpochMs + iterationIndex * run.plan.intervalMs;
            const iteration = await this.runIteration({
                run,
                iterationIndex,
                scheduledAtEpochMs,
                stopOnChildFailure: false
            });
            if (iteration.kind === 'outcome') {
                return iteration.outcome;
            }
            if (iterationIndex + 1 >= run.plan.count || this.isDurationExpired(run)) {
                break;
            }
            const delayOutcome = await this.waitForNextIteration(run);
            if (delayOutcome) {
                return delayOutcome;
            }
        }
        return this.toCompletionOutcome(run);
    }

    private async runUntilFirstSuccess(run: LoopCommandExecution.Run): Promise<RallarBlackBoxTestCommandOutcome> {
        return await runLoopUntilFirstSuccess({
            command: this.command,
            count: run.plan.count,
            durationMs: run.plan.durationMs,
            intervalMs: run.plan.intervalMs,
            deadlineEpochMs: run.deadlineEpochMs,
            loopStartedAtEpochMs: run.startedAtEpochMs,
            now: this.ports.now,
            sleep: (ms) => this.sleepUntilNextIteration(ms),
            cancelRequested: this.ports.cancelRequested,
            runIteration: (iterationIndex, scheduledAtEpochMs) =>
                this.runIteration({ run, iterationIndex, scheduledAtEpochMs, stopOnChildFailure: true }),
            toLoopValue: (cancelled, thresholdFailures) => this.toValue(run, cancelled, thresholdFailures),
            toTimedOutOutcome: () => this.toTimedOutOutcome(run, run.deadlineEpochMs ?? this.ports.now()),
            toSuccessOutcome: () => this.toCompletionOutcome(run)
        });
    }

    private async runIteration(input: LoopCommandExecution.IterationInput): Promise<LoopIterationOutcome> {
        const startedAtEpochMs = this.ports.now();
        const resultStartIndex = this.results.length;
        const completion = await this.runIterationCommands(input);
        const results = this.results.slice(resultStartIndex);
        const endedAtEpochMs = this.ports.now();
        this.pacingIterations.push({
            iteration: input.iterationIndex + 1,
            scheduledAtEpochMs: input.scheduledAtEpochMs,
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: Math.max(0, endedAtEpochMs - startedAtEpochMs),
            startDriftMs: Math.max(0, startedAtEpochMs - input.scheduledAtEpochMs),
            commandCount: results.length,
            passed: results.filter((entry) => entry.result.ok).length,
            failed: results.filter((entry) => !entry.result.ok).length,
            cancelled: completion.kind === 'cancelled'
        });
        return this.toIterationOutcome(input, completion);
    }

    private async runIterationCommands(
        input: LoopCommandExecution.IterationInput
    ): Promise<LoopCommandExecution.IterationCompletion> {
        for (let commandIndex = 0; commandIndex < this.command.commands.length; commandIndex++) {
            const stop = this.toIterationStop(input.run);
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

    private async runChild(
        input: LoopCommandExecution.IterationInput,
        commandIndex: number
    ): Promise<RallarBlackBoxTestCompositeChildResult> {
        const template = this.command.commands[commandIndex];
        const iteration = input.iterationIndex + 1;
        const context = {
            loopCommandId: this.command.commandId,
            index: this.results.length,
            iteration,
            elapsedMs: Math.max(0, this.ports.now() - input.run.startedAtEpochMs),
            commandIndex
        };
        const command = toLoopChildCommand({ template, context, deadlineEpochMs: input.run.deadlineEpochMs });
        const result = await this.ports.runChildCommand(command);
        return {
            commandId: result.commandId,
            originalCommandId: template.commandId,
            parentCommandId: this.command.commandId,
            path: rallarBlackBoxLoopChildResultPath(
                RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                iteration,
                commandIndex
            ),
            sourceRecipePath: rallarBlackBoxLoopChildSourceRecipePath(
                RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                commandIndex
            ),
            childIndex: this.results.length,
            commandIndex,
            iteration,
            result
        };
    }

    private async sleepUntilNextIteration(ms: number): Promise<'slept' | 'cancelled'> {
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

    private async waitForNextIteration(
        run: LoopCommandExecution.Run
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const intervalMs = run.plan.intervalMs;
        if (intervalMs <= 0) {
            return undefined;
        }
        const delayMs = run.deadlineEpochMs === undefined
            ? intervalMs
            : Math.max(0, Math.min(intervalMs, run.deadlineEpochMs - this.ports.now()));
        if (await this.sleepUntilNextIteration(delayMs) === 'cancelled') {
            return toLoopCancelledOutcome(this.toValue(run, true));
        }
        return this.toStoppedOutcome(run);
    }

    private isDurationExpired(run: LoopCommandExecution.Run): boolean {
        return run.plan.durationMs !== undefined &&
            Math.max(0, this.ports.now() - run.startedAtEpochMs) >= run.plan.durationMs;
    }

    private toIterationStop(run: LoopCommandExecution.Run): LoopCommandExecution.IterationCompletion | undefined {
        if (this.ports.cancelRequested()) {
            return { kind: 'cancelled' };
        }
        if (run.deadlineEpochMs !== undefined && this.ports.now() >= run.deadlineEpochMs) {
            return { kind: 'timed-out', deadlineEpochMs: run.deadlineEpochMs };
        }
        return this.results.length >= run.plan.maxCommands ? { kind: 'limit' } : undefined;
    }

    private toStoppedOutcome(run: LoopCommandExecution.Run): RallarBlackBoxTestCommandOutcome | undefined {
        if (this.ports.cancelRequested()) {
            return toLoopCancelledOutcome(this.toValue(run, true));
        }
        return run.deadlineEpochMs !== undefined && this.ports.now() >= run.deadlineEpochMs
            ? this.toTimedOutOutcome(run, run.deadlineEpochMs)
            : undefined;
    }

    private toIterationOutcome(
        input: LoopCommandExecution.IterationInput,
        completion: LoopCommandExecution.IterationCompletion
    ): LoopIterationOutcome {
        const run = input.run;
        switch (completion.kind) {
            case 'completed':
                return { kind: 'completed' };
            case 'cancelled':
                return { kind: 'outcome', outcome: toLoopCancelledOutcome(this.toValue(run, true)) };
            case 'timed-out':
                return { kind: 'outcome', outcome: this.toTimedOutOutcome(run, completion.deadlineEpochMs) };
            case 'limit':
                return {
                    kind: 'outcome',
                    outcome: toLoopLimitExceededOutcome(this.toEvidence(run), {
                        plannedCommandCount: run.plan.plannedCommandCount,
                        maxCommands: run.plan.maxCommands
                    })
                };
            case 'child-failed':
                return input.stopOnChildFailure
                    ? { kind: 'completed', failedChildResult: completion.entry }
                    : {
                        kind: 'outcome',
                        outcome: toLoopChildFailedOutcome(this.toValue(run, false), completion.entry)
                    };
        }
    }

    private toCompletionOutcome(run: LoopCommandExecution.Run): RallarBlackBoxTestCommandOutcome {
        const value = this.toValue(run, false);
        const thresholdFailures = computeLoopThresholdFailures(run.plan.thresholds, value);
        return toLoopCompletionOutcome(thresholdFailures.length > 0 ? { ...value, thresholdFailures } : value);
    }

    private toTimedOutOutcome(
        run: LoopCommandExecution.Run,
        deadlineEpochMs: number
    ): RallarBlackBoxTestCommandOutcome {
        return toLoopTimedOutOutcome({ ...this.toEvidence(run), timeoutMs: this.command.timeoutMs, deadlineEpochMs });
    }

    private toValue(
        run: LoopCommandExecution.Run,
        cancelled: boolean,
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[]
    ): RallarBlackBoxTestLoopResultValue {
        return toLoopResultValue({ ...this.toEvidence(run, thresholdFailures), cancelled });
    }

    private toEvidence(
        run: LoopCommandExecution.Run,
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[]
    ): LoopOutcomeEvidence {
        return {
            commandId: this.command.commandId,
            results: this.results,
            metrics: {
                intervalMs: run.plan.intervalMs,
                count: run.plan.count,
                durationMs: run.plan.durationMs,
                startedAtEpochMs: run.startedAtEpochMs,
                endedAtEpochMs: this.ports.now(),
                pacingIterations: this.pacingIterations,
                thresholdFailures
            }
        };
    }
}
