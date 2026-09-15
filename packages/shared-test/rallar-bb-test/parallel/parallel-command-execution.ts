import { Either } from '@shared/resilience/Either.ts';
import {
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
    rallarBlackBoxParallelChildResultPath,
    rallarBlackBoxParallelChildSourceRecipePath
} from '../composite-results.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandOutcome,
    type RallarBlackBoxTestCompositeChildResult,
    type RallarBlackBoxTestParallelCommand,
    type RallarBlackBoxTestParallelGroup,
    type RallarBlackBoxTestParallelGroupResult,
    type RallarBlackBoxTestParallelResultValue,
    type RallarBlackBoxTestRecord,
    type RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger, decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    computeCommandDeadlineEpochMs,
    toBoundedDeadlineCommand,
    toCommandLabelForId
} from '../runtime/to-runtime-command-values.ts';

export namespace ParallelCommandExecution {
    export interface Ports {
        readonly now: () => number;
        readonly runChildCommand: (command: RallarBlackBoxTestCommand) => Promise<RallarBlackBoxTestResult>;
        readonly cancelRequested: () => boolean;
    }
    export interface Command extends RallarBlackBoxTestParallelCommand {
        readonly commandId: string;
    }
    export interface Run {
        readonly maxConcurrency: number;
        /** Absent when neither the command nor its parent sets a deadline. */
        readonly deadlineEpochMs?: number;
    }
    export interface ChildContext {
        readonly groupId: string;
        readonly groupIndex: number;
        readonly commandIndex: number;
    }
    export interface GroupExecution {
        readonly result: RallarBlackBoxTestParallelGroupResult;
        /** Absent when every child in the group passed. */
        readonly failedResult?: RallarBlackBoxTestResult;
        readonly cancelled: boolean;
        readonly timedOut: boolean;
    }
    export type SchedulingStop = 'cancelled' | 'timed-out' | 'first-failure';
}

/** Owns scheduling and collected evidence for one parallel command; child commands run through the runtime. */
export class ParallelCommandExecution {
    private readonly command: ParallelCommandExecution.Command;
    private readonly ports: ParallelCommandExecution.Ports;
    private readonly groupResults: (ParallelCommandExecution.GroupExecution | undefined)[] = [];
    private nextGroupIndex = 0;
    private firstFailedResult: RallarBlackBoxTestResult | undefined;
    private timedOut = false;

    constructor(command: ParallelCommandExecution.Command, ports: ParallelCommandExecution.Ports) {
        this.command = command;
        this.ports = ports;
    }

    async run(): Promise<RallarBlackBoxTestCommandOutcome> {
        return await resolveParallelConcurrency(this.command).fold(
            (invalid) => Promise.resolve(invalid),
            async (maxConcurrency) => {
                const run = {
                    maxConcurrency,
                    deadlineEpochMs: computeCommandDeadlineEpochMs(this.command, this.ports.now())
                };
                await Promise.all(Array.from({ length: maxConcurrency }, () => this.runWorker(run)));
                return this.toOutcome(run);
            }
        );
    }

    private async runWorker(run: ParallelCommandExecution.Run): Promise<void> {
        for (;;) {
            const stop = this.toSchedulingStop(run);
            if (stop !== undefined) {
                this.timedOut ||= stop === 'timed-out';
                return;
            }
            const groupIndex = this.nextGroupIndex++;
            if (groupIndex >= this.command.groups.length) {
                return;
            }
            const execution = await this.runGroup(run, groupIndex);
            this.groupResults[groupIndex] = execution;
            this.timedOut ||= execution.timedOut;
            this.firstFailedResult ??= execution.failedResult;
        }
    }

    private toSchedulingStop(run: ParallelCommandExecution.Run): ParallelCommandExecution.SchedulingStop | undefined {
        if (this.ports.cancelRequested()) {
            return 'cancelled';
        }
        if (run.deadlineEpochMs !== undefined && this.ports.now() >= run.deadlineEpochMs) {
            return 'timed-out';
        }
        const stopsOnFailure = this.command.failFast !== false && this.command.continueOnFailure !== true;
        return this.firstFailedResult !== undefined && stopsOnFailure ? 'first-failure' : undefined;
    }

    private async runGroup(
        run: ParallelCommandExecution.Run,
        groupIndex: number
    ): Promise<ParallelCommandExecution.GroupExecution> {
        const group = this.command.groups[groupIndex];
        const startedAtEpochMs = this.ports.now();
        const groupId = group.groupId ?? `group-${groupIndex + 1}`;
        const results: RallarBlackBoxTestCompositeChildResult[] = [];
        const stop = await this.runGroupCommands({ run, group, groupId, groupIndex, results });
        return {
            result: {
                groupId,
                commandCount: results.length,
                passed: results.filter((entry) => entry.result.ok).length,
                failed: results.filter((entry) => !entry.result.ok).length,
                cancelled: stop === 'cancelled',
                durationMs: Math.max(0, this.ports.now() - startedAtEpochMs),
                results
            },
            failedResult: results.findLast((entry) => !entry.result.ok)?.result,
            cancelled: stop === 'cancelled',
            timedOut: stop === 'timed-out'
        };
    }

    private async runGroupCommands(input: GroupCommandsInput): Promise<'cancelled' | 'timed-out' | undefined> {
        const { run, group, results } = input;
        for (let commandIndex = 0; commandIndex < group.commands.length; commandIndex++) {
            if (this.ports.cancelRequested()) {
                return 'cancelled';
            }
            if (run.deadlineEpochMs !== undefined && this.ports.now() >= run.deadlineEpochMs) {
                return 'timed-out';
            }
            const entry = await this.runChild(input, commandIndex);
            results.push(entry);
            if (this.ports.cancelRequested() || entry.result.status === 'cancelled') {
                return 'cancelled';
            }
            if (!entry.result.ok && this.command.continueOnFailure !== true) {
                return undefined;
            }
        }
        return undefined;
    }

    private async runChild(
        input: GroupCommandsInput,
        commandIndex: number
    ): Promise<RallarBlackBoxTestCompositeChildResult> {
        const { run, group } = input;
        const context = { groupId: input.groupId, groupIndex: input.groupIndex, commandIndex };
        const childIndex = input.results.length;
        const template = group.commands[commandIndex];
        const result = await this.ports.runChildCommand(this.toChildCommand({ run, template, group, context }));
        const root = RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH;
        return {
            commandId: result.commandId,
            originalCommandId: template.commandId,
            parentCommandId: this.command.commandId,
            path: rallarBlackBoxParallelChildResultPath(
                root,
                context.groupIndex,
                context.groupId,
                context.commandIndex
            ),
            sourceRecipePath: rallarBlackBoxParallelChildSourceRecipePath(
                root,
                context.groupIndex,
                context.commandIndex
            ),
            childIndex,
            ...context,
            result
        };
    }

    private toChildCommand(input: ChildCommandInput): RallarBlackBoxTestCommand {
        const { run, template, group, context } = input;
        const child = {
            ...template,
            commandId: [
                this.command.commandId,
                `g${context.groupIndex + 1}`,
                toGroupLabel(group, context.groupIndex + 1),
                `c${context.commandIndex + 1}`,
                toCommandLabelForId(template, context.commandIndex + 1)
            ].join(':'),
            metadata: {
                ...decodeRecord(template.metadata),
                parallel: {
                    commandId: this.command.commandId,
                    ...context,
                    originalCommandId: template.commandId
                }
            }
        };
        return run.deadlineEpochMs === undefined ? child : toBoundedDeadlineCommand(child, run.deadlineEpochMs);
    }

    private toOutcome(run: ParallelCommandExecution.Run): RallarBlackBoxTestCommandOutcome {
        const cancelled = this.ports.cancelRequested() ||
            this.groupResults.some((result) => result?.cancelled === true);
        const groups = this.command.groups.map((group, index) =>
            this.groupResults[index]?.result ?? {
                groupId: group.groupId ?? `group-${index + 1}`,
                commandCount: 0,
                passed: 0,
                failed: 0,
                cancelled: cancelled && index >= this.nextGroupIndex,
                durationMs: 0,
                results: []
            }
        );
        const value = toParallelResultValue(this.command, run.maxConcurrency, { groups, cancelled });
        if (cancelled) {
            return { status: 'cancelled', value, nextStatus: 'cancelled' };
        }
        if (this.timedOut) {
            return this.toTimeoutOutcome(value);
        }
        return value.failed > 0 && this.command.continueOnFailure !== true
            ? this.toChildFailureOutcome(value)
            : { status: 'ok', value, nextStatus: 'completed' };
    }

    private toTimeoutOutcome(value: RallarBlackBoxTestParallelResultValue): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value,
            nextStatus: 'failed',
            error: {
                code: 'RALLAR_BLACK_BOX_PARALLEL_TIMEOUT',
                message: 'Parallel command reached its timeout before all groups completed.',
                details: {
                    timeoutMs: this.command.timeoutMs,
                    deadlineEpochMs: this.command.deadlineEpochMs,
                    completedGroups: value.groups.filter((group) => group.commandCount > 0).length,
                    totalGroups: this.command.groups.length
                }
            }
        };
    }

    private toChildFailureOutcome(value: RallarBlackBoxTestParallelResultValue): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value,
            nextStatus: 'failed',
            error: {
                code: 'RALLAR_BLACK_BOX_PARALLEL_CHILD_FAILED',
                message: this.firstFailedResult
                    ? `Parallel failed at child command ${this.firstFailedResult.commandId}.`
                    : 'Parallel completed with failed child commands.',
                details: {
                    firstFailure: this.firstFailedResult?.error,
                    failedGroups: value.groups.filter((group) => group.failed > 0).map((group) => group.groupId)
                }
            }
        };
    }
}

interface GroupCommandsInput {
    readonly run: ParallelCommandExecution.Run;
    readonly group: RallarBlackBoxTestParallelGroup;
    readonly groupId: string;
    readonly groupIndex: number;
    readonly results: RallarBlackBoxTestCompositeChildResult[];
}

interface ChildCommandInput {
    readonly run: ParallelCommandExecution.Run;
    readonly template: RallarBlackBoxTestCommand;
    readonly group: RallarBlackBoxTestParallelGroup;
    readonly context: ParallelCommandExecution.ChildContext;
}

interface ParallelGroupsSummary {
    readonly groups: readonly RallarBlackBoxTestParallelGroupResult[];
    readonly cancelled: boolean;
}

function resolveParallelConcurrency(
    command: ParallelCommandExecution.Command
): Either<RallarBlackBoxTestCommandOutcome, number> {
    const groups = command.groups;
    if (!Array.isArray(groups) || groups.length === 0) {
        return toInvalidOutcome(command, 'Parallel requires at least one group.', undefined);
    }
    const groupIndex = groups.findIndex((group) => !Array.isArray(group.commands) || group.commands.length === 0);
    if (groupIndex >= 0) {
        return toInvalidOutcome(command, 'Parallel groups require at least one child command.', {
            groupIndex,
            groupId: groups[groupIndex]?.groupId
        });
    }
    const maximum = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency;
    const requested = command.maxConcurrency === undefined
        ? Math.min(groups.length, maximum)
        : decodePositiveInteger(command.maxConcurrency);
    if (requested === undefined) {
        return toInvalidOutcome(command, 'Parallel maxConcurrency must be a positive integer.', {
            maxConcurrency: command.maxConcurrency
        });
    }
    return requested > maximum
        ? toInvalidOutcome(command, 'Parallel maxConcurrency exceeds the runtime maximum.', {
            maxConcurrency: requested,
            maxParallelConcurrency: maximum
        })
        : Either.ofRight(Math.max(1, Math.min(requested, groups.length)));
}

function toInvalidOutcome(
    command: ParallelCommandExecution.Command,
    message: string,
    details: RallarBlackBoxTestRecord | undefined
): Either<RallarBlackBoxTestCommandOutcome, number> {
    return Either.ofLeft({
        status: 'failed',
        value: toParallelResultValue(command, 0, { groups: [], cancelled: false }),
        nextStatus: 'failed',
        error: { code: 'RALLAR_BLACK_BOX_PARALLEL_INVALID', message, details }
    });
}

function toParallelResultValue(
    command: ParallelCommandExecution.Command,
    maxConcurrency: number,
    summary: ParallelGroupsSummary
): RallarBlackBoxTestParallelResultValue {
    return {
        commandId: command.commandId,
        groupCount: summary.groups.length,
        maxConcurrency,
        passed: summary.groups.reduce((sum, group) => sum + group.passed, 0),
        failed: summary.groups.reduce((sum, group) => sum + group.failed, 0),
        cancelled: summary.cancelled,
        groups: summary.groups
    };
}

function toGroupLabel(group: RallarBlackBoxTestParallelGroup, fallbackIndex: number): string {
    return (group.groupId ?? `group-${fallbackIndex}`).replace(/[^a-zA-Z0-9_.:-]/g, '-');
}
