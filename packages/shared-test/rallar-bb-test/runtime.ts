import { redactRallarBlackBoxValue } from './redaction.ts';
import type {
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
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStateListener,
    RallarBlackBoxTestStatsSnapshot,
} from './types.ts';

export type CreateRallarBlackBoxTestRuntimeOptions = Readonly<{
    now?: () => number;
    idFactory?: (prefix: string) => string;
    commandExecutor?: RallarBlackBoxTestCommandExecutor;
}>;

type CommandWithId = RallarBlackBoxTestCommand & Readonly<{ commandId: string }>;

type CommandOutcome = RallarBlackBoxTestCommandOutcome;

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

class InMemoryRallarBlackBoxTestRuntime implements RallarBlackBoxTestRuntime {
    private readonly now: () => number;
    private readonly idFactory: (prefix: string) => string;
    private readonly commandExecutor: RallarBlackBoxTestCommandExecutor | undefined;
    private readonly listeners = new Set<RallarBlackBoxTestStateListener>();
    private currentState: RallarBlackBoxTestState = initialState();
    private currentRedaction: RallarBlackBoxTestConfig['redaction'] | undefined;
    private loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    private cancelRequested = false;

    constructor(options: CreateRallarBlackBoxTestRuntimeOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.idFactory = options.idFactory ?? defaultIdFactory();
        this.commandExecutor = options.commandExecutor;
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
        const commandWithId = this.withCommandId(command);
        const cached = this.currentState.resultCache[commandWithId.commandId];
        if (cached) {
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
            outcome = {
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
                return await this.runRecipe(command.recipe);
            case 'recipe.cancel':
                return this.cancelRecipe(command.reason);
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
                this.currentRedaction = undefined;
                this.loadedRecipe = undefined;
                this.cancelRequested = false;
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
        fallback: () => CommandOutcome,
    ): Promise<CommandOutcome> {
        const outcome = await this.commandExecutor?.(
            command,
            this.toCommandContext(),
        );
        return outcome ?? fallback();
    }

    private toCommandContext(): RallarBlackBoxTestCommandContext {
        return {
            state: () => this.currentState,
            config: () => this.currentState.currentConfig,
            recordEvent: event => this.emitEvent(event),
            updateStats: commandId => this.updateStats(commandId),
        };
    }

    private configure(config: RallarBlackBoxTestConfig): CommandOutcome {
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
        inlineRecipe: RallarBlackBoxTestRecipe | undefined,
    ): Promise<CommandOutcome> {
        const recipe = inlineRecipe ?? this.loadedRecipe;
        if (!recipe) {
            throw new Error('No recipe is loaded.');
        }
        requireRecipeIsExecutable(recipe);

        this.cancelRequested = false;
        const results: RallarBlackBoxTestResult[] = [];
        for (const childCommand of recipe.commands) {
            if (this.cancelRequested) {
                return {
                    status: 'cancelled',
                    value: {
                        recipeId: recipe.recipeId,
                        results,
                        cancelled: true,
                    },
                    nextStatus: 'cancelled',
                };
            }

            const result = await this.execute(childCommand);
            results.push(result);

            if (!result.ok && recipe.continueOnFailure !== true) {
                return {
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
    }

    private cancelRecipe(reason: string | undefined): CommandOutcome {
        this.cancelRequested = true;
        this.emitEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.recipe.cancel_requested',
            severity: 'warning',
            payload: {
                reason,
            },
        });
        return {
            status: 'ok',
            value: {
                cancelRequested: true,
                reason,
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
