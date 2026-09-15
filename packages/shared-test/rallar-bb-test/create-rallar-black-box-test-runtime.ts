import {
    assertValueMatches,
    isRallarBlackBoxAssertOperator,
    RALLAR_BLACK_BOX_ASSERT_OPERATORS
} from './assert/assert-value-operators.ts';
import { normalizeRallarBlackBoxRuntimeDiagnostic } from './diagnostics.ts';
import { LoopCommandExecution } from './loop-command-execution.ts';
import { ParallelCommandExecution } from './parallel-command-execution.ts';
import {
    type RallarBlackBoxTestAssertCommand,
    type RallarBlackBoxTestAssertResultValue,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandContext,
    type RallarBlackBoxTestCommandExecutor,
    type RallarBlackBoxTestCommandOutcome,
    type RallarBlackBoxTestConfig,
    type RallarBlackBoxTestError,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestRecipeRunCommand,
    type RallarBlackBoxTestResult,
    type RallarBlackBoxTestRuntime,
    type RallarBlackBoxTestRuntimeCleanup,
    type RallarBlackBoxTestRuntimeEventInput,
    type RallarBlackBoxTestRuntimeStatus,
    type RallarBlackBoxTestState,
    type RallarBlackBoxTestStateListener,
    type RallarBlackBoxTestStatsSnapshot,
    type RallarBlackBoxTestWaitCommand
} from './rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from './redaction.ts';
import {
    computeCommandDeadlineEpochMs,
    isAbortError,
    toBoundedDeadlineCommand,
    toRecord
} from './to-runtime-command-values.ts';
import { toRuntimeStats } from './to-runtime-stats.ts';
import { lookupPayloadPath, type PayloadPathLookup } from './wait/wait-event-match.ts';
import { waitForEvent } from './wait/wait-for-event.ts';

interface RecipeTimeoutInput {
    readonly command: RecipeRunCommandWithId;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly results: readonly RallarBlackBoxTestResult[];
    readonly deadlineEpochMs: number;
}

export interface CreateRallarBlackBoxTestRuntimeOptions {
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly idFactory?: (prefix: string) => string;
    readonly commandExecutor?: RallarBlackBoxTestCommandExecutor;
    readonly cleanup?: RallarBlackBoxTestRuntimeCleanup;
}

type CommandWithId = RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>;
type WaitCommandWithId = RallarBlackBoxTestWaitCommand & Readonly<{ commandId: string; }>;
type AssertCommandWithId = RallarBlackBoxTestAssertCommand & Readonly<{ commandId: string; }>;
type RecipeRunCommandWithId = RallarBlackBoxTestRecipeRunCommand & Readonly<{ commandId: string; }>;
const RECENT_ASSERT_SOURCE_LIMIT = 20;
const ABORT_ERROR_CODE = 'RALLAR_BLACK_BOX_ABORTED';
const RALLAR_CONFIG_AUTH_INTENT_KEYS = [
    'username',
    'password',
    'token',
    'register',
    'displayName',
    'restoreSession'
] as const;
const RALLAR_CONFIG_INHERITED_KEYS = [
    ...RALLAR_CONFIG_AUTH_INTENT_KEYS,
    'logoutOnClose',
    'leaveRoomOnClose',
    'timeoutMs'
] as const;

function initialState(): RallarBlackBoxTestState {
    return {
        status: 'idle',
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {}
    };
}

function defaultIdFactory(): (prefix: string) => string {
    let sequence = 1;
    return (prefix: string) => `${prefix}-${sequence++}`;
}

function toError(error: unknown, code = 'RALLAR_BLACK_BOX_COMMAND_FAILED'): RallarBlackBoxTestError {
    if (error instanceof Error) {
        return {
            code,
            message: error.message,
            details: {
                name: error.name,
                stack: error.stack
            }
        };
    }

    return {
        code,
        message: String(error)
    };
}

function validateExecutableRecipe(recipe: RallarBlackBoxTestRecipe): string | undefined {
    if (recipe.schemaVersion !== 1) {
        return 'Recipe schemaVersion must be 1.';
    }
    if (!recipe.recipeId) {
        return 'Recipe requires recipeId.';
    }
    if (!Array.isArray(recipe.commands) || recipe.commands.length === 0) {
        return 'Recipe requires at least one command.';
    }
    return validateInlineRecipeVersions(recipe.commands);
}

function validateInlineRecipeVersions(commands: readonly RallarBlackBoxTestCommand[]): string | undefined {
    for (const command of commands) {
        if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
            if (command.recipe.schemaVersion !== 1) {
                return 'Recipe schemaVersion must be 1.';
            }
            const nested = validateInlineRecipeVersions(command.recipe.commands);
            if (nested) {
                return nested;
            }
        }
        const children = command.kind === 'loop'
            ? command.commands
            : command.kind === 'parallel'
            ? command.groups.flatMap((group) => group.commands)
            : [];
        const error = validateInlineRecipeVersions(children);
        if (error) {
            return error;
        }
    }
    return undefined;
}

function toInvalidRecipeOutcome(message: string): RallarBlackBoxTestCommandOutcome {
    return { status: 'failed', error: { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message }, nextStatus: 'failed' };
}

function mergeConfigureConfig(
    current: RallarBlackBoxTestConfig | undefined,
    next: RallarBlackBoxTestConfig
): RallarBlackBoxTestConfig {
    if (!next.rallar) {
        return next;
    }

    const nextRallar = toRecord(next.rallar);
    const hasIncomingAuth = RALLAR_CONFIG_AUTH_INTENT_KEYS
        .some((key) => Object.prototype.hasOwnProperty.call(nextRallar, key));
    if (hasIncomingAuth) {
        return next;
    }

    const currentRallar = toRecord(current?.rallar);
    const inheritedAuth = Object.fromEntries(
        RALLAR_CONFIG_INHERITED_KEYS
            .filter((key) => currentRallar[key] !== undefined)
            .map((key) => [key, currentRallar[key]])
    );
    if (Object.keys(inheritedAuth).length === 0) {
        return next;
    }

    return {
        ...next,
        rallar: {
            ...inheritedAuth,
            ...nextRallar
        }
    };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(toAbortError(signal.reason));
    }

    return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(toAbortError(signal?.reason));
        };

        timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, {
            once: true
        });
    });
}

function toAbortError(reason: unknown): Error {
    if (reason instanceof Error) {
        return reason;
    }

    const message = typeof reason === 'string' && reason.length > 0
        ? reason
        : 'Rallar black-box runtime operation was cancelled.';
    const error = new Error(message);
    error.name = ABORT_ERROR_CODE;
    return error;
}

class InMemoryRallarBlackBoxTestRuntime implements RallarBlackBoxTestRuntime {
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly idFactory: (prefix: string) => string;
    private readonly commandExecutor: RallarBlackBoxTestCommandExecutor | undefined;
    private readonly cleanup: RallarBlackBoxTestRuntimeCleanup | undefined;
    private readonly listeners = new Set<RallarBlackBoxTestStateListener>();
    private currentState: RallarBlackBoxTestState = initialState();
    private currentConfig: RallarBlackBoxTestConfig | undefined;
    private currentRedaction: RallarBlackBoxTestConfig['redaction'] | undefined;
    private loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    private cancelRequested = false;
    private cancellationController = new AbortController();
    private recipeExecutionDepth = 0;

    constructor(options: CreateRallarBlackBoxTestRuntimeOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? sleep;
        this.idFactory = options.idFactory ?? defaultIdFactory();
        this.commandExecutor = options.commandExecutor;
        this.cleanup = options.cleanup;
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
        this.emitEvent(event);
    }

    async execute(
        command: RallarBlackBoxTestCommand
    ): Promise<RallarBlackBoxTestResult> {
        return await this.executeCommand(command);
    }

    private async executeCommand(
        command: RallarBlackBoxTestCommand,
        options: Readonly<{ bypassCache?: boolean; }> = {}
    ): Promise<RallarBlackBoxTestResult> {
        const commandWithId = this.withCommandId(command);
        if (
            commandWithId.kind !== 'recipe.cancel' &&
            this.currentState.status !== 'running' &&
            this.cancellationController.signal.aborted
        ) {
            this.cancelRequested = false;
            this.resetCancellationSignal();
        }
        const cached = this.currentState.resultCache[commandWithId.commandId];
        if (cached && options.bypassCache !== true) {
            return {
                ...cached,
                replayed: true
            };
        }

        const startedAtEpochMs = this.now();
        this.setState({
            activeCommand: this.redact(commandWithId),
            activeCommandStartedAtEpochMs: startedAtEpochMs,
            status: commandWithId.kind === 'recipe.cancel'
                ? this.currentState.status
                : 'running'
        });

        let outcome: RallarBlackBoxTestCommandOutcome;
        try {
            outcome = await this.perform(commandWithId);
        }
        catch (error) {
            outcome = isAbortError(error)
                ? {
                    status: 'cancelled',
                    error: toError(error, 'RALLAR_BLACK_BOX_COMMAND_CANCELLED'),
                    nextStatus: 'cancelled'
                }
                : {
                    status: 'failed',
                    error: toError(error),
                    nextStatus: 'failed'
                };
        }

        const result = this.toResult(commandWithId, startedAtEpochMs, outcome);
        this.commitResult(result, outcome.nextStatus);
        return result;
    }

    private async perform(command: CommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
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
                return await this.dispatchExternalCommand(command);
        }
    }

    private toCommandContext(): RallarBlackBoxTestCommandContext {
        return {
            state: () => this.currentState,
            config: () => this.currentConfig,
            abortSignal: () => this.cancellationController.signal,
            recordEvent: (event) => this.emitEvent(event),
            updateStats: (commandId) => this.updateStats(commandId)
        };
    }

    private resetCancellationSignal(): void {
        if (!this.cancellationController.signal.aborted) {
            return;
        }

        this.cancellationController = new AbortController();
    }

    private requestCancellation(reason: string | undefined): void {
        this.cancelRequested = true;
        if (!this.cancellationController.signal.aborted) {
            this.cancellationController.abort(reason ?? 'Rallar black-box recipe cancellation requested.');
        }
    }

    private async cleanupOwnedResources(input: Parameters<RallarBlackBoxTestRuntimeCleanup>[0]): Promise<void> {
        if (!this.cleanup) {
            return;
        }

        try {
            await this.cleanup(input, this.toCommandContext());
            this.emitEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.completed',
                commandId: input.commandId,
                severity: 'info',
                payload: input
            });
        }
        catch (error) {
            this.emitEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.failed',
                commandId: input.commandId,
                severity: 'error',
                payload: {
                    input,
                    error: toError(error, 'RALLAR_BLACK_BOX_CLEANUP_FAILED')
                }
            });
        }
    }

    private configure(config: RallarBlackBoxTestConfig): RallarBlackBoxTestCommandOutcome {
        const mergedConfig = mergeConfigureConfig(this.currentConfig, config);
        this.currentConfig = mergedConfig;
        this.currentRedaction = mergedConfig.redaction;
        const redactedConfig = this.redact(mergedConfig);
        this.setState({
            currentConfig: redactedConfig
        });
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.configured',
            severity: 'info',
            payload: redactedConfig
        });
        return {
            status: 'ok',
            value: {
                config: redactedConfig
            },
            nextStatus: 'configured'
        };
    }

    private loadRecipe(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommandOutcome {
        const error = validateExecutableRecipe(recipe);
        if (error) {
            return toInvalidRecipeOutcome(error);
        }
        this.loadedRecipe = recipe;
        const redactedRecipe = this.redact(recipe);
        this.setState({
            loadedRecipe: redactedRecipe
        });
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.recipe.loaded',
            severity: 'info',
            payload: {
                recipeId: recipe.recipeId,
                commandCount: recipe.commands.length
            }
        });
        return {
            status: 'ok',
            value: {
                recipeId: recipe.recipeId,
                commandCount: recipe.commands.length
            },
            nextStatus: 'loaded'
        };
    }

    private async runRecipe(command: RecipeRunCommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        const recipe = command.recipe ?? this.loadedRecipe;
        if (!recipe) {
            return toInvalidRecipeOutcome('No recipe is loaded.');
        }
        const error = validateExecutableRecipe(recipe);
        if (error) {
            return toInvalidRecipeOutcome(error);
        }
        this.cancelRequested = false;
        this.resetCancellationSignal();
        const deadlineEpochMs = computeCommandDeadlineEpochMs(command, this.now());
        this.recipeExecutionDepth += 1;
        try {
            const outcome = await this.runRecipeCommands(command, recipe, deadlineEpochMs);
            if (outcome.status !== 'ok') {
                await this.cleanupAfterTerminalRecipe(command, recipe, outcome);
            }
            return outcome;
        }
        finally {
            this.recipeExecutionDepth -= 1;
        }
    }

    private toRecipeChildCommand(
        childCommand: RallarBlackBoxTestCommand,
        recipeDeadlineEpochMs: number | undefined
    ): RallarBlackBoxTestCommand {
        if (recipeDeadlineEpochMs === undefined) {
            return childCommand;
        }

        return toBoundedDeadlineCommand(childCommand, recipeDeadlineEpochMs);
    }

    private recipeTimedOut(input: RecipeTimeoutInput): RallarBlackBoxTestCommandOutcome {
        const { command, recipe, results, deadlineEpochMs } = input;
        return {
            status: 'failed',
            value: {
                recipeId: recipe.recipeId,
                results,
                timedOut: true
            },
            error: {
                code: 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT',
                message: 'Recipe reached its timeout before all commands completed.',
                details: {
                    timeoutMs: command.timeoutMs,
                    deadlineEpochMs,
                    completedCommands: results.length,
                    totalCommands: recipe.commands.length
                }
            },
            nextStatus: 'failed'
        };
    }

    private async cleanupAfterTerminalRecipe(
        command: RecipeRunCommandWithId,
        recipe: RallarBlackBoxTestRecipe,
        outcome: RallarBlackBoxTestCommandOutcome
    ): Promise<void> {
        await this.cleanupOwnedResources({
            reason: outcome.status === 'cancelled'
                ? 'cancelled'
                : outcome.error?.code === 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT'
                ? 'timed-out'
                : 'failed',
            commandId: command.commandId,
            recipeId: recipe.recipeId,
            status: outcome.status,
            error: outcome.error
        });
    }

    private async waitForEvent(command: WaitCommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        return await waitForEvent({
            command,
            now: this.now,
            sleep: this.sleep,
            cancellationSignal: this.cancellationController.signal,
            cancelRequested: () => this.cancelRequested,
            currentStatus: () => this.currentState.status,
            currentEvents: () => this.currentState.events,
            subscribe: (listener) => this.subscribe(() => listener())
        });
    }

    private assertRuntimeEvidence(command: AssertCommandWithId): RallarBlackBoxTestCommandOutcome {
        if (typeof command.source !== 'string' || command.source.trim().length === 0) {
            return this.assertInvalid(command, 'Assert requires a non-empty source.');
        }
        if (!isRallarBlackBoxAssertOperator(command.operator)) {
            return this.assertInvalid(command, 'Assert operator is not supported.', {
                operator: command.operator,
                supportedOperators: RALLAR_BLACK_BOX_ASSERT_OPERATORS
            });
        }

        const source = this.resolveAssertSource(command.source);
        const passed = assertValueMatches(
            source,
            command.operator,
            command.expected
        );
        const value = this.toAssertResultValue(command, source, passed);

        if (passed) {
            return {
                status: 'ok',
                value,
                nextStatus: this.currentState.status
            };
        }

        return {
            status: 'failed',
            value,
            error: {
                code: 'RALLAR_BLACK_BOX_ASSERT_FAILED',
                message: `Assert failed for ${command.source}.`,
                details: value
            },
            nextStatus: 'failed'
        };
    }

    private resolveAssertSource(source: string): PayloadPathLookup {
        const trimmed = source.trim();
        const [rootName, ...pathParts] = trimmed.split('.').filter((part) => part.length > 0);
        if (!rootName) {
            return { exists: false };
        }

        const roots = this.toAssertSourceRoots();
        if (!Object.prototype.hasOwnProperty.call(roots, rootName)) {
            return { exists: false };
        }

        const root = roots[rootName];
        if (pathParts.length === 0) {
            return {
                exists: root !== undefined,
                value: root
            };
        }

        return lookupPayloadPath(root, pathParts.join('.'));
    }

    private toAssertSourceRoots(): Record<string, unknown> {
        const events = this.currentState.events;
        const messages = events.filter((event) => event.kind === 'message');
        const diagnostics = events.filter((event) => event.kind === 'diagnostic');
        const reports = events.filter((event) => event.kind === 'report');
        const results = this.currentState.commandHistory;
        const stateView = {
            ...this.currentState,
            results,
            messages,
            diagnostics,
            reports
        };

        return {
            state: stateView,
            config: this.currentConfig,
            currentConfig: this.currentConfig,
            lastResult: results.at(-1),
            events,
            messages,
            diagnostics,
            reports,
            recentEvents: events.slice(-RECENT_ASSERT_SOURCE_LIMIT),
            recentMessages: messages.slice(-RECENT_ASSERT_SOURCE_LIMIT),
            recentDiagnostics: diagnostics.slice(-RECENT_ASSERT_SOURCE_LIMIT),
            latestStats: this.currentState.latestStats,
            stats: this.currentState.latestStats,
            failures: this.currentState.failures,
            resultCache: this.currentState.resultCache
        };
    }

    private toAssertResultValue(
        command: AssertCommandWithId,
        source: PayloadPathLookup,
        passed: boolean
    ): RallarBlackBoxTestAssertResultValue {
        return {
            commandId: command.commandId,
            source: command.source,
            operator: command.operator,
            expected: command.expected,
            actual: source.value,
            exists: source.exists,
            passed
        };
    }

    private assertInvalid(
        command: AssertCommandWithId,
        message: string,
        details?: unknown
    ): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'failed',
            value: {
                commandId: command.commandId,
                source: command.source,
                operator: command.operator,
                expected: command.expected,
                exists: false,
                passed: false
            } satisfies RallarBlackBoxTestAssertResultValue,
            error: {
                code: 'RALLAR_BLACK_BOX_ASSERT_INVALID',
                message,
                details
            },
            nextStatus: 'failed'
        };
    }

    private async cancelRecipe(
        command: Extract<CommandWithId, { kind: 'recipe.cancel'; }>
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        this.requestCancellation(command.reason);
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.recipe.cancel_requested',
            commandId: command.commandId,
            severity: 'warning',
            payload: {
                reason: command.reason
            }
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
            value: {
                cancelRequested: true,
                reason: command.reason
            },
            nextStatus: this.currentState.status === 'running'
                ? 'cancelled'
                : this.currentState.status
        };
    }

    private fakeCommand(command: CommandWithId): RallarBlackBoxTestCommandOutcome {
        this.emitEvent({
            kind: 'diagnostic',
            topic: `rallar.bb.fake.${command.kind}`,
            commandId: command.commandId,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: `rallar.bb.fake.${command.kind}`,
                severity: 'info',
                commandId: command.commandId,
                payload: { command: this.redact(command) }
            })
        });
        return {
            status: 'ok',
            value: {
                fake: true,
                kind: command.kind,
                commandId: command.commandId
            },
            nextStatus: this.currentState.status
        };
    }

    private toResult(
        command: CommandWithId,
        startedAtEpochMs: number,
        outcome: RallarBlackBoxTestCommandOutcome
    ): RallarBlackBoxTestResult {
        const endedAtEpochMs = this.now();
        const result: RallarBlackBoxTestResult = {
            commandId: command.commandId,
            kind: command.kind,
            status: outcome.status,
            ok: outcome.status === 'ok',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: Math.max(0, endedAtEpochMs - startedAtEpochMs),
            value: this.redact(outcome.value),
            error: this.redact(outcome.error)
        };
        return result;
    }

    private commitResult(
        result: RallarBlackBoxTestResult,
        nextStatus: RallarBlackBoxTestRuntimeStatus | undefined
    ): void {
        const commandHistory = [...this.currentState.commandHistory, result];
        const failures = result.ok
            ? this.currentState.failures
            : [...this.currentState.failures, result];
        const resultCache = {
            ...this.currentState.resultCache,
            [result.commandId]: result
        };

        this.currentState = {
            ...this.currentState,
            status: nextStatus ?? (result.ok ? 'completed' : 'failed'),
            activeCommand: undefined,
            activeCommandStartedAtEpochMs: undefined,
            commandHistory,
            failures,
            resultCache
        };

        this.emitEvent({
            kind: 'result',
            topic: 'rallar.bb.command.result',
            commandId: result.commandId,
            severity: result.ok ? 'info' : 'error',
            payload: result
        });
        this.notify();
    }

    private updateStats(commandId?: string): RallarBlackBoxTestStatsSnapshot {
        const latestStats = toRuntimeStats(this.currentState, this.now());
        this.currentState = { ...this.currentState, latestStats };
        this.emitEvent({ kind: 'stats', topic: 'rallar.bb.stats', commandId, severity: 'info', payload: latestStats });
        return latestStats;
    }

    private toHealth(): unknown {
        return {
            status: this.currentState.status,
            configured: this.currentState.currentConfig !== undefined,
            loadedRecipeId: this.currentState.loadedRecipe?.recipeId,
            activeCommandId: this.currentState.activeCommand?.commandId,
            commandCount: this.currentState.commandHistory.length,
            eventCount: this.currentState.events.length,
            failureCount: this.currentState.failures.length
        };
    }

    private emitEvent(
        event: RallarBlackBoxTestRuntimeEventInput
    ): void {
        const created: RallarBlackBoxTestEvent = {
            ...event,
            eventId: this.idFactory('event'),
            atEpochMs: this.now(),
            payload: this.redact(event.payload)
        };
        this.currentState = {
            ...this.currentState,
            events: [...this.currentState.events, created]
        };
        this.notify();
    }

    private setState(patch: Partial<RallarBlackBoxTestState>): void {
        this.currentState = {
            ...this.currentState,
            ...patch
        };
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

    private withCommandId(command: RallarBlackBoxTestCommand): CommandWithId {
        return {
            ...command,
            commandId: command.commandId ?? this.idFactory('command')
        } as CommandWithId;
    }

    private redact<T>(value: T): T {
        return redactRallarBlackBoxValue(
            value,
            this.currentRedaction
        );
    }

    private toCompositeExecutionPorts() {
        return {
            now: this.now,
            sleep: this.sleep,
            executeCommand: (command: RallarBlackBoxTestCommand, options?: Readonly<{ bypassCache?: boolean; }>) =>
                this.executeCommand(command, options),
            cancelRequested: () => this.cancelRequested,
            abortSignal: () => this.cancellationController.signal
        };
    }

    private async reset(command: CommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        const outcome = await this.commandExecutor?.(command, this.toCommandContext());
        this.currentState = initialState();
        this.currentConfig = undefined;
        this.currentRedaction = undefined;
        this.loadedRecipe = undefined;
        this.cancelRequested = false;
        this.resetCancellationSignal();
        this.notify();
        return outcome
            ? { ...outcome, nextStatus: 'idle' }
            : { status: 'ok', value: { reset: true }, nextStatus: 'idle' };
    }

    private async dispatchExternalCommand(command: CommandWithId): Promise<RallarBlackBoxTestCommandOutcome> {
        const outcome = await this.commandExecutor?.(command, this.toCommandContext());
        if (outcome) {
            return outcome;
        }
        switch (command.kind) {
            case 'loop':
                return await new LoopCommandExecution(command, this.toCompositeExecutionPorts()).run();
            case 'parallel':
                return await new ParallelCommandExecution(command, this.toCompositeExecutionPorts()).run();
            case 'wait':
                return await this.waitForEvent(command);
            case 'assert':
                return this.assertRuntimeEvidence(command);
            case 'health':
                return { status: 'ok', value: this.toHealth(), nextStatus: this.currentState.status };
            case 'close':
                this.emitEvent({
                    kind: 'event',
                    topic: 'rallar.bb.closed',
                    commandId: command.commandId,
                    severity: 'info'
                });
                return { status: 'ok', value: { closed: true }, nextStatus: 'idle' };
            default:
                return this.fakeCommand(command);
        }
    }

    private async runRecipeCommands(
        command: RecipeRunCommandWithId,
        recipe: RallarBlackBoxTestRecipe,
        deadlineEpochMs: number | undefined
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const results: RallarBlackBoxTestResult[] = [];
        for (const child of recipe.commands) {
            if (this.cancelRequested) {
                return this.toCancelledRecipeOutcome(recipe, results);
            }
            if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                return this.recipeTimedOut({ command, recipe, results, deadlineEpochMs });
            }
            const result = await this.executeCommand(this.toRecipeChildCommand(child, deadlineEpochMs), {
                bypassCache: true
            });
            results.push(result);
            if (this.cancelRequested || result.status === 'cancelled') {
                return this.toCancelledRecipeOutcome(recipe, results);
            }
            if (!result.ok && recipe.continueOnFailure !== true) {
                return {
                    status: 'failed',
                    value: { recipeId: recipe.recipeId, results },
                    nextStatus: 'failed',
                    error: {
                        code: 'RALLAR_BLACK_BOX_RECIPE_FAILED',
                        message: 'Recipe failed at command ' + result.commandId + '.',
                        details: result.error
                    }
                };
            }
        }
        return { status: 'ok', value: { recipeId: recipe.recipeId, results }, nextStatus: 'completed' };
    }

    private toCancelledRecipeOutcome(
        recipe: RallarBlackBoxTestRecipe,
        results: readonly RallarBlackBoxTestResult[]
    ): RallarBlackBoxTestCommandOutcome {
        return {
            status: 'cancelled',
            value: { recipeId: recipe.recipeId, results, cancelled: true },
            nextStatus: 'cancelled'
        };
    }
}

export function createRallarBlackBoxTestRuntime(
    options: CreateRallarBlackBoxTestRuntimeOptions = {}
): RallarBlackBoxTestRuntime {
    return new InMemoryRallarBlackBoxTestRuntime(options);
}
