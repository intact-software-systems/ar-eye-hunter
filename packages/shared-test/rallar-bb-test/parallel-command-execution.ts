import {
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
    rallarBlackBoxParallelChildResultPath,
    rallarBlackBoxParallelChildSourceRecipePath
} from './composite-results.ts';
import {
    computeCommandDeadlineEpochMs,
    toBoundedDeadlineCommand,
    toCommandLabelForId,
    toPositiveInteger,
    toRecord
} from './to-runtime-command-values.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandOutcome,
    type RallarBlackBoxTestCompositeChildResult,
    type RallarBlackBoxTestParallelCommand,
    type RallarBlackBoxTestParallelGroup,
    type RallarBlackBoxTestParallelGroupResult,
    type RallarBlackBoxTestParallelResultValue,
    type RallarBlackBoxTestResult
} from './rallar-black-box-test-contracts.ts';

export namespace ParallelCommandExecution {
    export interface Ports {
        readonly now: () => number;
        readonly executeCommand: (
            command: RallarBlackBoxTestCommand,
            options: { readonly bypassCache: boolean; }
        ) => Promise<RallarBlackBoxTestResult>;
        readonly cancelRequested: () => boolean;
    }
    export interface Command extends RallarBlackBoxTestParallelCommand {
        readonly commandId: string;
    }
    export interface ChildContext {
        readonly groupId: string;
        readonly groupIndex: number;
        readonly commandIndex: number;
    }
    export interface GroupExecution {
        readonly result: RallarBlackBoxTestParallelGroupResult;
        readonly failedResult?: RallarBlackBoxTestResult;
        readonly cancelled: boolean;
        readonly timedOut: boolean;
    }
}

/** Owns scheduling and results for one parallel command; child execution remains in the runtime. */
export class ParallelCommandExecution {
    private readonly command: ParallelCommandExecution.Command;
    private readonly ports: ParallelCommandExecution.Ports;
    private readonly groupResults: (ParallelCommandExecution.GroupExecution | undefined)[] = [];
    private nextGroupIndex = 0;
    private maxConcurrency = 0;
    private deadlineEpochMs: number | undefined;
    private firstFailedResult: RallarBlackBoxTestResult | undefined;
    private timedOut = false;

    constructor(command: ParallelCommandExecution.Command, ports: ParallelCommandExecution.Ports) {
        this.command = command;
        this.ports = ports;
    }

    async run(): Promise<RallarBlackBoxTestCommandOutcome> {
        const invalid = this.validateGroups() ?? this.validateConcurrency();
        if (invalid) {
            return invalid;
        }
        this.deadlineEpochMs = computeCommandDeadlineEpochMs(this.command, this.ports.now());
        await Promise.all(Array.from({ length: this.maxConcurrency }, () => this.runWorker()));
        return this.toOutcome();
    }

    private validateGroups(): RallarBlackBoxTestCommandOutcome | undefined {
        const groups = this.command.groups;
        if (!Array.isArray(groups) || groups.length === 0) {
            return this.toInvalidOutcome('Parallel requires at least one group.');
        }
        const groupIndex = groups.findIndex((group) => !Array.isArray(group.commands) || group.commands.length === 0);
        return groupIndex < 0
            ? undefined
            : this.toInvalidOutcome('Parallel groups require at least one child command.', {
                groupIndex,
                groupId: groups[groupIndex]?.groupId
            });
    }

    private validateConcurrency(): RallarBlackBoxTestCommandOutcome | undefined {
        const command = this.command;
        const maximum = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency;
        const requested = command.maxConcurrency === undefined
            ? Math.min(command.groups.length, maximum)
            : toPositiveInteger(command.maxConcurrency);
        if (requested === undefined) {
            return this.toInvalidOutcome('Parallel maxConcurrency must be a positive integer.', {
                maxConcurrency: command.maxConcurrency
            });
        }
        if (requested > maximum) {
            return this.toInvalidOutcome('Parallel maxConcurrency exceeds the runtime maximum.', {
                maxConcurrency: requested,
                maxParallelConcurrency: maximum
            });
        }
        this.maxConcurrency = Math.max(1, Math.min(requested, command.groups.length));
        return undefined;
    }

    private shouldStopScheduling(): boolean {
        if (this.ports.cancelRequested()) {
            return true;
        }
        if (this.deadlineEpochMs !== undefined && this.ports.now() >= this.deadlineEpochMs) {
            this.timedOut = true;
            return true;
        }
        return this.firstFailedResult !== undefined && this.command.failFast !== false &&
            this.command.continueOnFailure !== true;
    }

    private async runWorker(): Promise<void> {
        while (!this.shouldStopScheduling()) {
            const groupIndex = this.nextGroupIndex++;
            if (groupIndex >= this.command.groups.length) {
                return;
            }
            const execution = await this.runGroup(this.command.groups[groupIndex], groupIndex);
            this.groupResults[groupIndex] = execution;
            if (execution.timedOut) {
                this.timedOut = true;
            }
            this.firstFailedResult ??= execution.failedResult;
        }
    }

    private async runGroup(
        group: RallarBlackBoxTestParallelGroup,
        groupIndex: number
    ): Promise<ParallelCommandExecution.GroupExecution> {
        const startedAtEpochMs = this.ports.now();
        const groupId = group.groupId ?? `group-${groupIndex + 1}`;
        const results: RallarBlackBoxTestCompositeChildResult[] = [];
        let failedResult: RallarBlackBoxTestResult | undefined;
        let cancelled = false;
        let timedOut = false;
        for (let commandIndex = 0; commandIndex < group.commands.length; commandIndex++) {
            if (this.ports.cancelRequested()) {
                cancelled = true;
                break;
            }
            if (this.deadlineEpochMs !== undefined && this.ports.now() >= this.deadlineEpochMs) {
                timedOut = true;
                break;
            }
            const entry = await this.runChild(group, { groupId, groupIndex, commandIndex }, results.length);
            results.push(entry);
            if (this.ports.cancelRequested() || entry.result.status === 'cancelled') {
                cancelled = true;
                break;
            }
            if (!entry.result.ok) {
                failedResult = entry.result;
                if (this.command.continueOnFailure !== true) {
                    break;
                }
            }
        }
        return {
            result: {
                groupId,
                commandCount: results.length,
                passed: results.filter((entry) => entry.result.ok).length,
                failed: results.filter((entry) => !entry.result.ok).length,
                cancelled,
                durationMs: Math.max(0, this.ports.now() - startedAtEpochMs),
                results
            },
            failedResult,
            cancelled,
            timedOut
        };
    }

    private async runChild(
        group: RallarBlackBoxTestParallelGroup,
        context: ParallelCommandExecution.ChildContext,
        childIndex: number
    ): Promise<RallarBlackBoxTestCompositeChildResult> {
        const template = group.commands[context.commandIndex];
        const result = await this.ports.executeCommand(this.toChildCommand(template, group, context), {
            bypassCache: true
        });
        return {
            commandId: result.commandId,
            originalCommandId: template.commandId,
            parentCommandId: this.command.commandId,
            path: rallarBlackBoxParallelChildResultPath(
                RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                context.groupIndex,
                context.groupId,
                context.commandIndex
            ),
            sourceRecipePath: rallarBlackBoxParallelChildSourceRecipePath(
                RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                context.groupIndex,
                context.commandIndex
            ),
            childIndex,
            ...context,
            result
        };
    }

    private toChildCommand(
        template: RallarBlackBoxTestCommand,
        group: RallarBlackBoxTestParallelGroup,
        context: ParallelCommandExecution.ChildContext
    ): RallarBlackBoxTestCommand {
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
                ...toRecord(template.metadata),
                parallel: {
                    commandId: this.command.commandId,
                    ...context,
                    originalCommandId: template.commandId
                }
            }
        };
        return this.deadlineEpochMs === undefined ? child : toBoundedDeadlineCommand(child, this.deadlineEpochMs);
    }

    private toOutcome(): RallarBlackBoxTestCommandOutcome {
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
        const value = this.toResultValue(groups, cancelled);
        if (cancelled) {
            return { status: 'cancelled', value, nextStatus: 'cancelled' };
        }
        if (this.timedOut) {
            return this.toTimeoutOutcome(value);
        }
        if (value.failed > 0 && this.command.continueOnFailure !== true) {
            return this.toChildFailureOutcome(value);
        }
        return { status: 'ok', value, nextStatus: 'completed' };
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

    private toResultValue(
        groups: readonly RallarBlackBoxTestParallelGroupResult[],
        cancelled: boolean
    ): RallarBlackBoxTestParallelResultValue {
        return {
            commandId: this.command.commandId,
            groupCount: groups.length,
            maxConcurrency: this.maxConcurrency,
            passed: groups.reduce((sum, group) => sum + group.passed, 0),
            failed: groups.reduce((sum, group) => sum + group.failed, 0),
            cancelled,
            groups
        };
    }

    private toInvalidOutcome(message: string, details?: unknown): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value: this.toResultValue([], false),
            nextStatus: 'failed',
            error: { code: 'RALLAR_BLACK_BOX_PARALLEL_INVALID', message, details }
        };
    }
}

function toGroupLabel(group: RallarBlackBoxTestParallelGroup, fallbackIndex: number): string {
    return (group.groupId ?? `group-${fallbackIndex}`).replace(/[^a-zA-Z0-9_.:-]/g, '-');
}
