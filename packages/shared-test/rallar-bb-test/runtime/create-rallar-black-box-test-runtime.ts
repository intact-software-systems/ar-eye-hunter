import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { computeAssertCommandOutcome } from '../assert/compute-assert-command-outcome.ts';
import { waitForBarrier } from '../barrier/wait-for-barrier.ts';
import type { ControlClientIdentity } from '../control-protocol.ts';
import { toRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import { LoopCommandExecution } from '../loop/loop-command-execution.ts';
import { ParallelCommandExecution } from '../parallel/parallel-command-execution.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandExecutor,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
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
import { RecipeCaptureSequence } from '../recipe/recipe-capture-sequence.ts';
import { runRecipeCommands } from '../recipe/run-recipe-commands.ts';
import { snapshotExecutableCommand } from '../recipe/snapshot-executable-recipe.ts';
import { validateExecutableCommand, validateExecutableRecipe } from '../recipe/validate-executable-recipe.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import { waitForEvent, type WaitForEventInput } from '../wait/wait-for-event.ts';
import { decodeRecord } from './decode-runtime-result-values.ts';
import {
    decodeRuntimeTestError,
    decodeThrownCommandOutcome,
    toInvalidRecipeOutcome,
    toTerminalCleanupReason
} from './runtime-command-outcomes.ts';
import { sleepWithAbort } from './sleep-with-abort.ts';
import { toMergedRuntimeConfig } from './to-merged-runtime-config.ts';
import { computeCommandDeadlineEpochMs } from './to-runtime-command-values.ts';
import { toRuntimeHealth, toRuntimeStats } from './to-runtime-stats.ts';

export interface CreateRallarBlackBoxTestRuntimeInput {
    readonly now: () => number;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly idFactory: (prefix: string) => string;
    readonly commandExecutor?: RallarBlackBoxTestCommandExecutor;
    readonly cleanup?: RallarBlackBoxTestRuntimeCleanup;
    /** Reads the page's session ledger and ordering snapshots for `stats`; absent on a runtime that drives no Rallar page. */
    readonly readAlmUsage?: () => Promise<RallarBlackBoxTestAlmUsage | undefined>;
    /** Reads the page's congestion counters for `stats`; absent on a runtime that drives no Rallar page. */
    readonly readCongestionCounters?: () => Promise<ALCongestionCounters | undefined>;
}

export type CreateRallarBlackBoxTestRuntimeOptions = Partial<CreateRallarBlackBoxTestRuntimeInput>;

type CommandWithId = RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>;

type CommandOfKind<Kind extends RallarBlackBoxTestCommand['kind']> = Extract<CommandWithId, Readonly<{ kind: Kind; }>>;

/** A child of a recipe, loop or parallel command always runs; only a top-level command replays its cached result. */
type ResultCachePolicy = 'replay' | 'bypass';

/** A successful cached invocation is historical evidence; a fresh reference must match the current acknowledged load. */
function resolveRecipeBodyBindingFailure(
    command: RallarBlackBoxTestCommand,
    loaded: InMemoryRallarBlackBoxTestRuntime.LoadedRecipe | undefined,
    cached: RallarBlackBoxTestResult | undefined
): RallarBlackBoxTestCommandOutcome | undefined {
    if (command.kind !== 'recipe.run' || command.expectedRecipeBodyId === undefined) {
        return undefined;
    }
    const issues = validateExecutableCommand(command);
    if (issues.length > 0) {
        return toInvalidRecipeOutcome(issues);
    }
    if (cached?.ok === false) {
        return undefined;
    }
    const actual = cached ? decodeRecord(decodeRecord(cached.value).invocation).recipeBodyId : loaded?.recipeBodyId;
    return actual === command.expectedRecipeBodyId
        ? undefined
        : toInvalidRecipeOutcome(['The acknowledged recipe body is no longer available for this execution.']);
}

namespace InMemoryRallarBlackBoxTestRuntime {
    export interface LoadedRecipe {
        readonly recipe: RallarBlackBoxTestRecipe;
        readonly recipeBodyId: string;
    }

    export interface EventOwnership {
        readonly cacheOwner: object;
        readonly control: RallarBlackBoxTestEvent.ControlExecution | undefined;
    }

    export interface RunCommandInput extends EventOwnership {
        readonly command: RallarBlackBoxTestCommand;
        readonly cachePolicy: ResultCachePolicy;
        readonly captureSequence: RecipeCaptureSequence;
        readonly loadedRecipe: LoadedRecipe | undefined;
    }

    export interface CommitResultInput extends EventOwnership {
        readonly command: CommandWithId;
        readonly startedAtEpochMs: number;
        readonly outcome: RallarBlackBoxTestCommandOutcome;
    }

    export interface CommandAdmission extends EventOwnership {
        readonly captureSequence: RecipeCaptureSequence;
        readonly loadedRecipe: LoadedRecipe | undefined;
    }

    export interface TargetedCleanup {
        readonly targetCommandId: string;
        targetSettled: boolean;
        requestSettled: boolean;
    }
}

class InMemoryRallarBlackBoxTestRuntime implements RallarBlackBoxTestRuntime {
    private readonly dependencies: CreateRallarBlackBoxTestRuntimeInput;
    private readonly listeners = new Set<RallarBlackBoxTestStateListener>();
    private currentState: RallarBlackBoxTestState = createInitialRuntimeState();
    private controlIdentity: ControlClientIdentity | undefined;
    private cacheOwner: object = {};
    private readonly captureDefaults = new RecipeCaptureSequence({
        run: undefined,
        recipe: undefined,
        step: undefined
    });
    private currentConfig: RallarBlackBoxTestConfig | undefined;
    private loadedRecipe: InMemoryRallarBlackBoxTestRuntime.LoadedRecipe | undefined;
    private activeExecutionCount = 0;
    private activeTopLevelCount = 0;
    private exclusiveTopLevelCommandId: string | undefined;
    private targetedCleanup: InMemoryRallarBlackBoxTestRuntime.TargetedCleanup | undefined;
    private cancellationController = new AbortController();
    private recipeExecutionDepth = 0;

    constructor(dependencies: CreateRallarBlackBoxTestRuntimeInput) {
        this.dependencies = dependencies;
    }

    state(): RallarBlackBoxTestState {
        return this.currentState;
    }

    subscribe(listener: RallarBlackBoxTestStateListener): () => void {
        this.listeners.add(listener);
        notifyListener(listener, this.currentState);
        return () => {
            this.listeners.delete(listener);
        };
    }

    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void {
        this.appendEvent(event);
    }

    async execute(
        command: RallarBlackBoxTestCommand,
        controlIdentity?: ControlClientIdentity
    ): Promise<RallarBlackBoxTestResult> {
        if (
            (controlIdentity?.runId !== this.controlIdentity?.runId ||
                controlIdentity?.agentId !== this.controlIdentity?.agentId)
        ) {
            this.controlIdentity = controlIdentity && Object.freeze({ ...controlIdentity });
            this.cacheOwner = {};
            this.currentState = { ...this.currentState, resultCache: {} };
        }
        const submitted = snapshotExecutableCommand(command);
        const captureSequence = submitted.kind === 'configure' ? this.captureDefaults : this.captureDefaults.fork();
        const cacheOwner = this.cacheOwner;
        const identity = this.controlIdentity;
        const loadedRecipe = this.loadedRecipe;
        const accepted = this.toCommandWithId(submitted);
        return await this.runCommand({
            command: accepted,
            cachePolicy: 'replay',
            captureSequence,
            cacheOwner,
            control: identity && Object.freeze({ ...identity, rootCommandId: accepted.commandId }),
            loadedRecipe
        });
    }

    private async runCommand(
        input: InMemoryRallarBlackBoxTestRuntime.RunCommandInput
    ): Promise<RallarBlackBoxTestResult> {
        const { command, cachePolicy, captureSequence, cacheOwner, control } = input;
        const admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission = {
            captureSequence,
            cacheOwner,
            control,
            loadedRecipe: command.kind === 'recipe.run' && command.recipe === undefined ? input.loadedRecipe : undefined
        };
        const commandWithId = this.toCommandWithId(command);
        const cached = this.currentState.resultCache[commandWithId.commandId];
        const bindingFailure = resolveRecipeBodyBindingFailure(
            commandWithId,
            admission.loadedRecipe,
            cached && cachePolicy === 'replay' ? cached : undefined
        );
        if (bindingFailure) {
            return this.commitResult({
                command: commandWithId,
                startedAtEpochMs: this.dependencies.now(),
                outcome: bindingFailure,
                cacheOwner,
                control
            });
        }
        if (cached && cachePolicy === 'replay' && cacheOwner === this.cacheOwner) {
            return { ...cached, replayed: true };
        }
        if (cacheOwner !== this.cacheOwner) {
            return this.commitResult({
                command: commandWithId,
                startedAtEpochMs: this.dependencies.now(),
                outcome: toInvalidRecipeOutcome(['Control assignment changed before this child could execute.']),
                cacheOwner,
                control
            });
        }

        const refusal = this.admitCommand(commandWithId, cachePolicy);
        return refusal
            ? this.commitResult({
                command: commandWithId,
                startedAtEpochMs: this.dependencies.now(),
                outcome: refusal,
                cacheOwner,
                control
            })
            : await this.runRegisteredCommand(commandWithId, cachePolicy, admission);
    }

    /** Refusal leaves resource ownership unchanged; accepted idle close fences effects before any notification. */
    private admitCommand(
        command: CommandWithId,
        cachePolicy: ResultCachePolicy
    ): RallarBlackBoxTestCommandOutcome | undefined {
        if (
            cachePolicy === 'bypass' && (command.kind === 'close' || command.kind === 'recipe.cancel') &&
            command.targetCommandId !== undefined
        ) {
            return {
                status: 'ok',
                nextStatus: this.currentState.status,
                value: {
                    ...(command.kind === 'close' ? { closed: false } : { cancelRequested: false }),
                    targetCommandId: command.targetCommandId,
                    reason: 'targeted-cleanup-requires-top-level'
                }
            };
        }
        if (cachePolicy === 'replay' && this.targetedCleanup) {
            return {
                status: 'failed',
                nextStatus: this.currentState.status,
                error: {
                    code: 'RALLAR_BLACK_BOX_CLEANUP_IN_PROGRESS',
                    message: 'Owned resource cleanup is still settling.'
                }
            };
        }
        if (command.kind === 'close' && command.targetCommandId !== undefined) {
            const targetCommandId = command.targetCommandId;
            if (this.activeTopLevelCount !== 0 || this.exclusiveTopLevelCommandId !== targetCommandId) {
                return {
                    status: 'ok',
                    nextStatus: this.currentState.status,
                    value: { closed: false, targetCommandId, reason: 'target-not-exclusive-idle-owner' }
                };
            }
            this.exclusiveTopLevelCommandId = undefined;
            this.targetedCleanup = { targetCommandId, targetSettled: true, requestSettled: false };
        }
        return undefined;
    }

    /** Owns actual invocation registration and final settlement, including nested execution accounting. */
    private async runRegisteredCommand(
        commandWithId: CommandWithId,
        cachePolicy: ResultCachePolicy,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestResult> {
        const targetedClose = commandWithId.kind === 'close' && commandWithId.targetCommandId !== undefined;
        const ownsExecution = cachePolicy === 'replay' && commandWithId.kind !== 'recipe.cancel' && !targetedClose;
        if (ownsExecution) {
            this.exclusiveTopLevelCommandId = this.activeTopLevelCount === 0 ? commandWithId.commandId : undefined;
            this.activeTopLevelCount += 1;
        }

        if (commandWithId.kind !== 'recipe.cancel' && !targetedClose) {
            this.clearAbortedCancellation();
        }
        this.activeExecutionCount += 1;
        let succeeded = false;
        try {
            const result = await this.runUncachedCommand(commandWithId, admission);
            succeeded = result.ok;
            return result;
        }
        finally {
            this.activeExecutionCount -= 1;
            if (targetedClose) {
                this.settleTargetedCleanup('request');
            }
            if (ownsExecution) {
                this.activeTopLevelCount -= 1;
                if (this.activeTopLevelCount === 0 && !succeeded) {
                    this.exclusiveTopLevelCommandId = undefined;
                }
                if (this.targetedCleanup?.targetCommandId === commandWithId.commandId) {
                    this.settleTargetedCleanup('target');
                }
            }
        }
    }

    private async runUncachedCommand(
        commandWithId: CommandWithId,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestResult> {
        const startedAtEpochMs = this.dependencies.now();
        if (admission.cacheOwner !== this.cacheOwner) {
            return this.commitResult({
                command: commandWithId,
                startedAtEpochMs,
                outcome: toAssignmentChangedOutcome(),
                ...admission
            });
        }
        this.setState({
            activeCommand: this.toRedacted(commandWithId),
            activeCommandStartedAtEpochMs: startedAtEpochMs,
            status: commandWithId.kind === 'recipe.cancel' ? this.currentState.status : 'running'
        });
        const outcome = await this.runCommandOutcome(commandWithId, admission).catch(decodeThrownCommandOutcome);
        return this.commitResult({
            command: commandWithId,
            startedAtEpochMs,
            outcome,
            cacheOwner: admission.cacheOwner,
            control: admission.control
        });
    }

    private async runCommandOutcome(
        command: CommandWithId,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        if (admission.cacheOwner !== this.cacheOwner) {
            return toAssignmentChangedOutcome();
        }
        const captureIssues = validateExecutableCommand(command);
        if (captureIssues.length > 0) {
            return toInvalidRecipeOutcome(captureIssues);
        }
        switch (command.kind) {
            case 'configure':
                admission.captureSequence.configure(command.config);
                return this.configure(command.config, admission);
            case 'recipe.load':
                return this.loadRecipe(command.recipe, admission);
            case 'recipe.run':
                return await this.runRecipe(command, admission);
            case 'recipe.cancel':
                return await this.cancelRecipe(command, admission);
            case 'stats':
                return {
                    status: 'ok',
                    value: await this.updateStats(command.commandId, admission),
                    nextStatus: this.currentState.status
                };
            case 'reset':
                return await this.reset(command, admission);
            default:
                return await this.runExternalCommand(command, admission);
        }
    }

    private configure(
        config: RallarBlackBoxTestConfig,
        ownership: InMemoryRallarBlackBoxTestRuntime.EventOwnership
    ): RallarBlackBoxTestCommandOutcome {
        this.currentConfig = toMergedRuntimeConfig(this.currentConfig, config);
        const redactedConfig = this.toRedacted(this.currentConfig);
        this.setState({ currentConfig: redactedConfig });
        this.appendEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.configured',
            severity: 'info',
            payload: redactedConfig
        }, ownership);
        return { status: 'ok', value: { config: redactedConfig }, nextStatus: 'configured' };
    }

    private loadRecipe(
        recipe: RallarBlackBoxTestRecipe,
        ownership: InMemoryRallarBlackBoxTestRuntime.EventOwnership
    ): RallarBlackBoxTestCommandOutcome {
        const issues = validateExecutableRecipe(recipe);
        if (issues.length > 0) {
            return toInvalidRecipeOutcome(issues);
        }
        const accepted = { recipe, recipeBodyId: this.dependencies.idFactory('recipe-body') };
        if (ownership.cacheOwner !== this.cacheOwner) {
            return toAssignmentChangedOutcome();
        }
        this.loadedRecipe = accepted;
        this.setState({ loadedRecipe: this.toRedacted(recipe) });
        const summary = {
            recipeId: recipe.recipeId,
            recipeBodyId: accepted.recipeBodyId,
            commandCount: recipe.commands.length
        };
        this.appendEvent(
            { kind: 'diagnostic', topic: 'rallar.bb.recipe.loaded', severity: 'info', payload: summary },
            ownership
        );
        return { status: 'ok', value: summary, nextStatus: 'loaded' };
    }

    private async runRecipe(
        command: CommandOfKind<'recipe.run'>,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const recipe = command.recipe ?? admission.loadedRecipe?.recipe;
        const issues = recipe === undefined ? ['No recipe is loaded.'] : validateExecutableRecipe(recipe);
        if (recipe === undefined || issues.length > 0) {
            return toInvalidRecipeOutcome(issues);
        }
        const sequence = admission.captureSequence.forRecipe(recipe, command.rtcCaptureMode);
        const invocation = Object.freeze({
            invocationId: this.dependencies.idFactory('recipe-invocation'),
            recipeBodyId: admission.loadedRecipe?.recipeBodyId ?? this.dependencies.idFactory('recipe-body'),
            ...sequence.get()
        });
        const deadlineEpochMs = computeCommandDeadlineEpochMs(command, this.dependencies.now());
        if (admission.cacheOwner !== this.cacheOwner) {
            return toAssignmentChangedOutcome();
        }
        this.recipeExecutionDepth += 1;
        try {
            const outcome = await runRecipeCommands({
                recipe,
                invocation,
                timeoutMs: command.timeoutMs,
                deadlineEpochMs,
                ports: this.toCompositePorts({ ...admission, captureSequence: sequence })
            });
            if (outcome.status !== 'ok') {
                await this.cleanupOwnedResources({
                    reason: toTerminalCleanupReason(outcome),
                    commandId: command.commandId,
                    recipeId: recipe.recipeId,
                    status: outcome.status,
                    error: outcome.error
                }, admission);
            }
            return outcome;
        }
        finally {
            this.recipeExecutionDepth -= 1;
        }
    }

    private async cancelRecipe(
        command: CommandOfKind<'recipe.cancel'>,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const targetCommandId = command.targetCommandId;
        if (
            targetCommandId !== undefined &&
            (this.targetedCleanup || this.activeTopLevelCount !== 1 ||
                this.exclusiveTopLevelCommandId !== targetCommandId)
        ) {
            return {
                status: 'ok',
                value: { cancelRequested: false, targetCommandId, reason: 'target-not-exclusively-active' },
                nextStatus: this.currentState.status
            };
        }
        if (targetCommandId !== undefined) {
            // Abort listeners may reenter execute synchronously, so fence admission before aborting.
            this.targetedCleanup = { targetCommandId, targetSettled: false, requestSettled: false };
        }
        this.exclusiveTopLevelCommandId = undefined;
        try {
            if (!this.cancellationController.signal.aborted) {
                this.cancellationController.abort(command.reason ?? 'Rallar black-box recipe cancellation requested.');
            }
            this.appendEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.recipe.cancel_requested',
                commandId: command.commandId,
                severity: 'warning',
                payload: { reason: command.reason }
            }, admission);
            if (this.recipeExecutionDepth === 0) {
                await this.cleanupOwnedResources({
                    reason: 'cancelled',
                    commandId: command.commandId,
                    status: 'cancelled'
                }, admission);
            }
            return {
                status: 'ok',
                value: {
                    cancelRequested: true,
                    reason: command.reason,
                    ...(targetCommandId === undefined ? {} : { targetCommandId })
                },
                nextStatus: this.currentState.status === 'running' ? 'cancelled' : this.currentState.status
            };
        }
        finally {
            if (targetCommandId !== undefined) {
                this.settleTargetedCleanup('request');
            }
        }
    }

    private settleTargetedCleanup(part: 'request' | 'target'): void {
        const cleanup = this.targetedCleanup;
        if (!cleanup) {
            return;
        }
        if (part === 'request') {
            cleanup.requestSettled = true;
        }
        else {
            cleanup.targetSettled = true;
        }
        if (cleanup.targetSettled && cleanup.requestSettled) {
            this.targetedCleanup = undefined;
        }
    }

    private async reset(
        command: CommandWithId,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const outcome = await this.dependencies.commandExecutor?.(
            command,
            this.toCommandContext(admission, admission.captureSequence)
        );
        if (admission.cacheOwner !== this.cacheOwner) {
            return outcome ?? toAssignmentChangedOutcome();
        }
        this.currentState = createInitialRuntimeState();
        this.currentConfig = undefined;
        this.captureDefaults.configure({});
        this.loadedRecipe = undefined;
        this.notify();
        return outcome
            ? { ...outcome, nextStatus: 'idle' }
            : { status: 'ok', value: { reset: true }, nextStatus: 'idle' };
    }

    private async runExternalCommand(
        command: CommandWithId,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const captureSequence = admission.captureSequence;
        const outcome = await this.dependencies.commandExecutor?.(
            command,
            this.toCommandContext(admission, captureSequence)
        );
        if (outcome) {
            return outcome;
        }
        if (admission.cacheOwner !== this.cacheOwner) {
            return toAssignmentChangedOutcome();
        }
        switch (command.kind) {
            case 'loop':
                return await new LoopCommandExecution(
                    command,
                    this.toCompositePorts(admission)
                ).run();
            case 'parallel':
                return await new ParallelCommandExecution(
                    command,
                    this.toCompositePorts(admission)
                ).run();
            case 'wait':
                return await waitForEvent({ command, ...this.toWaitPorts() });
            case 'barrier':
                return await waitForBarrier({
                    command,
                    recordEvent: (event) => {
                        if (admission.cacheOwner === this.cacheOwner) {
                            this.appendEvent(event, admission);
                        }
                    },
                    ...this.toWaitPorts()
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
                }, admission);
                return { status: 'ok', value: { closed: true }, nextStatus: 'idle' };
            default:
                return this.recordSimulatedCommand(command, admission);
        }
    }

    private toWaitPorts(): Omit<WaitForEventInput, 'command'> {
        return {
            now: this.dependencies.now,
            sleep: this.dependencies.sleep,
            cancellationSignal: this.cancellationController.signal,
            cancelRequested: () => this.cancellationController.signal.aborted,
            currentStatus: () => this.currentState.status,
            currentEvents: () => this.currentState.events,
            resultCache: this.currentState.resultCache,
            subscribe: (listener) => this.subscribe(() => listener())
        };
    }

    private recordSimulatedCommand(
        command: CommandWithId,
        ownership: InMemoryRallarBlackBoxTestRuntime.EventOwnership
    ): RallarBlackBoxTestCommandOutcome {
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
        }, ownership);
        return {
            status: 'ok',
            value: { fake: true, kind: command.kind, commandId: command.commandId },
            nextStatus: this.currentState.status
        };
    }

    private async cleanupOwnedResources(
        input: RallarBlackBoxTestCleanupInput,
        ownership: InMemoryRallarBlackBoxTestRuntime.EventOwnership
    ): Promise<void> {
        const { cacheOwner } = ownership;
        if (cacheOwner !== this.cacheOwner) {
            return;
        }
        const cleanup = this.dependencies.cleanup;
        if (!cleanup) {
            return;
        }
        try {
            await cleanup(input, this.toCommandContext(ownership));
            if (cacheOwner !== this.cacheOwner) {
                return;
            }
            this.appendEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.completed',
                commandId: input.commandId,
                severity: 'info',
                payload: input
            }, ownership);
        }
        catch (error) {
            if (cacheOwner !== this.cacheOwner) {
                return;
            }
            this.appendEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.cleanup.failed',
                commandId: input.commandId,
                severity: 'error',
                payload: { input, error: decodeRuntimeTestError(error, 'RALLAR_BLACK_BOX_CLEANUP_FAILED') }
            }, ownership);
        }
    }

    private toCommandContext(
        ownership: InMemoryRallarBlackBoxTestRuntime.EventOwnership,
        captureSequence?: RecipeCaptureSequence
    ): RallarBlackBoxTestCommandContext {
        const { cacheOwner } = ownership;
        const admittedState = this.currentState;
        return {
            rtcCapture: captureSequence?.get(),
            state: () => this.currentState,
            config: () => this.currentConfig,
            abortSignal: () => this.cancellationController.signal,
            recordEvent: (event) => {
                if (cacheOwner === this.cacheOwner) {
                    this.appendEvent(event, ownership);
                }
            },
            updateStats: async (commandId) =>
                cacheOwner === this.cacheOwner
                    ? this.updateStats(commandId, ownership)
                    : toRuntimeStats(admittedState, this.dependencies.now())
        };
    }

    private toCompositePorts(
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): LoopCommandExecution.Ports & ParallelCommandExecution.Ports {
        const { captureSequence, cacheOwner, control } = admission;
        return {
            now: this.dependencies.now,
            sleep: this.dependencies.sleep,
            runChildCommand: (command) =>
                this.runCommand({
                    command,
                    cachePolicy: 'bypass',
                    captureSequence,
                    cacheOwner,
                    control,
                    loadedRecipe: this.loadedRecipe
                }),
            forkChildCommands: () => {
                const groupCapture = captureSequence.fork();
                return (command) =>
                    this.runCommand({
                        command,
                        cachePolicy: 'bypass',
                        captureSequence: groupCapture,
                        cacheOwner,
                        control,
                        loadedRecipe: this.loadedRecipe
                    });
            },
            cancelRequested: () => this.cancellationController.signal.aborted,
            abortSignal: () => this.cancellationController.signal
        };
    }

    private clearAbortedCancellation(): void {
        if (this.activeExecutionCount === 0 && this.cancellationController.signal.aborted) {
            this.cancellationController = new AbortController();
        }
    }

    private commitResult(input: InMemoryRallarBlackBoxTestRuntime.CommitResultInput): RallarBlackBoxTestResult {
        const { command, startedAtEpochMs, outcome, cacheOwner } = input;
        const endedAtEpochMs = this.dependencies.now();
        const result: RallarBlackBoxTestResult = {
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
        if (cacheOwner !== this.cacheOwner) {
            return result;
        }
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
        }, input);
        this.notify();
        return result;
    }

    private async updateStats(
        commandId: string | undefined,
        ownership: InMemoryRallarBlackBoxTestRuntime.EventOwnership
    ): Promise<RallarBlackBoxTestStatsSnapshot> {
        const admittedState = this.currentState;
        const alm = await this.dependencies.readAlmUsage?.();
        const congestion = await this.dependencies.readCongestionCounters?.();
        const latestStats = toStatsWithPageReadings(
            toRuntimeStats(
                ownership.cacheOwner === this.cacheOwner ? this.currentState : admittedState,
                this.dependencies.now()
            ),
            alm,
            congestion
        );
        if (ownership.cacheOwner !== this.cacheOwner) {
            return latestStats;
        }
        this.currentState = { ...this.currentState, latestStats };
        this.appendEvent({
            kind: 'stats',
            topic: 'rallar.bb.stats',
            commandId,
            severity: 'info',
            payload: latestStats
        }, ownership);
        return latestStats;
    }

    private appendEvent(
        event: RallarBlackBoxTestRuntimeEventInput,
        ownership?: InMemoryRallarBlackBoxTestRuntime.EventOwnership
    ): void {
        if (ownership && ownership.cacheOwner !== this.cacheOwner) {
            return;
        }
        const local = { ...event };
        delete local.control;
        const created: RallarBlackBoxTestEvent = {
            ...local,
            ...(ownership?.control === undefined ? {} : { control: ownership.control }),
            eventId: this.dependencies.idFactory('event'),
            atEpochMs: this.dependencies.now(),
            payload: this.toRedacted(event.payload)
        };
        if (ownership && ownership.cacheOwner !== this.cacheOwner) {
            return;
        }
        this.currentState = { ...this.currentState, events: [...this.currentState.events, created] };
        this.notify();
    }

    private setState(patch: Partial<RallarBlackBoxTestState>): void {
        this.currentState = { ...this.currentState, ...patch };
        this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) {
            notifyListener(listener, this.currentState);
        }
    }

    private toCommandWithId(command: RallarBlackBoxTestCommand): CommandWithId {
        return { ...command, commandId: command.commandId ?? this.dependencies.idFactory('command') };
    }

    private toRedacted<T>(value: T): T {
        return redactRallarBlackBoxValue(value, this.currentConfig?.redaction);
    }
}

export function createRallarBlackBoxTestRuntime(
    input: CreateRallarBlackBoxTestRuntimeInput
): RallarBlackBoxTestRuntime {
    return new InMemoryRallarBlackBoxTestRuntime({
        now: input.now,
        sleep: input.sleep,
        idFactory: input.idFactory,
        commandExecutor: input.commandExecutor,
        cleanup: input.cleanup,
        readAlmUsage: input.readAlmUsage,
        readCongestionCounters: input.readCongestionCounters
    });
}

export function createDefaultRallarBlackBoxTestRuntime(
    options: CreateRallarBlackBoxTestRuntimeOptions = {}
): RallarBlackBoxTestRuntime {
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        now: options.now ?? (() => Date.now()),
        sleep: options.sleep ?? sleepWithAbort,
        idFactory: options.idFactory ?? ((prefix) => `${prefix}-${sequence++}`),
        commandExecutor: options.commandExecutor,
        cleanup: options.cleanup,
        readAlmUsage: options.readAlmUsage,
        readCongestionCounters: options.readCongestionCounters
    });
}

/** The page's readings join the runtime's own stats only where the page answered them, so absence stays absence. */
function toStatsWithPageReadings(
    stats: RallarBlackBoxTestStatsSnapshot,
    alm: RallarBlackBoxTestAlmUsage | undefined,
    congestion: ALCongestionCounters | undefined
): RallarBlackBoxTestStatsSnapshot {
    if (alm === undefined && congestion === undefined) {
        return stats;
    }
    return {
        ...stats,
        rallar: {
            ...stats.rallar,
            ...(alm === undefined ? {} : { alm }),
            ...(congestion === undefined ? {} : { congestion })
        }
    };
}

function createInitialRuntimeState(): RallarBlackBoxTestState {
    return { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
}

function toAssignmentChangedOutcome(): RallarBlackBoxTestCommandOutcome {
    return toInvalidRecipeOutcome(['Control assignment changed before this command could execute.']);
}
