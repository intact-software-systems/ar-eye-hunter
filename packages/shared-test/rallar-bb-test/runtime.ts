import { redactRallarBlackBoxValue } from './redaction.ts';
import {
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
    rallarBlackBoxLoopChildResultPath,
    rallarBlackBoxLoopChildSourceRecipePath,
    rallarBlackBoxParallelChildResultPath,
    rallarBlackBoxParallelChildSourceRecipePath,
} from './composite-results.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestAssertCommand,
    type RallarBlackBoxTestAssertOperator,
    type RallarBlackBoxTestAssertResultValue,
    type RallarBlackBoxTestCompositeChildResult,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandContext,
    type RallarBlackBoxTestCommandExecutor,
    type RallarBlackBoxTestCommandOutcome,
    type RallarBlackBoxTestConfig,
    type RallarBlackBoxTestError,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestLoopPacingIteration,
    type RallarBlackBoxTestLoopPacingSummary,
    type RallarBlackBoxTestLoopResultValue,
    type RallarBlackBoxTestLoopSendSummary,
    type RallarBlackBoxTestLoopThresholdFailure,
    type RallarBlackBoxTestParallelCommand,
    type RallarBlackBoxTestParallelGroup,
    type RallarBlackBoxTestParallelGroupResult,
    type RallarBlackBoxTestParallelResultValue,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestRecipeRunCommand,
    type RallarBlackBoxTestResult,
    type RallarBlackBoxTestRuntimeCleanup,
    type RallarBlackBoxTestRuntime,
    type RallarBlackBoxTestRuntimeEventInput,
    type RallarBlackBoxTestRuntimeStatus,
    type RallarBlackBoxTestSendObservation,
    type RallarBlackBoxTestState,
    type RallarBlackBoxTestStateListener,
    type RallarBlackBoxTestStatsSnapshot,
    type RallarBlackBoxTestTransport,
    type RallarBlackBoxTestWaitCommand,
    type RallarBlackBoxTestWaitMatch,
    type RallarBlackBoxTestWaitResultValue,
} from './types.ts';

export type CreateRallarBlackBoxTestRuntimeOptions = Readonly<{
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    idFactory?: (prefix: string) => string;
    commandExecutor?: RallarBlackBoxTestCommandExecutor;
    cleanup?: RallarBlackBoxTestRuntimeCleanup;
}>;

type CommandWithId = RallarBlackBoxTestCommand & Readonly<{ commandId: string }>;
type LoopCommandWithId = RallarBlackBoxTestLoopCommand & Readonly<{ commandId: string }>;
type ParallelCommandWithId = RallarBlackBoxTestParallelCommand & Readonly<{ commandId: string }>;
type WaitCommandWithId = RallarBlackBoxTestWaitCommand & Readonly<{ commandId: string }>;
type AssertCommandWithId = RallarBlackBoxTestAssertCommand & Readonly<{ commandId: string }>;
type RecipeRunCommandWithId = RallarBlackBoxTestRecipeRunCommand & Readonly<{ commandId: string }>;

type CommandOutcome = RallarBlackBoxTestCommandOutcome;

type LoopContext = Readonly<{
    loopCommandId: string;
    index: number;
    iteration: number;
    elapsedMs: number;
    commandIndex: number;
}>;

type ParallelContext = Readonly<{
    parallelCommandId: string;
    groupId: string;
    groupIndex: number;
    commandIndex: number;
}>;

type ParallelGroupExecution = Readonly<{
    result: RallarBlackBoxTestParallelGroupResult;
    failedResult?: RallarBlackBoxTestResult;
    cancelled: boolean;
    timedOut: boolean;
}>;

type LoopResultMetrics = Readonly<{
    intervalMs: number;
    count: number;
    durationMs?: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    pacingIterations: readonly RallarBlackBoxTestLoopPacingIteration[];
    thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
}>;

const LOOP_PLACEHOLDER_PATTERN = /\{loop\.(index|iteration|elapsedMs|commandIndex)\}/g;
const LOOP_EXACT_PLACEHOLDER_PATTERN = /^\{loop\.(index|iteration|elapsedMs|commandIndex)\}$/;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const RECENT_ASSERT_SOURCE_LIMIT = 20;
const ASSERT_OPERATORS = ['equals', 'notEquals', 'contains', 'exists', 'gte', 'lte'] as const;
const ABORT_ERROR_CODE = 'RALLAR_BLACK_BOX_ABORTED';

type PayloadPathLookup = Readonly<{
    exists: boolean;
    value?: unknown;
}>;

function initialState(): RallarBlackBoxTestState {
    return {
        status: 'idle',
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {},
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
                stack: error.stack,
            },
        };
    }

    return {
        code,
        message: String(error),
    };
}

function requireRecipeIsExecutable(recipe: RallarBlackBoxTestRecipe): void {
    if (!recipe.recipeId) {
        throw new Error('Recipe requires recipeId.');
    }

    if (!Array.isArray(recipe.commands) || recipe.commands.length === 0) {
        throw new Error('Recipe requires at least one command.');
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function positiveIntegerValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
}

function finiteNumberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

function transportValue(value: unknown): RallarBlackBoxTestTransport | undefined {
    return value === 'realtime' ||
        value === 'messages.rtc' ||
        value === 'ws' ||
        value === 'http'
        ? value
        : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean'
        ? value
        : undefined;
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
    return values.find(value => value !== undefined);
}

function roundedMetric(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
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
            once: true,
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

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === ABORT_ERROR_CODE;
}

function commandLabelForId(command: RallarBlackBoxTestCommand, fallbackIndex: number): string {
    const source = command.commandId ?? `${command.kind}-${fallbackIndex}`;
    return source.replace(/[^a-zA-Z0-9_.:-]/g, '-');
}

function groupLabelForId(group: RallarBlackBoxTestParallelGroup, fallbackIndex: number): string {
    const source = group.groupId ?? `group-${fallbackIndex}`;
    return source.replace(/[^a-zA-Z0-9_.:-]/g, '-');
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

function replaceLoopPlaceholders(value: unknown, context: LoopContext): unknown {
    if (typeof value === 'string') {
        const exact = LOOP_EXACT_PLACEHOLDER_PATTERN.exec(value);
        if (exact) {
            return loopPlaceholderValue(exact[1], context);
        }

        return value.replace(LOOP_PLACEHOLDER_PATTERN, (_match, name: string) =>
            String(loopPlaceholderValue(name, context))
        );
    }

    if (Array.isArray(value)) {
        return value.map(entry => replaceLoopPlaceholders(entry, context));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
            key,
            replaceLoopPlaceholders(entry, context),
        ]));
    }

    return value;
}

function normalisePayloadPath(path: string): string {
    if (path.startsWith('$.payload.')) {
        return path.slice('$.payload.'.length);
    }
    if (path.startsWith('payload.')) {
        return path.slice('payload.'.length);
    }
    if (path.startsWith('$.')) {
        return path.slice('$.'.length);
    }
    return path;
}

function lookupPayloadPath(payload: unknown, path: string | undefined): PayloadPathLookup {
    if (!path || path.trim().length === 0) {
        return {
            exists: payload !== undefined,
            value: payload,
        };
    }

    let current = payload;
    const segments = normalisePayloadPath(path)
        .split('.')
        .filter(segment => segment.length > 0);
    for (const segment of segments) {
        if ((Array.isArray(current) || typeof current === 'string') && segment === 'length') {
            current = current.length;
            continue;
        }

        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                return { exists: false };
            }
            current = current[index];
            continue;
        }

        if (!current || typeof current !== 'object') {
            return { exists: false };
        }

        const record = current as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, segment)) {
            return { exists: false };
        }
        current = record[segment];
    }

    return {
        exists: true,
        value: current,
    };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch (_error) {
        return Object.is(left, right);
    }
}

function containsValue(value: unknown, expected: string): boolean {
    if (typeof value === 'string') {
        return value.includes(expected);
    }
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string'
            ? serialized.includes(expected)
            : String(value).includes(expected);
    } catch (_error) {
        return String(value).includes(expected);
    }
}

function containsAssertValue(value: unknown, expected: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(entry => sameJsonValue(entry, expected));
    }

    if (typeof value === 'string') {
        return value.includes(String(expected));
    }

    if (value && typeof value === 'object') {
        if (typeof expected === 'string') {
            return containsValue(value, expected);
        }
        return Object.values(value as Record<string, unknown>)
            .some(entry => sameJsonValue(entry, expected));
    }

    return containsValue(value, String(expected));
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
        command: RallarBlackBoxTestCommand,
    ): Promise<RallarBlackBoxTestResult> {
        return await this.executeCommand(command);
    }

    private async executeCommand(
        command: RallarBlackBoxTestCommand,
        options: Readonly<{ bypassCache?: boolean }> = {},
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
                replayed: true,
            };
        }

        const startedAtEpochMs = this.now();
        this.setState({
            activeCommand: this.redact(commandWithId),
            activeCommandStartedAtEpochMs: startedAtEpochMs,
            status: commandWithId.kind === 'recipe.cancel'
                ? this.currentState.status
                : 'running',
        });

        let outcome: CommandOutcome;
        try {
            outcome = await this.perform(commandWithId);
        } catch (error) {
            outcome = isAbortError(error)
                ? {
                    status: 'cancelled',
                    error: toError(error, 'RALLAR_BLACK_BOX_COMMAND_CANCELLED'),
                    nextStatus: 'cancelled',
                }
                : {
                    status: 'failed',
                    error: toError(error),
                    nextStatus: 'failed',
                };
        }

        const result = this.toResult(commandWithId, startedAtEpochMs, outcome);
        this.commitResult(result, outcome.nextStatus);
        return result;
    }

    private async perform(command: CommandWithId): Promise<CommandOutcome> {
        switch (command.kind) {
            case 'configure':
                return this.configure(command.config);
            case 'recipe.load':
                return this.loadRecipe(command.recipe);
            case 'recipe.run':
                return await this.runRecipe(command);
            case 'recipe.cancel':
                return await this.cancelRecipe(command);
            case 'loop':
                return await this.externalOrDefault(command, () => this.runLoop(command));
            case 'parallel':
                return await this.externalOrDefault(command, () => this.runParallel(command));
            case 'wait':
                return await this.externalOrDefault(command, () => this.waitForEvent(command));
            case 'assert':
                return await this.externalOrDefault(command, () => this.assertRuntimeEvidence(command));
            case 'health':
                return await this.externalOrDefault(command, () => ({
                    status: 'ok',
                    value: this.toHealth(),
                    nextStatus: this.currentState.status,
                }));
            case 'stats':
                return {
                    status: 'ok',
                    value: this.updateStats(command.commandId),
                    nextStatus: this.currentState.status,
                };
            case 'reset': {
                const externalOutcome = await this.commandExecutor?.(
                    command,
                    this.toCommandContext(),
                );

                this.currentState = initialState();
                this.currentConfig = undefined;
                this.currentRedaction = undefined;
                this.loadedRecipe = undefined;
                this.cancelRequested = false;
                this.resetCancellationSignal();
                this.notify();

                return externalOutcome
                    ? {
                        ...externalOutcome,
                        nextStatus: 'idle',
                    }
                    : {
                        status: 'ok',
                        value: {
                            reset: true,
                        },
                        nextStatus: 'idle',
                    };
            }
            case 'close':
                return await this.externalOrDefault(command, () => {
                    this.emitEvent({
                        kind: 'event',
                        topic: 'rallar.bb.closed',
                        commandId: command.commandId,
                        severity: 'info',
                    });
                    return {
                        status: 'ok',
                        value: {
                            closed: true,
                        },
                        nextStatus: 'idle',
                    };
                });
            default:
                return await this.externalOrDefault(command, () => this.fakeCommand(command));
        }
    }

    private async externalOrDefault(
        command: CommandWithId,
        fallback: () => CommandOutcome | Promise<CommandOutcome>,
    ): Promise<CommandOutcome> {
        const outcome = await this.commandExecutor?.(
            command,
            this.toCommandContext(),
        );
        return outcome ?? await fallback();
    }

    private toCommandContext(): RallarBlackBoxTestCommandContext {
        return {
            state: () => this.currentState,
            config: () => this.currentConfig,
            abortSignal: () => this.cancellationController.signal,
            recordEvent: event => this.emitEvent(event),
            updateStats: commandId => this.updateStats(commandId),
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

    private commandDeadlineEpochMs(command: CommandWithId): number | undefined {
        const timeoutDeadline = command.timeoutMs === undefined
            ? undefined
            : this.now() + Math.max(0, command.timeoutMs);

        if (command.deadlineEpochMs === undefined) {
            return timeoutDeadline;
        }

        return timeoutDeadline === undefined
            ? command.deadlineEpochMs
            : Math.min(timeoutDeadline, command.deadlineEpochMs);
    }

    private withBoundedDeadline<T extends RallarBlackBoxTestCommand>(
        command: T,
        deadlineEpochMs: number,
    ): T {
        const commandDeadline = command.deadlineEpochMs;
        return {
            ...command,
            deadlineEpochMs: commandDeadline === undefined
                ? deadlineEpochMs
                : Math.min(commandDeadline, deadlineEpochMs),
        };
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
                payload: input,
            });
        } catch (error) {
            this.emitEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.failed',
                commandId: input.commandId,
                severity: 'error',
                payload: {
                    input,
                    error: toError(error, 'RALLAR_BLACK_BOX_CLEANUP_FAILED'),
                },
            });
        }
    }

    private configure(config: RallarBlackBoxTestConfig): CommandOutcome {
        this.currentConfig = config;
        this.currentRedaction = config.redaction;
        const redactedConfig = this.redact(config);
        this.setState({
            currentConfig: redactedConfig,
        });
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.configured',
            severity: 'info',
            payload: redactedConfig,
        });
        return {
            status: 'ok',
            value: {
                config: redactedConfig,
            },
            nextStatus: 'configured',
        };
    }

    private loadRecipe(recipe: RallarBlackBoxTestRecipe): CommandOutcome {
        requireRecipeIsExecutable(recipe);
        this.loadedRecipe = recipe;
        const redactedRecipe = this.redact(recipe);
        this.setState({
            loadedRecipe: redactedRecipe,
        });
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.recipe.loaded',
            severity: 'info',
            payload: {
                recipeId: recipe.recipeId,
                commandCount: recipe.commands.length,
            },
        });
        return {
            status: 'ok',
            value: {
                recipeId: recipe.recipeId,
                commandCount: recipe.commands.length,
            },
            nextStatus: 'loaded',
        };
    }

    private async runRecipe(
        command: RecipeRunCommandWithId,
    ): Promise<CommandOutcome> {
        const recipe = command.recipe ?? this.loadedRecipe;
        if (!recipe) {
            throw new Error('No recipe is loaded.');
        }
        requireRecipeIsExecutable(recipe);

        this.cancelRequested = false;
        this.resetCancellationSignal();
        const deadlineEpochMs = this.commandDeadlineEpochMs(command);
        const results: RallarBlackBoxTestResult[] = [];
        this.recipeExecutionDepth += 1;
        try {
            for (const childCommand of recipe.commands) {
                if (this.cancelRequested) {
                    const outcome: CommandOutcome = {
                        status: 'cancelled',
                        value: {
                            recipeId: recipe.recipeId,
                            results,
                            cancelled: true,
                        },
                        nextStatus: 'cancelled',
                    };
                    await this.cleanupAfterTerminalRecipe(command, recipe, outcome);
                    return outcome;
                }

                if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                    const outcome: CommandOutcome = this.recipeTimedOut(command, recipe, results, deadlineEpochMs);
                    await this.cleanupAfterTerminalRecipe(command, recipe, outcome);
                    return outcome;
                }

                const result = await this.executeCommand(
                    this.toRecipeChildCommand(childCommand, deadlineEpochMs),
                    {
                        bypassCache: true,
                    },
                );
                results.push(result);

                if (this.cancelRequested || result.status === 'cancelled') {
                    const outcome: CommandOutcome = {
                        status: 'cancelled',
                        value: {
                            recipeId: recipe.recipeId,
                            results,
                            cancelled: true,
                        },
                        nextStatus: 'cancelled',
                    };
                    await this.cleanupAfterTerminalRecipe(command, recipe, outcome);
                    return outcome;
                }

                if (!result.ok && recipe.continueOnFailure !== true) {
                    const outcome: CommandOutcome = {
                        status: 'failed',
                        value: {
                            recipeId: recipe.recipeId,
                            results,
                        },
                        error: {
                            code: 'RALLAR_BLACK_BOX_RECIPE_FAILED',
                            message: `Recipe failed at command ${result.commandId}.`,
                            details: result.error,
                        },
                        nextStatus: 'failed',
                    };
                    await this.cleanupAfterTerminalRecipe(command, recipe, outcome);
                    return outcome;
                }
            }

            return {
                status: 'ok',
                value: {
                    recipeId: recipe.recipeId,
                    results,
                },
                nextStatus: 'completed',
            };
        } finally {
            this.recipeExecutionDepth -= 1;
        }
    }

    private toRecipeChildCommand(
        childCommand: RallarBlackBoxTestCommand,
        recipeDeadlineEpochMs: number | undefined,
    ): RallarBlackBoxTestCommand {
        if (recipeDeadlineEpochMs === undefined) {
            return childCommand;
        }

        return this.withBoundedDeadline(childCommand, recipeDeadlineEpochMs);
    }

    private recipeTimedOut(
        command: RecipeRunCommandWithId,
        recipe: RallarBlackBoxTestRecipe,
        results: readonly RallarBlackBoxTestResult[],
        deadlineEpochMs: number,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: {
                recipeId: recipe.recipeId,
                results,
                timedOut: true,
            },
            error: {
                code: 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT',
                message: 'Recipe reached its timeout before all commands completed.',
                details: {
                    timeoutMs: command.timeoutMs,
                    deadlineEpochMs,
                    completedCommands: results.length,
                    totalCommands: recipe.commands.length,
                },
            },
            nextStatus: 'failed',
        };
    }

    private async cleanupAfterTerminalRecipe(
        command: RecipeRunCommandWithId,
        recipe: RallarBlackBoxTestRecipe,
        outcome: CommandOutcome,
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
            error: outcome.error,
        });
    }

    private async runLoop(command: LoopCommandWithId): Promise<CommandOutcome> {
        if (!Array.isArray(command.commands) || command.commands.length === 0) {
            return this.loopInvalid(command, 'Loop requires at least one child command.');
        }

        const durationMs = command.durationMs === undefined
            ? undefined
            : positiveIntegerValue(command.durationMs);
        if (command.durationMs !== undefined && durationMs === undefined) {
            return this.loopInvalid(command, 'Loop durationMs must be a positive integer.', {
                durationMs: command.durationMs,
            });
        }
        if (
            durationMs !== undefined &&
            durationMs > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs
        ) {
            return this.loopInvalid(command, 'Loop durationMs exceeds the runtime maximum.', {
                durationMs,
                maxLoopDurationMs: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs,
            });
        }

        const count = command.count === undefined
            ? durationMs === undefined
                ? 1
                : RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount
            : positiveIntegerValue(command.count);
        if (count === undefined) {
            return this.loopInvalid(command, 'Loop count must be a positive integer.', {
                count: command.count,
            });
        }
        if (count > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount) {
            return this.loopInvalid(command, 'Loop count exceeds the runtime maximum.', {
                count,
                maxLoopCount: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount,
            });
        }

        const intervalSource = command.intervalMs ?? command.delayMs;
        const intervalMs = intervalSource === undefined
            ? 0
            : nonNegativeIntegerValue(intervalSource);
        if (intervalMs === undefined) {
            return this.loopInvalid(command, 'Loop intervalMs/delayMs must be a non-negative integer.', {
                intervalMs: command.intervalMs,
                delayMs: command.delayMs,
            });
        }

        const requestedMaxCommands = command.maxCommands === undefined
            ? RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands
            : positiveIntegerValue(command.maxCommands);
        if (requestedMaxCommands === undefined) {
            return this.loopInvalid(command, 'Loop maxCommands must be a positive integer.', {
                maxCommands: command.maxCommands,
            });
        }
        const maxCommands = Math.min(
            requestedMaxCommands,
            RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands,
        );
        const plannedCommandCount = count * command.commands.length;
        if (durationMs === undefined && plannedCommandCount > maxCommands) {
            return this.loopLimitExceeded(command, [], {
                plannedCommandCount,
                maxCommands,
            });
        }
        const thresholdValidationError = this.validateLoopThresholds(command);
        if (thresholdValidationError) {
            return this.loopInvalid(
                command,
                thresholdValidationError.message,
                thresholdValidationError.details,
            );
        }

        const loopStartedAtEpochMs = this.now();
        const deadlineEpochMs = this.commandDeadlineEpochMs(command);
        const results: RallarBlackBoxTestCompositeChildResult[] = [];
        const pacingIterations: RallarBlackBoxTestLoopPacingIteration[] = [];
        const toLoopMetrics = (
            thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[],
        ): LoopResultMetrics => ({
            intervalMs,
            count,
            durationMs,
            startedAtEpochMs: loopStartedAtEpochMs,
            endedAtEpochMs: this.now(),
            pacingIterations,
            thresholdFailures,
        });
        const toLoopValue = (
            cancelled: boolean,
            thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[],
        ) =>
            this.toLoopResultValue(command, results, cancelled, toLoopMetrics(thresholdFailures));

        for (let iterationIndex = 0; iterationIndex < count; iterationIndex++) {
            if (this.cancelRequested) {
                return {
                    status: 'cancelled',
                    value: toLoopValue(true),
                    nextStatus: 'cancelled',
                };
            }
            if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                return this.loopTimedOut(command, results, deadlineEpochMs, toLoopMetrics());
            }

            const elapsedBeforeIterationMs = Math.max(0, this.now() - loopStartedAtEpochMs);
            if (durationMs !== undefined && iterationIndex > 0 && elapsedBeforeIterationMs >= durationMs) {
                break;
            }

            const scheduledAtEpochMs = loopStartedAtEpochMs + (iterationIndex * intervalMs);
            const iterationStartedAtEpochMs = this.now();
            const iterationResultStartIndex = results.length;
            let recordedIteration = false;
            const recordIteration = (cancelled: boolean): void => {
                if (recordedIteration) {
                    return;
                }
                recordedIteration = true;
                const iterationResults = results.slice(iterationResultStartIndex);
                const endedAtEpochMs = this.now();
                pacingIterations.push({
                    iteration: iterationIndex + 1,
                    scheduledAtEpochMs,
                    startedAtEpochMs: iterationStartedAtEpochMs,
                    endedAtEpochMs,
                    durationMs: Math.max(0, endedAtEpochMs - iterationStartedAtEpochMs),
                    startDriftMs: Math.max(0, iterationStartedAtEpochMs - scheduledAtEpochMs),
                    commandCount: iterationResults.length,
                    passed: iterationResults.filter(result => result.result.ok).length,
                    failed: iterationResults.filter(result => !result.result.ok).length,
                    cancelled,
                });
            };

            for (let commandIndex = 0; commandIndex < command.commands.length; commandIndex++) {
                if (this.cancelRequested) {
                    recordIteration(true);
                    return {
                        status: 'cancelled',
                        value: toLoopValue(true),
                        nextStatus: 'cancelled',
                    };
                }
                if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                    recordIteration(false);
                    return this.loopTimedOut(command, results, deadlineEpochMs, toLoopMetrics());
                }

                if (results.length >= maxCommands) {
                    recordIteration(false);
                    return this.loopLimitExceeded(command, results, {
                        plannedCommandCount,
                        maxCommands,
                    }, toLoopMetrics());
                }

                const childTemplate = command.commands[commandIndex];
                const originalCommandId = childTemplate.commandId;
                const elapsedMs = Math.max(0, this.now() - loopStartedAtEpochMs);
                const loopContext: LoopContext = {
                    loopCommandId: command.commandId,
                    index: results.length,
                    iteration: iterationIndex + 1,
                    elapsedMs,
                    commandIndex,
                };
                const childCommand = this.toLoopChildCommand(
                    command,
                    childTemplate,
                    loopContext,
                    deadlineEpochMs,
                );
                const childResult = await this.executeCommand(childCommand, {
                    bypassCache: true,
                });
                results.push({
                    commandId: childResult.commandId,
                    originalCommandId,
                    parentCommandId: command.commandId,
                    path: rallarBlackBoxLoopChildResultPath(
                        RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                        iterationIndex + 1,
                        commandIndex,
                    ),
                    sourceRecipePath: rallarBlackBoxLoopChildSourceRecipePath(
                        RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                        commandIndex,
                    ),
                    childIndex: results.length,
                    commandIndex,
                    iteration: iterationIndex + 1,
                    result: childResult,
                });

                if (this.cancelRequested || childResult.status === 'cancelled') {
                    recordIteration(true);
                    return {
                        status: 'cancelled',
                        value: toLoopValue(true),
                        nextStatus: 'cancelled',
                    };
                }

                if (!childResult.ok && command.continueOnFailure !== true) {
                    recordIteration(false);
                    return {
                        status: 'failed',
                        value: toLoopValue(false),
                        error: {
                            code: 'RALLAR_BLACK_BOX_LOOP_CHILD_FAILED',
                            message: `Loop failed at child command ${childResult.commandId}.`,
                            details: childResult.error,
                        },
                        nextStatus: 'failed',
                    };
                }
            }

            recordIteration(false);

            if (iterationIndex + 1 >= count) {
                break;
            }

            const elapsedAfterIterationMs = Math.max(0, this.now() - loopStartedAtEpochMs);
            if (durationMs !== undefined && elapsedAfterIterationMs >= durationMs) {
                break;
            }
            if (intervalMs > 0) {
                const deadlineDelayMs = deadlineEpochMs === undefined
                    ? intervalMs
                    : Math.max(0, Math.min(intervalMs, deadlineEpochMs - this.now()));
                try {
                    await this.sleep(deadlineDelayMs, this.cancellationController.signal);
                } catch (error) {
                    if (isAbortError(error)) {
                        return {
                            status: 'cancelled',
                            value: toLoopValue(true),
                            nextStatus: 'cancelled',
                        };
                    }
                    throw error;
                }
                if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                    return this.loopTimedOut(command, results, deadlineEpochMs, toLoopMetrics());
                }
            }
        }

        const value = toLoopValue(false);
        const thresholdFailures = this.evaluateLoopThresholds(command, value);
        if (thresholdFailures.length > 0) {
            return {
                status: 'failed',
                value: {
                    ...value,
                    thresholdFailures,
                },
                error: {
                    code: 'RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED',
                    message: 'Loop did not satisfy configured pacing or send thresholds.',
                    details: {
                        thresholdFailures,
                    },
                },
                nextStatus: 'failed',
            };
        }

        return {
            status: 'ok',
            value,
            nextStatus: 'completed',
        };
    }

    private toLoopChildCommand(
        command: LoopCommandWithId,
        childCommand: RallarBlackBoxTestCommand,
        context: LoopContext,
        deadlineEpochMs: number | undefined,
    ): RallarBlackBoxTestCommand {
        const resolved = replaceLoopPlaceholders(childCommand, context) as RallarBlackBoxTestCommand;
        const child = {
            ...resolved,
            commandId: [
                command.commandId,
                `i${context.iteration}`,
                `c${context.commandIndex + 1}`,
                commandLabelForId(childCommand, context.commandIndex + 1),
            ].join(':'),
            metadata: {
                ...asRecord(resolved.metadata),
                loop: {
                    commandId: context.loopCommandId,
                    index: context.index,
                    iteration: context.iteration,
                    elapsedMs: context.elapsedMs,
                    commandIndex: context.commandIndex,
                    originalCommandId: childCommand.commandId,
                },
            },
        } as RallarBlackBoxTestCommand;

        return deadlineEpochMs === undefined
            ? child
            : this.withBoundedDeadline(child, deadlineEpochMs);
    }

    private toLoopResultValue(
        command: LoopCommandWithId,
        results: readonly RallarBlackBoxTestCompositeChildResult[],
        cancelled: boolean,
        metrics?: LoopResultMetrics,
    ): RallarBlackBoxTestLoopResultValue {
        const iterations = new Set(
            results
                .map(result => result.iteration)
                .filter((iteration): iteration is number => iteration !== undefined),
        ).size;
        const pacing = metrics
            ? this.toLoopPacingSummary(metrics)
            : undefined;
        const sends = this.toLoopSendSummary(results);
        return {
            commandId: command.commandId,
            iterations,
            childResultCount: results.length,
            passed: results.filter(result => result.result.ok).length,
            failed: results.filter(result => !result.result.ok).length,
            cancelled,
            pacing,
            sends,
            thresholdFailures: metrics?.thresholdFailures,
            results,
        };
    }

    private toLoopPacingSummary(metrics: LoopResultMetrics): RallarBlackBoxTestLoopPacingSummary {
        const iterations = [...metrics.pacingIterations];
        const driftValues = iterations.map(iteration => iteration.startDriftMs);
        const jitterValues = iterations
            .slice(1)
            .map((iteration, index) =>
                Math.abs(iteration.startDriftMs - iterations[index].startDriftMs)
            );
        const elapsedMs = Math.max(0, metrics.endedAtEpochMs - metrics.startedAtEpochMs);
        const completedIterations = iterations.length;
        const plannedIterations = metrics.durationMs === undefined
            ? metrics.count
            : completedIterations;
        const targetElapsedMs = Math.max(0, (completedIterations - 1) * metrics.intervalMs);
        const achievedRateHz = completedIterations > 1 && elapsedMs > 0
            ? roundedMetric(((completedIterations - 1) * 1000) / elapsedMs)
            : undefined;
        const requestedRateHz = metrics.intervalMs > 0
            ? roundedMetric(1000 / metrics.intervalMs)
            : undefined;
        const lateThresholdMs = Math.max(1, Math.round(Math.max(metrics.intervalMs, 1) * 0.5));

        return {
            requestedIntervalMs: metrics.intervalMs,
            requestedRateHz,
            plannedIterations,
            completedIterations,
            skippedIterations: Math.max(0, plannedIterations - completedIterations),
            cancelledIterations: iterations.filter(iteration => iteration.cancelled).length,
            startedAtEpochMs: metrics.startedAtEpochMs,
            endedAtEpochMs: metrics.endedAtEpochMs,
            elapsedMs,
            targetElapsedMs,
            achievedRateHz,
            averageIterationDurationMs: average(iterations.map(iteration => iteration.durationMs)),
            minStartDriftMs: driftValues.length > 0 ? Math.min(...driftValues) : undefined,
            maxStartDriftMs: driftValues.length > 0 ? Math.max(...driftValues) : undefined,
            averageStartDriftMs: average(driftValues),
            maxJitterMs: jitterValues.length > 0 ? Math.max(...jitterValues) : undefined,
            averageJitterMs: average(jitterValues),
            lateIterationCount: driftValues.filter(value => value > lateThresholdMs).length,
            lateThresholdMs,
            iterations,
        };
    }

    private toLoopSendSummary(
        results: readonly RallarBlackBoxTestCompositeChildResult[],
    ): RallarBlackBoxTestLoopSendSummary {
        const observations = results
            .map(result => this.toSendObservation(result.result))
            .filter((observation): observation is RallarBlackBoxTestSendObservation => observation !== undefined);
        const durations = observations.map(observation => observation.durationMs);
        const succeeded = observations.filter(observation => observation.ok).length;
        const failed = observations.length - succeeded;
        const perTransportFailureCounts = observations.reduce<Record<string, number>>((counts, observation) => {
            if (observation.ok) {
                return counts;
            }
            const key = observation.transport ?? observation.kind;
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
        }, {});

        return {
            sendCount: observations.length,
            succeeded,
            failed,
            successRatio: observations.length > 0
                ? roundedMetric(succeeded / observations.length)
                : undefined,
            duration: durations.length > 0
                ? {
                    minMs: Math.min(...durations),
                    maxMs: Math.max(...durations),
                    averageMs: average(durations),
                    totalMs: durations.reduce((sum, value) => sum + value, 0),
                }
                : undefined,
            queuedCount: observations.filter(observation => observation.queued).length,
            enqueuedCount: observations.filter(observation => observation.enqueued).length,
            backpressureCount: observations.filter(observation => observation.backpressured).length,
            droppedPayloadCount: observations.reduce(
                (sum, observation) => sum + (observation.droppedPayloadCount ?? 0),
                0,
            ),
            replacedPayloadCount: observations.reduce(
                (sum, observation) => sum + (observation.replacedPayloadCount ?? 0),
                0,
            ),
            perTransportFailureCounts,
            observations,
        };
    }

    private toSendObservation(
        result: RallarBlackBoxTestResult,
    ): RallarBlackBoxTestSendObservation | undefined {
        if (result.kind !== 'rtc.send' && result.kind !== 'ws.send') {
            return undefined;
        }

        const root = asRecord(result.value);
        const explicitObservation = asRecord(root.sendObservation);
        const diagnostics = root.diagnostics !== undefined
            ? asRecord(root.diagnostics)
            : root;
        const message = asRecord(diagnostics.message);
        const status = firstDefined(
            stringValue(explicitObservation.status),
            stringValue(diagnostics.status),
            stringValue(message.status),
            stringValue(root.status),
        );
        const transport = result.kind === 'ws.send'
            ? 'ws'
            : transportValue(root.transport);
        const observationTransport = firstDefined(
            transportValue(explicitObservation.transport),
            transportValue(root.transport),
        );
        const droppedPayloadCount = firstDefined(
            finiteNumberValue(explicitObservation.droppedPayloadCount),
            finiteNumberValue(diagnostics.droppedPayloadCount),
            finiteNumberValue(root.droppedPayloadCount),
            this.countRtcSendPeerStatuses(diagnostics, 'dropped'),
        );
        const replacedPayloadCount = firstDefined(
            finiteNumberValue(explicitObservation.replacedPayloadCount),
            finiteNumberValue(diagnostics.replacedPayloadCount),
            finiteNumberValue(root.replacedPayloadCount),
        );
        const queued = firstDefined(
            booleanValue(explicitObservation.queued),
            status === 'queued' || status === 'buffered',
        );
        const enqueued = firstDefined(
            booleanValue(explicitObservation.enqueued),
            status === 'enqueued',
        );
        const backpressured = firstDefined(
            booleanValue(explicitObservation.backpressured),
            status === 'backpressure' ||
                status === 'backpressured' ||
                status === 'rate-limited' ||
                status === 'buffer-full' ||
                status === 'circuit-open',
        );

        return {
            commandId: result.commandId,
            kind: result.kind,
            transport: observationTransport ?? transport,
            durationMs: finiteNumberValue(explicitObservation.durationMs) ?? result.durationMs,
            ok: result.ok,
            status,
            queued,
            enqueued,
            backpressured,
            droppedPayloadCount,
            replacedPayloadCount,
            errorCode: result.error?.code,
        };
    }

    private countRtcSendPeerStatuses(diagnostics: Record<string, unknown>, status: string): number | undefined {
        if (!Array.isArray(diagnostics.results)) {
            return undefined;
        }

        const count = diagnostics.results.filter((entry) => {
            const result = asRecord(asRecord(entry).result);
            return result.status === status;
        }).length;
        return count > 0 ? count : undefined;
    }

    private evaluateLoopThresholds(
        command: LoopCommandWithId,
        value: RallarBlackBoxTestLoopResultValue,
    ): readonly RallarBlackBoxTestLoopThresholdFailure[] {
        const thresholds = command.thresholds;
        if (!thresholds) {
            return [];
        }

        const failures: RallarBlackBoxTestLoopThresholdFailure[] = [];
        const pacing = value.pacing;
        const sends = value.sends;
        if (
            thresholds.minAchievedRateHz !== undefined &&
            pacing?.achievedRateHz !== undefined &&
            pacing.achievedRateHz < thresholds.minAchievedRateHz
        ) {
            failures.push({
                name: 'minAchievedRateHz',
                category: 'pacing',
                threshold: thresholds.minAchievedRateHz,
                actual: pacing.achievedRateHz,
                message: `Loop achieved ${pacing.achievedRateHz} Hz, below the configured ${thresholds.minAchievedRateHz} Hz minimum.`,
            });
        }
        if (
            thresholds.maxAverageStartDriftMs !== undefined &&
            pacing?.averageStartDriftMs !== undefined &&
            pacing.averageStartDriftMs > thresholds.maxAverageStartDriftMs
        ) {
            failures.push({
                name: 'maxAverageStartDriftMs',
                category: 'pacing',
                threshold: thresholds.maxAverageStartDriftMs,
                actual: pacing.averageStartDriftMs,
                message: `Average loop start drift was ${pacing.averageStartDriftMs} ms, above the configured ${thresholds.maxAverageStartDriftMs} ms maximum.`,
            });
        }
        if (
            thresholds.maxStartDriftMs !== undefined &&
            pacing?.maxStartDriftMs !== undefined &&
            pacing.maxStartDriftMs > thresholds.maxStartDriftMs
        ) {
            failures.push({
                name: 'maxStartDriftMs',
                category: 'pacing',
                threshold: thresholds.maxStartDriftMs,
                actual: pacing.maxStartDriftMs,
                message: `Maximum loop start drift was ${pacing.maxStartDriftMs} ms, above the configured ${thresholds.maxStartDriftMs} ms maximum.`,
            });
        }
        if (
            thresholds.maxJitterMs !== undefined &&
            pacing?.maxJitterMs !== undefined &&
            pacing.maxJitterMs > thresholds.maxJitterMs
        ) {
            failures.push({
                name: 'maxJitterMs',
                category: 'pacing',
                threshold: thresholds.maxJitterMs,
                actual: pacing.maxJitterMs,
                message: `Maximum loop jitter was ${pacing.maxJitterMs} ms, above the configured ${thresholds.maxJitterMs} ms maximum.`,
            });
        }
        if (
            thresholds.minSendSuccessRatio !== undefined &&
            sends?.successRatio !== undefined &&
            sends.successRatio < thresholds.minSendSuccessRatio
        ) {
            failures.push({
                name: 'minSendSuccessRatio',
                category: 'delivery',
                threshold: thresholds.minSendSuccessRatio,
                actual: sends.successRatio,
                message: `Loop send success ratio was ${sends.successRatio}, below the configured ${thresholds.minSendSuccessRatio} minimum.`,
            });
        }
        if (
            thresholds.failOnBackpressure === true &&
            sends !== undefined &&
            (sends.backpressureCount > 0 || sends.droppedPayloadCount > 0 || sends.replacedPayloadCount > 0)
        ) {
            failures.push({
                name: 'failOnBackpressure',
                category: 'backpressure',
                threshold: true,
                actual: true,
                message: 'Loop observed send backpressure, dropped payloads, or replaced payloads.',
            });
        }

        return failures;
    }

    private validateLoopThresholds(
        command: LoopCommandWithId,
    ): Readonly<{ message: string; details: unknown }> | undefined {
        if (command.thresholds === undefined) {
            return undefined;
        }
        if (!command.thresholds || typeof command.thresholds !== 'object' || Array.isArray(command.thresholds)) {
            return {
                message: 'Loop thresholds must be an object.',
                details: {
                    thresholds: command.thresholds,
                },
            };
        }

        const thresholds = asRecord(command.thresholds);

        const nonNegativeNumbers = [
            'minAchievedRateHz',
            'maxAverageStartDriftMs',
            'maxStartDriftMs',
            'maxJitterMs',
        ];
        for (const key of nonNegativeNumbers) {
            const value = thresholds[key];
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
                return {
                    message: 'Loop threshold values must be non-negative finite numbers.',
                    details: {
                        threshold: key,
                        value,
                    },
                };
            }
        }

        const minSendSuccessRatio = thresholds.minSendSuccessRatio;
        if (
            minSendSuccessRatio !== undefined &&
            (
                typeof minSendSuccessRatio !== 'number' ||
                !Number.isFinite(minSendSuccessRatio) ||
                minSendSuccessRatio < 0 ||
                minSendSuccessRatio > 1
            )
        ) {
            return {
                message: 'Loop minSendSuccessRatio threshold must be between 0 and 1.',
                details: {
                    threshold: 'minSendSuccessRatio',
                    value: minSendSuccessRatio,
                },
            };
        }

        if (
            thresholds.failOnBackpressure !== undefined &&
            typeof thresholds.failOnBackpressure !== 'boolean'
        ) {
            return {
                message: 'Loop failOnBackpressure threshold must be a boolean.',
                details: {
                    threshold: 'failOnBackpressure',
                    value: thresholds.failOnBackpressure,
                },
            };
        }

        return undefined;
    }

    private loopInvalid(
        command: LoopCommandWithId,
        message: string,
        details?: unknown,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: this.toLoopResultValue(command, [], false),
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_INVALID',
                message,
                details,
            },
            nextStatus: 'failed',
        };
    }

    private loopLimitExceeded(
        command: LoopCommandWithId,
        results: readonly RallarBlackBoxTestCompositeChildResult[],
        details: unknown,
        metrics?: LoopResultMetrics,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: this.toLoopResultValue(command, results, false, metrics),
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED',
                message: 'Loop would exceed the configured maximum child command count.',
                details,
            },
            nextStatus: 'failed',
        };
    }

    private loopTimedOut(
        command: LoopCommandWithId,
        results: readonly RallarBlackBoxTestCompositeChildResult[],
        deadlineEpochMs: number,
        metrics?: LoopResultMetrics,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: this.toLoopResultValue(command, results, false, metrics),
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_TIMEOUT',
                message: 'Loop reached its timeout before all iterations completed.',
                details: {
                    timeoutMs: command.timeoutMs,
                    deadlineEpochMs,
                    completedCommands: results.length,
                },
            },
            nextStatus: 'failed',
        };
    }

    private async runParallel(command: ParallelCommandWithId): Promise<CommandOutcome> {
        if (!Array.isArray(command.groups) || command.groups.length === 0) {
            return this.parallelInvalid(command, 'Parallel requires at least one group.');
        }
        const emptyGroupIndex = command.groups.findIndex(group =>
            !Array.isArray(group.commands) || group.commands.length === 0
        );
        if (emptyGroupIndex >= 0) {
            return this.parallelInvalid(command, 'Parallel groups require at least one child command.', {
                groupIndex: emptyGroupIndex,
                groupId: command.groups[emptyGroupIndex]?.groupId,
            });
        }

        const requestedConcurrency = command.maxConcurrency === undefined
            ? Math.min(command.groups.length, RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency)
            : positiveIntegerValue(command.maxConcurrency);
        if (requestedConcurrency === undefined) {
            return this.parallelInvalid(command, 'Parallel maxConcurrency must be a positive integer.', {
                maxConcurrency: command.maxConcurrency,
            });
        }
        if (requestedConcurrency > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency) {
            return this.parallelInvalid(command, 'Parallel maxConcurrency exceeds the runtime maximum.', {
                maxConcurrency: requestedConcurrency,
                maxParallelConcurrency: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency,
            });
        }
        const maxConcurrency = Math.max(1, Math.min(requestedConcurrency, command.groups.length));
        const deadlineEpochMs = this.parallelDeadlineEpochMs(command);
        const groupResults = new Array<ParallelGroupExecution | undefined>(command.groups.length);
        let nextGroupIndex = 0;
        let firstFailedResult: RallarBlackBoxTestResult | undefined;
        let timedOut = false;

        const shouldStopScheduling = (): boolean => {
            if (this.cancelRequested) {
                return true;
            }
            if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                timedOut = true;
                return true;
            }
            return firstFailedResult !== undefined &&
                command.failFast !== false &&
                command.continueOnFailure !== true;
        };

        const worker = async (): Promise<void> => {
            while (true) {
                if (shouldStopScheduling()) {
                    return;
                }
                const groupIndex = nextGroupIndex;
                nextGroupIndex += 1;
                if (groupIndex >= command.groups.length) {
                    return;
                }

                const groupExecution = await this.runParallelGroup(
                    command,
                    command.groups[groupIndex],
                    groupIndex,
                    deadlineEpochMs,
                );
                groupResults[groupIndex] = groupExecution;
                if (groupExecution.timedOut) {
                    timedOut = true;
                }
                if (!firstFailedResult && groupExecution.failedResult) {
                    firstFailedResult = groupExecution.failedResult;
                }
            }
        };

        await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));

        const cancelled = this.cancelRequested ||
            groupResults.some(result => result?.cancelled === true);
        const completeGroupResults = command.groups.map((group, index) =>
            groupResults[index]?.result ??
            this.emptyParallelGroupResult(command, group, index, cancelled && index >= nextGroupIndex)
        );
        const value = this.toParallelResultValue(command, completeGroupResults, maxConcurrency, cancelled);

        if (cancelled) {
            return {
                status: 'cancelled',
                value,
                nextStatus: 'cancelled',
            };
        }

        if (timedOut) {
            return {
                status: 'failed',
                value,
                error: {
                    code: 'RALLAR_BLACK_BOX_PARALLEL_TIMEOUT',
                    message: 'Parallel command reached its timeout before all groups completed.',
                    details: {
                        timeoutMs: command.timeoutMs,
                        deadlineEpochMs: command.deadlineEpochMs,
                        completedGroups: completeGroupResults.filter(result => result.commandCount > 0).length,
                        totalGroups: command.groups.length,
                    },
                },
                nextStatus: 'failed',
            };
        }

        if (value.failed > 0 && command.continueOnFailure !== true) {
            return {
                status: 'failed',
                value,
                error: {
                    code: 'RALLAR_BLACK_BOX_PARALLEL_CHILD_FAILED',
                    message: firstFailedResult
                        ? `Parallel failed at child command ${firstFailedResult.commandId}.`
                        : 'Parallel completed with failed child commands.',
                    details: {
                        firstFailure: firstFailedResult?.error,
                        failedGroups: completeGroupResults
                            .filter(result => result.failed > 0)
                            .map(result => result.groupId),
                    },
                },
                nextStatus: 'failed',
            };
        }

        return {
            status: 'ok',
            value,
            nextStatus: 'completed',
        };
    }

    private async runParallelGroup(
        command: ParallelCommandWithId,
        group: RallarBlackBoxTestParallelGroup,
        groupIndex: number,
        deadlineEpochMs: number | undefined,
    ): Promise<ParallelGroupExecution> {
        const groupStartedAtEpochMs = this.now();
        const groupId = group.groupId ?? `group-${groupIndex + 1}`;
        const results: RallarBlackBoxTestCompositeChildResult[] = [];
        let failedResult: RallarBlackBoxTestResult | undefined;
        let cancelled = false;
        let timedOut = false;

        for (let commandIndex = 0; commandIndex < group.commands.length; commandIndex++) {
            if (this.cancelRequested) {
                cancelled = true;
                break;
            }
            if (deadlineEpochMs !== undefined && this.now() >= deadlineEpochMs) {
                timedOut = true;
                break;
            }

            const childTemplate = group.commands[commandIndex];
            const originalCommandId = childTemplate.commandId;
            const parallelContext: ParallelContext = {
                parallelCommandId: command.commandId,
                groupId,
                groupIndex,
                commandIndex,
            };
            const childCommand = this.toParallelChildCommand(
                command,
                group,
                childTemplate,
                parallelContext,
                deadlineEpochMs,
            );
            const childResult = await this.executeCommand(childCommand, {
                bypassCache: true,
            });
            results.push({
                commandId: childResult.commandId,
                originalCommandId,
                parentCommandId: command.commandId,
                path: rallarBlackBoxParallelChildResultPath(
                    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                    groupIndex,
                    groupId,
                    commandIndex,
                ),
                sourceRecipePath: rallarBlackBoxParallelChildSourceRecipePath(
                    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                    groupIndex,
                    commandIndex,
                ),
                childIndex: results.length,
                commandIndex,
                groupId,
                groupIndex,
                result: childResult,
            });

            if (this.cancelRequested || childResult.status === 'cancelled') {
                cancelled = true;
                break;
            }
            if (!childResult.ok) {
                failedResult = childResult;
                if (command.continueOnFailure !== true) {
                    break;
                }
            }
        }

        const durationMs = Math.max(0, this.now() - groupStartedAtEpochMs);
        return {
            result: {
                groupId,
                commandCount: results.length,
                passed: results.filter(result => result.result.ok).length,
                failed: results.filter(result => !result.result.ok).length,
                cancelled,
                durationMs,
                results,
            },
            failedResult,
            cancelled,
            timedOut,
        };
    }

    private toParallelChildCommand(
        command: ParallelCommandWithId,
        group: RallarBlackBoxTestParallelGroup,
        childCommand: RallarBlackBoxTestCommand,
        context: ParallelContext,
        deadlineEpochMs: number | undefined,
    ): RallarBlackBoxTestCommand {
        const child = {
            ...childCommand,
            commandId: [
                command.commandId,
                `g${context.groupIndex + 1}`,
                groupLabelForId(group, context.groupIndex + 1),
                `c${context.commandIndex + 1}`,
                commandLabelForId(childCommand, context.commandIndex + 1),
            ].join(':'),
            metadata: {
                ...asRecord(childCommand.metadata),
                parallel: {
                    commandId: context.parallelCommandId,
                    groupId: context.groupId,
                    groupIndex: context.groupIndex,
                    commandIndex: context.commandIndex,
                    originalCommandId: childCommand.commandId,
                },
            },
        } as RallarBlackBoxTestCommand;

        return deadlineEpochMs === undefined
            ? child
            : this.withBoundedDeadline(child, deadlineEpochMs);
    }

    private toParallelResultValue(
        command: ParallelCommandWithId,
        groups: readonly RallarBlackBoxTestParallelGroupResult[],
        maxConcurrency: number,
        cancelled: boolean,
    ): RallarBlackBoxTestParallelResultValue {
        return {
            commandId: command.commandId,
            groupCount: groups.length,
            maxConcurrency,
            passed: groups.reduce((sum, group) => sum + group.passed, 0),
            failed: groups.reduce((sum, group) => sum + group.failed, 0),
            cancelled,
            groups,
        };
    }

    private emptyParallelGroupResult(
        _command: ParallelCommandWithId,
        group: RallarBlackBoxTestParallelGroup,
        groupIndex: number,
        cancelled: boolean,
    ): RallarBlackBoxTestParallelGroupResult {
        return {
            groupId: group.groupId ?? `group-${groupIndex + 1}`,
            commandCount: 0,
            passed: 0,
            failed: 0,
            cancelled,
            durationMs: 0,
            results: [],
        };
    }

    private parallelDeadlineEpochMs(command: ParallelCommandWithId): number | undefined {
        const timeoutDeadline = command.timeoutMs === undefined
            ? undefined
            : this.now() + Math.max(0, command.timeoutMs);
        return command.deadlineEpochMs === undefined
            ? timeoutDeadline
            : timeoutDeadline === undefined
                ? command.deadlineEpochMs
                : Math.min(timeoutDeadline, command.deadlineEpochMs);
    }

    private parallelInvalid(
        command: ParallelCommandWithId,
        message: string,
        details?: unknown,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: this.toParallelResultValue(command, [], 0, false),
            error: {
                code: 'RALLAR_BLACK_BOX_PARALLEL_INVALID',
                message,
                details,
            },
            nextStatus: 'failed',
        };
    }

    private async waitForEvent(command: WaitCommandWithId): Promise<CommandOutcome> {
        if (!command.match || Object.keys(command.match).length === 0) {
            return this.waitInvalid(command, 'Wait requires at least one match field.');
        }

        if (this.cancelRequested) {
            return this.waitCancelled(command);
        }

        const immediate = this.findWaitEvent(command.match);
        if (immediate) {
            return this.waitMatched(command, immediate);
        }

        const deadlineEpochMs = this.waitDeadlineEpochMs(command);
        if (this.now() >= deadlineEpochMs) {
            return this.waitTimedOut(command, deadlineEpochMs);
        }

        return await new Promise<CommandOutcome>((resolve) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe: (() => void) | undefined;
            let cleanupAfterSubscribe = false;
            const signal = this.cancellationController.signal;

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = undefined;
                }
                signal.removeEventListener('abort', onAbort);
                if (unsubscribe) {
                    unsubscribe();
                    unsubscribe = undefined;
                } else {
                    cleanupAfterSubscribe = true;
                }
            };

            const settle = (outcome: CommandOutcome) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(outcome);
            };

            const evaluate = () => {
                if (this.cancelRequested) {
                    settle(this.waitCancelled(command));
                    return;
                }

                const matched = this.findWaitEvent(command.match);
                if (matched) {
                    settle(this.waitMatched(command, matched));
                    return;
                }

                if (this.now() >= deadlineEpochMs) {
                    settle(this.waitTimedOut(command, deadlineEpochMs));
                }
            };

            const timeoutDelayMs = Math.max(0, deadlineEpochMs - this.now());
            const onAbort = () => {
                settle(this.waitCancelled(command));
            };
            if (signal.aborted) {
                settle(this.waitCancelled(command));
                return;
            }
            timeout = setTimeout(() => {
                settle(this.waitTimedOut(command, deadlineEpochMs));
            }, timeoutDelayMs);
            signal.addEventListener('abort', onAbort, {
                once: true,
            });
            unsubscribe = this.subscribe(evaluate);
            if (cleanupAfterSubscribe && unsubscribe) {
                unsubscribe();
                unsubscribe = undefined;
            }
        });
    }

    private findWaitEvent(match: RallarBlackBoxTestWaitMatch): RallarBlackBoxTestEvent | undefined {
        const events = this.currentState.events;
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (this.waitEventMatches(event, match)) {
                return event;
            }
        }
        return undefined;
    }

    private waitEventMatches(
        event: RallarBlackBoxTestEvent,
        match: RallarBlackBoxTestWaitMatch,
    ): boolean {
        if (match.kind !== undefined && event.kind !== match.kind) {
            return false;
        }
        if (match.topic !== undefined && event.topic !== match.topic) {
            return false;
        }
        if (match.commandId !== undefined && event.commandId !== match.commandId) {
            return false;
        }
        if (match.connection !== undefined && event.connection !== match.connection) {
            return false;
        }
        if (match.transport !== undefined && event.transport !== match.transport) {
            return false;
        }
        if (match.severity !== undefined && event.severity !== match.severity) {
            return false;
        }

        if (
            match.payloadPath !== undefined ||
            match.equals !== undefined ||
            match.contains !== undefined ||
            match.exists !== undefined
        ) {
            const lookup = lookupPayloadPath(event.payload, match.payloadPath);
            if (match.exists !== undefined && lookup.exists !== match.exists) {
                return false;
            }
            if (match.exists !== false && !lookup.exists) {
                return false;
            }
            if (match.equals !== undefined && !sameJsonValue(lookup.value, match.equals)) {
                return false;
            }
            if (match.contains !== undefined && !containsValue(lookup.value, match.contains)) {
                return false;
            }
        }

        return true;
    }

    private waitDeadlineEpochMs(command: WaitCommandWithId): number {
        const timeoutMs = command.timeoutMs === undefined
            ? command.deadlineEpochMs === undefined
                ? DEFAULT_WAIT_TIMEOUT_MS
                : undefined
            : Math.max(0, command.timeoutMs);
        const timeoutDeadline = timeoutMs === undefined
            ? undefined
            : this.now() + timeoutMs;

        if (command.deadlineEpochMs === undefined) {
            return timeoutDeadline ?? (this.now() + DEFAULT_WAIT_TIMEOUT_MS);
        }

        return timeoutDeadline === undefined
            ? command.deadlineEpochMs
            : Math.min(timeoutDeadline, command.deadlineEpochMs);
    }

    private toWaitResultValue(
        command: WaitCommandWithId,
        partial: Readonly<{
            matched: boolean;
            timedOut?: boolean;
            cancelled?: boolean;
            event?: RallarBlackBoxTestEvent;
        }>,
    ): RallarBlackBoxTestWaitResultValue {
        return {
            commandId: command.commandId,
            match: command.match,
            ...partial,
        };
    }

    private waitMatched(
        command: WaitCommandWithId,
        event: RallarBlackBoxTestEvent,
    ): CommandOutcome {
        return {
            status: 'ok',
            value: this.toWaitResultValue(command, {
                matched: true,
                event,
            }),
            nextStatus: this.currentState.status,
        };
    }

    private waitTimedOut(
        command: WaitCommandWithId,
        deadlineEpochMs: number,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: this.toWaitResultValue(command, {
                matched: false,
                timedOut: true,
            }),
            error: {
                code: 'RALLAR_BLACK_BOX_WAIT_TIMEOUT',
                message: 'Wait command timed out before matching a runtime event.',
                details: {
                    timeoutMs: command.timeoutMs,
                    deadlineEpochMs,
                    match: command.match,
                },
            },
            nextStatus: 'failed',
        };
    }

    private waitCancelled(command: WaitCommandWithId): CommandOutcome {
        return {
            status: 'cancelled',
            value: this.toWaitResultValue(command, {
                matched: false,
                cancelled: true,
            }),
            nextStatus: 'cancelled',
        };
    }

    private waitInvalid(
        command: WaitCommandWithId,
        message: string,
        details?: unknown,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: this.toWaitResultValue(command, {
                matched: false,
            }),
            error: {
                code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
                message,
                details,
            },
            nextStatus: 'failed',
        };
    }

    private assertRuntimeEvidence(command: AssertCommandWithId): CommandOutcome {
        if (typeof command.source !== 'string' || command.source.trim().length === 0) {
            return this.assertInvalid(command, 'Assert requires a non-empty source.');
        }
        if (!this.isAssertOperator(command.operator)) {
            return this.assertInvalid(command, 'Assert operator is not supported.', {
                operator: command.operator,
                supportedOperators: ASSERT_OPERATORS,
            });
        }

        const source = this.resolveAssertSource(command.source);
        const passed = this.assertValueMatches(
            source,
            command.operator,
            command.expected,
        );
        const value = this.toAssertResultValue(command, source, passed);

        if (passed) {
            return {
                status: 'ok',
                value,
                nextStatus: this.currentState.status,
            };
        }

        return {
            status: 'failed',
            value,
            error: {
                code: 'RALLAR_BLACK_BOX_ASSERT_FAILED',
                message: `Assert failed for ${command.source}.`,
                details: value,
            },
            nextStatus: 'failed',
        };
    }

    private isAssertOperator(value: unknown): value is RallarBlackBoxTestAssertOperator {
        return typeof value === 'string' &&
            ASSERT_OPERATORS.includes(value as RallarBlackBoxTestAssertOperator);
    }

    private resolveAssertSource(source: string): PayloadPathLookup {
        const trimmed = source.trim();
        const [rootName, ...pathParts] = trimmed.split('.').filter(part => part.length > 0);
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
                value: root,
            };
        }

        return lookupPayloadPath(root, pathParts.join('.'));
    }

    private toAssertSourceRoots(): Record<string, unknown> {
        const events = this.currentState.events;
        const messages = events.filter(event => event.kind === 'message');
        const diagnostics = events.filter(event => event.kind === 'diagnostic');
        const reports = events.filter(event => event.kind === 'report');
        const results = this.currentState.commandHistory;
        const stateView = {
            ...this.currentState,
            results,
            messages,
            diagnostics,
            reports,
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
            resultCache: this.currentState.resultCache,
        };
    }

    private assertValueMatches(
        source: PayloadPathLookup,
        operator: RallarBlackBoxTestAssertOperator,
        expected: unknown,
    ): boolean {
        switch (operator) {
            case 'equals':
                return source.exists && sameJsonValue(source.value, expected);
            case 'notEquals':
                return !source.exists || !sameJsonValue(source.value, expected);
            case 'contains':
                return source.exists && containsAssertValue(source.value, expected);
            case 'exists':
                return expected === undefined
                    ? source.exists
                    : source.exists === Boolean(expected);
            case 'gte':
                return source.exists &&
                    typeof source.value === 'number' &&
                    typeof expected === 'number' &&
                    source.value >= expected;
            case 'lte':
                return source.exists &&
                    typeof source.value === 'number' &&
                    typeof expected === 'number' &&
                    source.value <= expected;
        }
    }

    private toAssertResultValue(
        command: AssertCommandWithId,
        source: PayloadPathLookup,
        passed: boolean,
    ): RallarBlackBoxTestAssertResultValue {
        return {
            commandId: command.commandId,
            source: command.source,
            operator: command.operator,
            expected: command.expected,
            actual: source.value,
            exists: source.exists,
            passed,
        };
    }

    private assertInvalid(
        command: AssertCommandWithId,
        message: string,
        details?: unknown,
    ): CommandOutcome {
        return {
            status: 'failed',
            value: {
                commandId: command.commandId,
                source: command.source,
                operator: command.operator,
                expected: command.expected,
                exists: false,
                passed: false,
            } satisfies RallarBlackBoxTestAssertResultValue,
            error: {
                code: 'RALLAR_BLACK_BOX_ASSERT_INVALID',
                message,
                details,
            },
            nextStatus: 'failed',
        };
    }

    private async cancelRecipe(command: Extract<CommandWithId, { kind: 'recipe.cancel' }>): Promise<CommandOutcome> {
        this.requestCancellation(command.reason);
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.recipe.cancel_requested',
            commandId: command.commandId,
            severity: 'warning',
            payload: {
                reason: command.reason,
            },
        });
        if (this.recipeExecutionDepth === 0) {
            await this.cleanupOwnedResources({
                reason: 'cancelled',
                commandId: command.commandId,
                status: 'cancelled',
            });
        }
        return {
            status: 'ok',
            value: {
                cancelRequested: true,
                reason: command.reason,
            },
            nextStatus: this.currentState.status === 'running'
                ? 'cancelled'
                : this.currentState.status,
        };
    }

    private fakeCommand(command: CommandWithId): CommandOutcome {
        this.emitEvent({
            kind: 'diagnostic',
            topic: `rallar.bb.fake.${command.kind}`,
            commandId: command.commandId,
            severity: 'info',
            payload: {
                command: this.redact(command),
            },
        });
        return {
            status: 'ok',
            value: {
                fake: true,
                kind: command.kind,
                commandId: command.commandId,
            },
            nextStatus: this.currentState.status,
        };
    }

    private toResult(
        command: CommandWithId,
        startedAtEpochMs: number,
        outcome: CommandOutcome,
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
            error: this.redact(outcome.error),
        };
        return result;
    }

    private commitResult(
        result: RallarBlackBoxTestResult,
        nextStatus: RallarBlackBoxTestRuntimeStatus | undefined,
    ): void {
        const commandHistory = [...this.currentState.commandHistory, result];
        const failures = result.ok
            ? this.currentState.failures
            : [...this.currentState.failures, result];
        const resultCache = {
            ...this.currentState.resultCache,
            [result.commandId]: result,
        };

        this.currentState = {
            ...this.currentState,
            status: nextStatus ?? (result.ok ? 'completed' : 'failed'),
            activeCommand: undefined,
            activeCommandStartedAtEpochMs: undefined,
            commandHistory,
            failures,
            resultCache,
        };

        this.emitEvent({
            kind: 'result',
            topic: 'rallar.bb.command.result',
            commandId: result.commandId,
            severity: result.ok ? 'info' : 'error',
            payload: result,
        });
        this.notify();
    }

    private updateStats(commandId?: string): RallarBlackBoxTestStatsSnapshot {
        const events = this.currentState.events;
        const config = this.currentState.currentConfig;
        const durations = this.currentState.commandHistory.map(result => result.durationMs);
        const loopResults = this.currentState.commandHistory.filter(result => result.kind === 'loop');
        const latestLoopResult = loopResults.at(-1);
        const latestLoopValue = this.loopResultValue(latestLoopResult?.value);
        const lastRallarDiagnostic = events
            .filter(event =>
                event.topic.includes('rtc.connected') ||
                event.topic.includes('rallar.bb.fake.rtc.connected') ||
                event.topic.includes('rallar.browser.connect_completed')
            )
            .at(-1);
        const lastRallarPayload = asRecord(lastRallarDiagnostic?.payload);
        const latestStats: RallarBlackBoxTestStatsSnapshot = {
            atEpochMs: this.now(),
            runId: config?.runId,
            agentId: config?.agentId,
            status: this.currentState.status,
            counters: {
                commands: this.currentState.commandHistory.length,
                events: events.length,
                failures: this.currentState.failures.length,
                messages: events.filter((event) => event.kind === 'message').length,
                diagnostics: events.filter((event) => event.kind === 'diagnostic').length,
                reconnects: events.filter((event) =>
                    event.topic.toLowerCase().includes('reconnect')
                ).length,
            },
            lastCommandId: this.currentState.commandHistory.at(-1)?.commandId,
            lastEventAtEpochMs: events.at(-1)?.atEpochMs,
            commandLatency: {
                count: durations.length,
                minMs: durations.length > 0 ? Math.min(...durations) : undefined,
                maxMs: durations.length > 0 ? Math.max(...durations) : undefined,
                averageMs: durations.length > 0
                    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
                    : undefined,
                lastMs: durations.at(-1),
            },
            rallar: {
                connected: lastRallarDiagnostic !== undefined,
                actor: config?.actor,
                sessionId: config?.sessionId,
                roomId: config?.roomId,
                transport: config?.transport,
                peerCount: typeof lastRallarPayload.peerCount === 'number'
                    ? lastRallarPayload.peerCount
                    : undefined,
                laneHealth: lastRallarPayload.laneHealth,
            },
            load: loopResults.length > 0
                ? {
                    loopCount: loopResults.length,
                    latestLoopCommandId: latestLoopResult?.commandId,
                    latestPacing: this.toStatsPacingSummary(latestLoopValue?.pacing),
                    latestSends: this.toStatsSendSummary(latestLoopValue?.sends),
                    thresholdFailures: latestLoopValue?.thresholdFailures,
                }
                : undefined,
        };

        this.currentState = {
            ...this.currentState,
            latestStats,
        };
        this.emitEvent({
            kind: 'stats',
            topic: 'rallar.bb.stats',
            commandId,
            severity: 'info',
            payload: latestStats,
        });
        return latestStats;
    }

    private loopResultValue(value: unknown): RallarBlackBoxTestLoopResultValue | undefined {
        const record = asRecord(value);
        return typeof record.commandId === 'string' && record.pacing !== undefined
            ? value as RallarBlackBoxTestLoopResultValue
            : undefined;
    }

    private toStatsPacingSummary(
        pacing: RallarBlackBoxTestLoopPacingSummary | undefined,
    ): Omit<RallarBlackBoxTestLoopPacingSummary, 'iterations'> | undefined {
        if (!pacing) {
            return undefined;
        }

        return {
            requestedIntervalMs: pacing.requestedIntervalMs,
            requestedRateHz: pacing.requestedRateHz,
            plannedIterations: pacing.plannedIterations,
            completedIterations: pacing.completedIterations,
            skippedIterations: pacing.skippedIterations,
            cancelledIterations: pacing.cancelledIterations,
            startedAtEpochMs: pacing.startedAtEpochMs,
            endedAtEpochMs: pacing.endedAtEpochMs,
            elapsedMs: pacing.elapsedMs,
            targetElapsedMs: pacing.targetElapsedMs,
            achievedRateHz: pacing.achievedRateHz,
            averageIterationDurationMs: pacing.averageIterationDurationMs,
            minStartDriftMs: pacing.minStartDriftMs,
            maxStartDriftMs: pacing.maxStartDriftMs,
            averageStartDriftMs: pacing.averageStartDriftMs,
            maxJitterMs: pacing.maxJitterMs,
            averageJitterMs: pacing.averageJitterMs,
            lateIterationCount: pacing.lateIterationCount,
            lateThresholdMs: pacing.lateThresholdMs,
        };
    }

    private toStatsSendSummary(
        sends: RallarBlackBoxTestLoopSendSummary | undefined,
    ): Omit<RallarBlackBoxTestLoopSendSummary, 'observations'> | undefined {
        if (!sends) {
            return undefined;
        }

        return {
            sendCount: sends.sendCount,
            succeeded: sends.succeeded,
            failed: sends.failed,
            successRatio: sends.successRatio,
            duration: sends.duration,
            queuedCount: sends.queuedCount,
            enqueuedCount: sends.enqueuedCount,
            backpressureCount: sends.backpressureCount,
            droppedPayloadCount: sends.droppedPayloadCount,
            replacedPayloadCount: sends.replacedPayloadCount,
            perTransportFailureCounts: sends.perTransportFailureCounts,
        };
    }

    private toHealth(): unknown {
        return {
            status: this.currentState.status,
            configured: this.currentState.currentConfig !== undefined,
            loadedRecipeId: this.currentState.loadedRecipe?.recipeId,
            activeCommandId: this.currentState.activeCommand?.commandId,
            commandCount: this.currentState.commandHistory.length,
            eventCount: this.currentState.events.length,
            failureCount: this.currentState.failures.length,
        };
    }

    private emitEvent(
        event: RallarBlackBoxTestRuntimeEventInput,
    ): void {
        const created: RallarBlackBoxTestEvent = {
            ...event,
            eventId: this.idFactory('event'),
            atEpochMs: this.now(),
            payload: this.redact(event.payload),
        };
        this.currentState = {
            ...this.currentState,
            events: [...this.currentState.events, created],
        };
        this.notify();
    }

    private setState(patch: Partial<RallarBlackBoxTestState>): void {
        this.currentState = {
            ...this.currentState,
            ...patch,
        };
        this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                void Promise.resolve(listener(this.currentState));
            } catch (_error) {
                // State listeners are observational and should not break command execution.
            }
        }
    }

    private withCommandId(command: RallarBlackBoxTestCommand): CommandWithId {
        return {
            ...command,
            commandId: command.commandId ?? this.idFactory('command'),
        } as CommandWithId;
    }

    private redact<T>(value: T): T {
        return redactRallarBlackBoxValue(
            value,
            this.currentRedaction,
        );
    }
}

export function createRallarBlackBoxTestRuntime(
    options: CreateRallarBlackBoxTestRuntimeOptions = {},
): RallarBlackBoxTestRuntime {
    return new InMemoryRallarBlackBoxTestRuntime(options);
}
