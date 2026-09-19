import { computeAssertCommandOutcome } from '../assert/compute-assert-command-outcome.ts';
import { toRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import { LoopCommandExecution } from '../loop/loop-command-execution.ts';
import { ParallelCommandExecution } from '../parallel/parallel-command-execution.ts';
import type {
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandExecutor,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestError,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeCleanup,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStateListener,
    RallarBlackBoxTestStatsSnapshot
} from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_RECIPE_TIMEOUT, runRecipeCommands } from '../recipe/run-recipe-commands.ts';
import { validateExecutableRecipe } from '../recipe/validate-executable-recipe.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import { waitForEvent } from '../wait/wait-for-event.ts';
import { isAbortError, sleepWithAbort } from './sleep-with-abort.ts';
import { toMergedRuntimeConfig } from './to-merged-runtime-config.ts';
import { computeCommandDeadlineEpochMs } from './to-runtime-command-values.ts';
import { toRuntimeStats } from './to-runtime-stats.ts';

export interface CreateRallarBlackBoxTestRuntimeOptions {
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly idFactory?: (prefix: string) => string;
    readonly commandExecutor?: RallarBlackBoxTestCommandExecutor;
    readonly cleanup?: RallarBlackBoxTestRuntimeCleanup;
}

type CommandWithId = RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>;

type CommandOfKind<Kind extends RallarBlackBoxTestCommand['kind']> = Extract<CommandWithId, Readonly<{ kind: Kind; }>>;

/** A child of a recipe, loop or parallel command always runs; only a top-level command replays its cached result. */
type ResultCachePolicy = 'replay' | 'bypass';

namespace InMemoryRallarBlackBoxTestRuntime {
    export interface Dependencies {
        readonly now: () => number;
        readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
        readonly idFactory: (prefix: string) => string;
        readonly commandExecutor: RallarBlackBoxTestCommandExecutor | undefined;
        readonly cleanup: RallarBlackBoxTestRuntimeCleanup | undefined;
    }
}

class InMemoryRallarBlackBoxTestRuntime implements RallarBlackBoxTestRuntime {
    private readonly dependencies: InMemoryRallarBlackBoxTestRuntime.Dependencies;
    private readonly listeners = new Set<RallarBlackBoxTestStateListener>();
    private currentState: RallarBlackBoxTestState = createInitialRuntimeState();
    private currentConfig: RallarBlackBoxTestConfig | undefined;
    private loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    private activeExecutionCount = 0;
    private cancellationController = new AbortController();
    private recipeExecutionDepth = 0;

    constructor(dependencies: InMemoryRallarBlackBoxTestRuntime.Dependencies) {
        this.dependencies = dependencies;
    }

    state(): RallarBlackBoxTestState {
        return this.currentState;
    }

    subscribe(listener: RallarBlackBoxTestStateListener): () => void {
        this.listeners.add(listener);
        listener(this.currentState);
        return () => {
            this.listeners.delete(listener);
        };
    }

    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void {
        this.appendEvent(event);
    }

    async execute(command: RallarBlackBoxTestCommand): Promise<RallarBlackBoxTestResult> {
        return await this.runCommand(command, 'replay');
    }

    private async runCommand(
        command: RallarBlackBoxTestCommand,
        cachePolicy: ResultCachePolicy
    ): Promise<RallarBlackBoxTestResult> {
        const commandWithId = this.toCommandWithId(command);
        const cached = this.currentState.resultCache[commandWithId.commandId];
        if (cached && cachePolicy === 'replay') {
            return { ...cached, replayed: true };
        }

        if (commandWithId.kind !== 'recipe.cancel') {
            this.clearAbortedCancellation();
        }
        this.activeExecutionCount += 1;
        try {
            return await this.runUncachedCommand(commandWithId);
        }
        finally {
            this.activeExecutionCount -= 1;
        }
    }

    private async runUncachedCommand(commandWithId: CommandWithId): Promise<RallarBlackBoxTestResult> {
        const startedAtEpochMs = this.dependencies.now();
        this.setState({
            activeCommand: this.toRedacted(commandWithId),
            activeCommandStartedAtEpochMs: startedAtEpochMs,
            status: commandWithId.kind === 'recipe.cancel' ? this.currentState.status : 'running'
        });
        const outcome = await this.runCommandOutcome(commandWithId).catch(decodeThrownCommandOutcome);
        const result = this.toResult(commandWithId, startedAtEpochMs, outcome);
        this.commitResult(result, outcome);
        return result;
    }

    private async runCommandOutcome(command: CommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        switch (command.kind) {
            case 'configure':
                return this.configure(command.config);
            case 'recipe.load':
                return this.loadRecipe(command.recipe);
            case 'recipe.run':
                return await this.runRecipe(command);
            case 'recipe.cancel':
                return await this.cancelRecipe(command);
            case 'stats':
                return {
                    status: 'ok',
                    value: this.updateStats(command.commandId),
                    nextStatus: this.currentState.status
                };
            case 'reset':
                return await this.reset(command);
            default:
                return await this.runExternalCommand(command);
        }
    }

    private configure(config: RallarBlackBoxTestConfig): RallarBlackBoxTestCommandOutcome {
        this.currentConfig = toMergedRuntimeConfig(this.currentConfig, config);
        const redactedConfig = this.toRedacted(this.currentConfig);
        this.setState({ currentConfig: redactedConfig });
        this.appendEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.configured',
            severity: 'info',
            payload: redactedConfig
        });
        return { status: 'ok', value: { config: redactedConfig }, nextStatus: 'configured' };
    }

    private loadRecipe(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommandOutcome {
        const issues = validateExecutableRecipe(recipe);
        if (issues.length > 0) {
            return toInvalidRecipeOutcome(issues);
        }
        this.loadedRecipe = recipe;
        this.setState({ loadedRecipe: this.toRedacted(recipe) });
        const summary = { recipeId: recipe.recipeId, commandCount: recipe.commands.length };
        this.appendEvent({ kind: 'diagnostic', topic: 'rallar.bb.recipe.loaded', severity: 'info', payload: summary });
        return { status: 'ok', value: summary, nextStatus: 'loaded' };
    }

    private async runRecipe(command: CommandOfKind<'recipe.run'>): Promise<RallarBlackBoxTestCommandOutcome> {
        const recipe = command.recipe ?? this.loadedRecipe;
        const issues = recipe === undefined ? ['No recipe is loaded.'] : validateExecutableRecipe(recipe);
        if (recipe === undefined || issues.length > 0) {
            return toInvalidRecipeOutcome(issues);
        }
        const deadlineEpochMs = computeCommandDeadlineEpochMs(command, this.dependencies.now());
        this.recipeExecutionDepth += 1;
        try {
            const outcome = await runRecipeCommands({
                recipe,
                timeoutMs: command.timeoutMs,
                deadlineEpochMs,
                ports: this.toCompositePorts()
            });
            if (outcome.status !== 'ok') {
                await this.cleanupOwnedResources({
                    reason: toTerminalCleanupReason(outcome),
                    commandId: command.commandId,
                    recipeId: recipe.recipeId,
                    status: outcome.status,
                    error: outcome.error
                });
            }
            return outcome;
        }
        finally {
            this.recipeExecutionDepth -= 1;
        }
    }

    private async cancelRecipe(command: CommandOfKind<'recipe.cancel'>): Promise<RallarBlackBoxTestCommandOutcome> {
        if (!this.cancellationController.signal.aborted) {
            this.cancellationController.abort(command.reason ?? 'Rallar black-box recipe cancellation requested.');
        }
        this.appendEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.recipe.cancel_requested',
            commandId: command.commandId,
            severity: 'warning',
            payload: { reason: command.reason }
        });
        if (this.recipeExecutionDepth === 0) {
            await this.cleanupOwnedResources({
                reason: 'cancelled',
                commandId: command.commandId,
                status: 'cancelled'
            });
        }
        return {
            status: 'ok',
            value: { cancelRequested: true, reason: command.reason },
            nextStatus: this.currentState.status === 'running' ? 'cancelled' : this.currentState.status
        };
    }

    private async reset(command: CommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        const outcome = await this.dependencies.commandExecutor?.(command, this.toCommandContext());
        this.currentState = createInitialRuntimeState();
        this.currentConfig = undefined;
        this.loadedRecipe = undefined;
        this.notify();
        return outcome
            ? { ...outcome, nextStatus: 'idle' }
            : { status: 'ok', value: { reset: true }, nextStatus: 'idle' };
    }

    private async runExternalCommand(command: CommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        const outcome = await this.dependencies.commandExecutor?.(command, this.toCommandContext());
        if (outcome) {
            return outcome;
        }
        switch (command.kind) {
            case 'loop':
                return await new LoopCommandExecution(command, this.toCompositePorts()).run();
            case 'parallel':
                return await new ParallelCommandExecution(command, this.toCompositePorts()).run();
            case 'wait':
                return await waitForEvent({
                    command,
                    now: this.dependencies.now,
                    sleep: this.dependencies.sleep,
                    cancellationSignal: this.cancellationController.signal,
                    cancelRequested: () => this.cancellationController.signal.aborted,
                    currentStatus: () => this.currentState.status,
                    currentEvents: () => this.currentState.events,
                    subscribe: (listener) => this.subscribe(() => listener())
                });
            case 'assert':
                return computeAssertCommandOutcome({ command, state: this.currentState, config: this.currentConfig });
            case 'health':
                return {
                    status: 'ok',
                    value: toRuntimeHealth(this.currentState),
                    nextStatus: this.currentState.status
                };
            case 'close':
                this.appendEvent({
                    kind: 'event',
                    topic: 'rallar.bb.closed',
                    commandId: command.commandId,
                    severity: 'info'
                });
                return { status: 'ok', value: { closed: true }, nextStatus: 'idle' };
            default:
                return this.recordSimulatedCommand(command);
        }
    }

    private recordSimulatedCommand(command: CommandWithId): RallarBlackBoxTestCommandOutcome {
        const topic = `rallar.bb.fake.${command.kind}`;
        this.appendEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            severity: 'info',
            payload: toRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity: 'info',
                commandId: command.commandId,
                source: 'simulated-runtime',
                payload: { command: this.toRedacted(command) }
            })
        });
        return {
            status: 'ok',
            value: { fake: true, kind: command.kind, commandId: command.commandId },
            nextStatus: this.currentState.status
        };
    }

    private async cleanupOwnedResources(input: RallarBlackBoxTestCleanupInput): Promise<void> {
        const cleanup = this.dependencies.cleanup;
        if (!cleanup) {
            return;
        }
        try {
            await cleanup(input, this.toCommandContext());
            this.appendEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.completed',
                commandId: input.commandId,
                severity: 'info',
                payload: input
            });
        }
        catch (error) {
            this.appendEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.failed',
                commandId: input.commandId,
                severity: 'error',
                payload: { input, error: decodeRuntimeTestError(error, 'RALLAR_BLACK_BOX_CLEANUP_FAILED') }
            });
        }
    }

    private toCommandContext(): RallarBlackBoxTestCommandContext {
        return {
            state: () => this.currentState,
            config: () => this.currentConfig,
            abortSignal: () => this.cancellationController.signal,
            recordEvent: (event) => this.appendEvent(event),
            updateStats: (commandId) => this.updateStats(commandId)
        };
    }

    private toCompositePorts(): LoopCommandExecution.Ports {
        return {
            now: this.dependencies.now,
            sleep: this.dependencies.sleep,
            runChildCommand: (command) => this.runCommand(command, 'bypass'),
            cancelRequested: () => this.cancellationController.signal.aborted,
            abortSignal: () => this.cancellationController.signal
        };
    }

    private clearAbortedCancellation(): void {
        if (this.activeExecutionCount === 0 && this.cancellationController.signal.aborted) {
            this.cancellationController = new AbortController();
        }
    }

    private toResult(
        command: CommandWithId,
        startedAtEpochMs: number,
        outcome: RallarBlackBoxTestCommandOutcome
    ): RallarBlackBoxTestResult {
        const endedAtEpochMs = this.dependencies.now();
        return {
            commandId: command.commandId,
            kind: command.kind,
            status: outcome.status,
            ok: outcome.status === 'ok',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: Math.max(0, endedAtEpochMs - startedAtEpochMs),
            value: this.toRedacted(outcome.value),
            error: this.toRedacted(outcome.error)
        };
    }

    private commitResult(result: RallarBlackBoxTestResult, outcome: RallarBlackBoxTestCommandOutcome): void {
        this.currentState = {
            ...this.currentState,
            status: outcome.nextStatus ?? (result.ok ? 'completed' : 'failed'),
            activeCommand: undefined,
            activeCommandStartedAtEpochMs: undefined,
            commandHistory: [...this.currentState.commandHistory, result],
            failures: result.ok ? this.currentState.failures : [...this.currentState.failures, result],
            resultCache: { ...this.currentState.resultCache, [result.commandId]: result }
        };
        this.appendEvent({
            kind: 'result',
            topic: 'rallar.bb.command.result',
            commandId: result.commandId,
            severity: result.ok ? 'info' : 'error',
            payload: result
        });
        this.notify();
    }

    private updateStats(commandId?: string): RallarBlackBoxTestStatsSnapshot {
        const latestStats = toRuntimeStats(this.currentState, this.dependencies.now());
        this.currentState = { ...this.currentState, latestStats };
        this.appendEvent({
            kind: 'stats',
            topic: 'rallar.bb.stats',
            commandId,
            severity: 'info',
            payload: latestStats
        });
        return latestStats;
    }

    private appendEvent(event: RallarBlackBoxTestRuntimeEventInput): void {
        const created: RallarBlackBoxTestEvent = {
            ...event,
            eventId: this.dependencies.idFactory('event'),
            atEpochMs: this.dependencies.now(),
            payload: this.toRedacted(event.payload)
        };
        this.currentState = { ...this.currentState, events: [...this.currentState.events, created] };
        this.notify();
    }

    private setState(patch: Partial<RallarBlackBoxTestState>): void {
        this.currentState = { ...this.currentState, ...patch };
        this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                void Promise.resolve(listener(this.currentState));
            }
            catch (_error) {
                // State listeners are observational and should not break command execution.
            }
        }
    }

    private toCommandWithId(command: RallarBlackBoxTestCommand): CommandWithId {
        return { ...command, commandId: command.commandId ?? this.dependencies.idFactory('command') } as CommandWithId;
    }

    private toRedacted<T>(value: T): T {
        return redactRallarBlackBoxValue(value, this.currentConfig?.redaction);
    }
}

export function createRallarBlackBoxTestRuntime(
    options: CreateRallarBlackBoxTestRuntimeOptions = {}
): RallarBlackBoxTestRuntime {
    return new InMemoryRallarBlackBoxTestRuntime(toRuntimeDependencies(options));
}

function toRuntimeDependencies(
    options: CreateRallarBlackBoxTestRuntimeOptions
): InMemoryRallarBlackBoxTestRuntime.Dependencies {
    return {
        now: options.now ?? (() => Date.now()),
        sleep: options.sleep ?? sleepWithAbort,
        idFactory: options.idFactory ?? createSequentialIdFactory(),
        commandExecutor: options.commandExecutor,
        cleanup: options.cleanup
    };
}

function createInitialRuntimeState(): RallarBlackBoxTestState {
    return { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
}

function createSequentialIdFactory(): (prefix: string) => string {
    let sequence = 1;
    return (prefix: string) => `${prefix}-${sequence++}`;
}

function toRuntimeHealth(state: RallarBlackBoxTestState): RallarBlackBoxTestRuntimeHealth {
    return {
        status: state.status,
        configured: state.currentConfig !== undefined,
        loadedRecipeId: state.loadedRecipe?.recipeId,
        activeCommandId: state.activeCommand?.commandId,
        commandCount: state.commandHistory.length,
        eventCount: state.events.length,
        failureCount: state.failures.length
    };
}

function toInvalidRecipeOutcome(issues: readonly string[]): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        error: { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: issues.join('\n') },
        nextStatus: 'failed'
    };
}

function toTerminalCleanupReason(outcome: RallarBlackBoxTestCommandOutcome): RallarBlackBoxTestCleanupInput['reason'] {
    if (outcome.status === 'cancelled') {
        return 'cancelled';
    }
    return outcome.error?.code === RALLAR_BLACK_BOX_RECIPE_TIMEOUT ? 'timed-out' : 'failed';
}

function decodeThrownCommandOutcome(error: unknown): RallarBlackBoxTestCommandOutcome {
    return isAbortError(error)
        ? {
            status: 'cancelled',
            error: decodeRuntimeTestError(error, 'RALLAR_BLACK_BOX_COMMAND_CANCELLED'),
            nextStatus: 'cancelled'
        }
        : {
            status: 'failed',
            error: decodeRuntimeTestError(error, 'RALLAR_BLACK_BOX_COMMAND_FAILED'),
            nextStatus: 'failed'
        };
}

function decodeRuntimeTestError(error: unknown, code: string): RallarBlackBoxTestError {
    return error instanceof Error
        ? { code, message: error.message, details: { name: error.name, stack: error.stack } }
        : { code, message: String(error) };
}

interface RallarBlackBoxTestRuntimeHealth {
    readonly status: RallarBlackBoxTestState['status'];
    readonly configured: boolean;
    readonly loadedRecipeId: string | undefined;
    readonly activeCommandId: string | undefined;
    readonly commandCount: number;
    readonly eventCount: number;
    readonly failureCount: number;
}
