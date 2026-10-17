import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { computeAssertCommandOutcome } from '../assert/compute-assert-command-outcome.ts';
import { waitForBarrier } from '../barrier/wait-for-barrier.ts';
import type { ControlClientIdentity, ControlCommandEnvelope } from '../control-protocol.ts';
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
    RallarBlackBoxTestExecutionInput,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecipeRunCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeCleanup,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStateListener,
    RallarBlackBoxTestStatsSnapshot
} from '../rallar-black-box-test-contracts.ts';
import { RecipeCaptureSequence } from '../recipe/recipe-capture-sequence.ts';
import {
    resolveRecipeEventHistoryAdmission,
    snapshotAdmittedRecipeCommand,
    snapshotExecutionInput
} from '../recipe/resolve-recipe-history-admission.ts';
import { runRecipeCommands } from '../recipe/run-recipe-commands.ts';
import { validateExecutableCommand, validateExecutableRecipe } from '../recipe/validate-executable-recipe.ts';
import {
    resolveRecipeBodyBindingFailure,
    type RecipeEventHistorySelection
} from '../recipe/validate-recipe-event-history.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import type {
    ResultCaptureReceipt,
    ResultReleaseOutcome,
    ResultReleaseRequest
} from '../result-release/result-release-protocol.ts';
import { waitForEvent, type WaitForEventInput } from '../wait/wait-for-event.ts';
import {
    computeAppendedEventHistory,
    computeRetainedEventHistory,
    createEventHistory,
    isSameEventHistoryPolicy,
    type RallarBlackBoxEventHistoryPolicy
} from './event-history.ts';
import {
    computeReleasedRuntimeResults,
    readVerifiedRuntimeRelease,
    resolveRuntimeResultReleaseRefusal,
    toReleasedRuntimeReplay,
    toResultReleaseOutcome
} from './release-runtime-results.ts';
import { resolveReleasedResultReference } from './resolve-released-result-reference.ts';
import {
    decodeRuntimeTestError,
    decodeThrownCommandOutcome,
    isAcceptedRuntimeCleanup,
    isTargetedRuntimeClose,
    isTopLevelResourceExecution,
    resolveRuntimeCleanupRefusal,
    toInvalidRecipeOutcome,
    toTerminalCleanupReason,
    type ResultCachePolicy
} from './runtime-command-outcomes.ts';
import { computeAppendedResultHistory, createRuntimeResultHistory } from './runtime-result-history.ts';
import { sleepWithAbort } from './sleep-with-abort.ts';
import { toCommandResultEventPayload } from './to-command-result-event-payload.ts';
import { toMergedRuntimeConfig } from './to-merged-runtime-config.ts';
import { computeCommandDeadlineEpochMs } from './to-runtime-command-values.ts';
import {
    toRuntimeHealth,
    toRuntimeStats,
    toStatsWithPageReadings
} from './to-runtime-stats.ts';

export interface CreateRallarBlackBoxTestRuntimeInput {
    readonly eventHistory: RallarBlackBoxEventHistoryPolicy;
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

export function createRallarBlackBoxTestRuntime(
    input: CreateRallarBlackBoxTestRuntimeInput
): RallarBlackBoxTestRuntime {
    return new InMemoryRallarBlackBoxTestRuntime({
        eventHistory: input.eventHistory,
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
        eventHistory: options.eventHistory ?? { mode: 'full' },
        now: options.now ?? (() => Date.now()),
        sleep: options.sleep ?? sleepWithAbort,
        idFactory: options.idFactory ??
            ((prefix) => prefix === 'runtime-instance' ? crypto.randomUUID() : `${prefix}-${sequence++}`),
        commandExecutor: options.commandExecutor,
        cleanup: options.cleanup,
        readAlmUsage: options.readAlmUsage,
        readCongestionCounters: options.readCongestionCounters
    });
}

namespace InMemoryRallarBlackBoxTestRuntime {
    export interface LoadedRecipe {
        readonly recipe: RallarBlackBoxTestRecipe;
        readonly recipeBodyId: string;
    }

    export interface ExecutionRecipes {
        loadedRecipe: LoadedRecipe | undefined;
    }

    export interface OwnedRecipeExecution {
        readonly command: RallarBlackBoxTestRecipeRunCommand;
        readonly loadedRecipe: LoadedRecipe | undefined;
        readonly selection: RecipeEventHistorySelection;
        readonly executionRecipes: ExecutionRecipes;
        readonly commandId: string;
    }

    export interface EventOwnership {
        readonly cacheOwner: object;
        readonly resultRootCommandId: string;
        readonly control: RallarBlackBoxTestEvent.ControlExecution | undefined;
    }

    export interface RunCommandInput extends EventOwnership {
        readonly command: RallarBlackBoxTestCommand;
        readonly cachePolicy: ResultCachePolicy;
        readonly eventHistoryRunOverride: boolean;
        readonly eventHistory: RallarBlackBoxEventHistoryPolicy | undefined;
        readonly captureSequence: RecipeCaptureSequence;
        readonly loadedRecipe: LoadedRecipe | undefined;
        readonly executionRecipes: ExecutionRecipes;
        readonly recipeExecution: ControlCommandEnvelope['recipeExecution'];
    }

    export interface CommitResultInput extends EventOwnership {
        readonly command: CommandWithId;
        readonly startedAtEpochMs: number;
        readonly outcome: RallarBlackBoxTestCommandOutcome;
    }

    export interface CommandAdmission extends EventOwnership {
        readonly eventHistoryRunOverride: boolean;
        readonly eventHistory: RallarBlackBoxEventHistoryPolicy | undefined;
        readonly captureSequence: RecipeCaptureSequence;
        readonly loadedRecipe: LoadedRecipe | undefined;
        readonly executionRecipes: ExecutionRecipes;
        readonly recipeExecution: ControlCommandEnvelope['recipeExecution'];
    }

    export interface HistoryAdmission {
        readonly admission: CommandAdmission;
        readonly failure: RallarBlackBoxTestCommandOutcome | undefined;
    }

    export interface AdmittedStatsReading {
        readonly ownership: EventOwnership;
        readonly admittedState: RallarBlackBoxTestState;
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
    private readonly pendingNotifications: RallarBlackBoxTestState[] = [];
    private notifying = false;
    private readonly usedBarrierIds = new Set<string>();
    private currentState: RallarBlackBoxTestState;
    private controlIdentity: ControlClientIdentity | undefined;
    private cacheOwner: object = {};
    private resultAssignment = 0;
    private resultOrdinal = 0;
    private readonly ownedResultEvents = new WeakSet<RallarBlackBoxTestEvent>();
    private readonly releasedCommands = new Map<string, ResultCaptureReceipt>();
    private readonly releasedReceipts = new Map<number, ResultCaptureReceipt>();
    private readonly captureDefaults = new RecipeCaptureSequence({
        run: undefined,
        recipe: undefined,
        step: undefined
    });
    private configuredEventHistory: RallarBlackBoxEventHistoryPolicy;
    private currentConfig: RallarBlackBoxTestConfig | undefined;
    private loadedRecipe: InMemoryRallarBlackBoxTestRuntime.LoadedRecipe | undefined;
    private readonly ownedRecipeExecutions = new Map<string, InMemoryRallarBlackBoxTestRuntime.OwnedRecipeExecution>();
    private activeExecutionCount = 0;
    private activeTopLevelCount = 0;
    private exclusiveTopLevelCommandId: string | undefined;
    private targetedCleanup: InMemoryRallarBlackBoxTestRuntime.TargetedCleanup | undefined;
    private cancellationController = new AbortController();
    private recipeExecutionDepth = 0;

    constructor(dependencies: CreateRallarBlackBoxTestRuntimeInput) {
        this.dependencies = dependencies;
        this.configuredEventHistory = Object.freeze({ ...dependencies.eventHistory });
        this.currentState = createInitialRuntimeState(
            createEventHistory(dependencies.eventHistory, {
                runtimeId: dependencies.idFactory('runtime-instance'),
                generation: 0
            }, { status: 'unattached' })
        );
    }

    async releaseResults(request: ResultReleaseRequest): Promise<ResultReleaseOutcome> {
        const refusal = resolveRuntimeResultReleaseRefusal(request, {
            controlIdentity: this.controlIdentity,
            runtimeId: this.currentState.eventHistory.runtimeId,
            generation: this.currentState.eventHistory.generation,
            assignment: this.resultAssignment,
            activeExecutionCount: this.activeExecutionCount,
            recipeLeaseCount: this.ownedRecipeExecutions.size
        });
        if (refusal) {
            return refusal;
        }
        const state = this.currentState;
        let verified: readonly ResultCaptureReceipt[] | undefined;
        try {
            verified = await readVerifiedRuntimeRelease(state, request);
        }
        catch {
            return toResultReleaseOutcome(
                request.requestId,
                'rejected',
                'The exact full result cannot be certified within the capture digest bounds.'
            );
        }
        if (
            state.resultHistory !== this.currentState.resultHistory || this.activeExecutionCount > 0 ||
            this.ownedRecipeExecutions.size > 0
        ) {
            return toResultReleaseOutcome(
                request.requestId,
                'deferred',
                'Runtime changed while verifying durable capture.'
            );
        }
        if (
            !verified ||
            request.receipts.some((receipt) =>
                !verified.some((current) => current.capture.ordinal === receipt.capture.ordinal) &&
                JSON.stringify(this.releasedReceipts.get(receipt.capture.ordinal)) !== JSON.stringify(receipt)
            )
        ) {
            return toResultReleaseOutcome(
                request.requestId,
                'rejected',
                'Exact full capture is missing, mismatched, or still owned by another result.'
            );
        }
        return this.commitResultRelease(request, verified);
    }

    private commitResultRelease(
        request: ResultReleaseRequest,
        verified: readonly ResultCaptureReceipt[]
    ): ResultReleaseOutcome {
        let released: ReturnType<typeof computeReleasedRuntimeResults>;
        try {
            released = computeReleasedRuntimeResults(this.currentState, verified, this.ownedResultEvents);
        }
        catch {
            return toResultReleaseOutcome(
                request.requestId,
                'rejected',
                'Retained result ownership cannot be verified within the capture digest bounds.'
            );
        }
        if (!released) {
            return toResultReleaseOutcome(
                request.requestId,
                'rejected',
                'Another retained result still owns a selected full payload.'
            );
        }
        for (const receipt of released.receipts) {
            this.releasedCommands.set(receipt.commandId, receipt);
            this.releasedReceipts.set(receipt.capture.ordinal, receipt);
        }
        this.currentState = released.state;
        for (const event of released.ownedResultEvents) {
            this.ownedResultEvents.add(event);
        }
        this.notify();
        return {
            ...toResultReleaseOutcome(
                request.requestId,
                'released',
                'Full payloads released; identities remain unavailable until reset.'
            ),
            releasedResults: released.receipts.length
        };
    }

    releaseRecipeExecution(rootCommandId: string, controlIdentity?: ControlClientIdentity): void {
        if (
            controlIdentity?.runId === this.controlIdentity?.runId &&
            controlIdentity?.agentId === this.controlIdentity?.agentId
        ) {
            this.ownedRecipeExecutions.delete(rootCommandId);
        }
    }

    private releaseOwnedRecipeExecutions(targetCommandId: string | undefined): void {
        if (targetCommandId === undefined) {
            this.ownedRecipeExecutions.clear();
            return;
        }
        for (const [root, execution] of this.ownedRecipeExecutions) {
            if (root === targetCommandId || execution.commandId === targetCommandId) {
                this.ownedRecipeExecutions.delete(root);
            }
        }
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

    beginEventCapture(identity: ControlClientIdentity): void {
        const history = this.currentState.eventHistory;
        const capture = history.capture;
        if (
            capture.status !== 'unattached' && capture.identity.runId === identity.runId &&
            capture.identity.agentId === identity.agentId
        ) {
            return;
        }
        this.currentState = {
            ...this.currentState,
            eventHistory: {
                ...history,
                capture: {
                    status: 'continuous',
                    identity: Object.freeze({ ...identity }),
                    start: {
                        runtimeId: history.runtimeId,
                        generation: history.generation,
                        ordinal: history.totalEvents + 1
                    }
                }
            }
        };
        this.notify();
    }

    recordEventCaptureGap(reason: string): void {
        const history = this.currentState.eventHistory;
        if (history.capture.status !== 'continuous') {
            return;
        }
        this.currentState = {
            ...this.currentState,
            eventHistory: { ...history, capture: { ...history.capture, status: 'gap', reason } }
        };
        this.notify();
    }

    async execute(
        command: RallarBlackBoxTestCommand,
        controlIdentity: ControlClientIdentity | undefined = undefined,
        input: RallarBlackBoxTestExecutionInput = {}
    ): Promise<RallarBlackBoxTestResult> {
        const snapshot = snapshotExecutionInput(controlIdentity, input);
        controlIdentity = snapshot.controlIdentity;
        const { eventHistorySelection, recipeExecution } = snapshot;
        if (
            (controlIdentity?.runId !== this.controlIdentity?.runId ||
                controlIdentity?.agentId !== this.controlIdentity?.agentId)
        ) {
            this.controlIdentity = controlIdentity;
            this.cacheOwner = {};
            this.resultAssignment += 1;
            this.releasedCommands.clear();
            this.releasedReceipts.clear();
            this.ownedRecipeExecutions.clear();
            this.usedBarrierIds.clear();
            this.currentState = { ...this.currentState, resultCache: {} };
        }
        const owned = recipeExecution === undefined
            ? undefined
            : this.ownedRecipeExecutions.get(recipeExecution.rootCommandId);
        const submitted = snapshotAdmittedRecipeCommand(command, owned?.command);
        const captureSequence = submitted.kind === 'configure' ? this.captureDefaults : this.captureDefaults.fork();
        const cacheOwner = this.cacheOwner;
        const identity = this.controlIdentity;
        const loadedRecipe = owned?.loadedRecipe ?? this.loadedRecipe;
        const selection = owned?.selection ?? eventHistorySelection;
        const accepted = this.toCommandWithId(submitted);
        return await this.runCommand({
            command: accepted,
            eventHistory: selection?.policy,
            eventHistoryRunOverride: selection?.runOverride ?? false,
            cachePolicy: 'replay',
            captureSequence,
            cacheOwner,
            resultRootCommandId: accepted.commandId,
            control: identity && Object.freeze({ ...identity, rootCommandId: accepted.commandId }),
            loadedRecipe,
            executionRecipes: owned?.executionRecipes ?? { loadedRecipe },
            recipeExecution
        });
    }

    private async runCommand(
        input: InMemoryRallarBlackBoxTestRuntime.RunCommandInput
    ): Promise<RallarBlackBoxTestResult> {
        const { command, cachePolicy, cacheOwner, control, resultRootCommandId } = input;
        const admission = this.toCommandAdmission(input);
        const commandWithId = this.toCommandWithId(command);
        const cached = this.currentState.resultCache[commandWithId.commandId];
        if (!cached && this.releasedCommands.has(commandWithId.commandId)) {
            return toReleasedRuntimeReplay(commandWithId, this.dependencies.now());
        }
        const bindingFailure = resolveRecipeBodyBindingFailure(
            commandWithId,
            admission.loadedRecipe?.recipeBodyId,
            cached && cachePolicy === 'replay' ? cached : undefined
        );
        if (bindingFailure) {
            return this.commitResult({
                command: commandWithId,
                startedAtEpochMs: this.dependencies.now(),
                outcome: bindingFailure,
                cacheOwner,
                resultRootCommandId,
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
                resultRootCommandId,
                control
            });
        }

        const historyAdmission = this.admitEventHistory(commandWithId, admission);
        const refusal = historyAdmission.failure ?? this.admitCommand(commandWithId, cachePolicy);
        if (refusal !== undefined && admission.recipeExecution !== undefined && cacheOwner === this.cacheOwner) {
            this.ownedRecipeExecutions.delete(admission.recipeExecution.rootCommandId);
        }
        return refusal
            ? this.commitResult({
                command: commandWithId,
                startedAtEpochMs: this.dependencies.now(),
                outcome: refusal,
                cacheOwner,
                resultRootCommandId,
                control
            })
            : await this.runRegisteredCommand(commandWithId, cachePolicy, historyAdmission.admission);
    }

    private toCommandAdmission(
        input: InMemoryRallarBlackBoxTestRuntime.RunCommandInput
    ): InMemoryRallarBlackBoxTestRuntime.CommandAdmission {
        const { command, captureSequence, cacheOwner, control, resultRootCommandId } = input;
        return {
            captureSequence,
            resultRootCommandId,
            eventHistory: input.eventHistory,
            eventHistoryRunOverride: input.eventHistoryRunOverride,
            cacheOwner,
            control,
            loadedRecipe: command.kind === 'recipe.run' && command.recipe === undefined
                ? input.loadedRecipe
                : undefined,
            executionRecipes: input.executionRecipes,
            recipeExecution: input.recipeExecution
        };
    }

    private admitEventHistory(
        command: CommandWithId,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): InMemoryRallarBlackBoxTestRuntime.HistoryAdmission {
        const resolved = resolveRecipeEventHistoryAdmission({
            command,
            loadedRecipe: admission.loadedRecipe?.recipe,
            executionLoadedRecipe: admission.executionRecipes.loadedRecipe?.recipe,
            configuredPolicy: this.configuredEventHistory,
            currentHistory: this.currentState.eventHistory,
            activeExecutions: this.activeTopLevelCount + this.ownedRecipeExecutions.size,
            admittedPolicy: admission.eventHistory,
            admittedRunOverride: admission.eventHistoryRunOverride,
            execution: admission.recipeExecution
        });
        return {
            admission: resolved.selection === undefined ? admission : {
                ...admission,
                eventHistory: resolved.selection.policy,
                eventHistoryRunOverride: resolved.selection.runOverride
            },
            failure: resolved.failure
        };
    }

    private applyEventHistoryPolicy(policy: RallarBlackBoxEventHistoryPolicy): void {
        if (!isSameEventHistoryPolicy(policy, this.currentState.eventHistory.policy)) {
            this.setState(
                computeRetainedEventHistory(this.currentState.eventHistory, this.currentState.events, policy)
            );
        }
    }

    /** Refusal leaves resource ownership unchanged; accepted idle close fences effects before any notification. */
    private admitCommand(
        command: CommandWithId,
        cachePolicy: ResultCachePolicy
    ): RallarBlackBoxTestCommandOutcome | undefined {
        const refusal = resolveRuntimeCleanupRefusal({
            command,
            cachePolicy,
            cleanupInProgress: this.targetedCleanup !== undefined,
            activeTopLevelCount: this.activeTopLevelCount,
            exclusiveTopLevelCommandId: this.exclusiveTopLevelCommandId,
            status: this.currentState.status
        });
        if (refusal !== undefined) {
            return refusal;
        }
        if (isTargetedRuntimeClose(command)) {
            this.exclusiveTopLevelCommandId = undefined;
            this.targetedCleanup = {
                targetCommandId: command.targetCommandId,
                targetSettled: true,
                requestSettled: false
            };
        }
        return undefined;
    }

    /** Acquire the admitted outer lease before retained-policy application or subscriber notification. */
    private registerRecipeExecution(
        commandWithId: CommandWithId,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): void {
        if (
            commandWithId.kind === 'recipe.run' && admission.recipeExecution !== undefined &&
            admission.eventHistory !== undefined
        ) {
            this.ownedRecipeExecutions.set(admission.recipeExecution.rootCommandId, {
                command: commandWithId,
                loadedRecipe: admission.loadedRecipe,
                selection: Object.freeze({
                    policy: admission.eventHistory,
                    runOverride: admission.eventHistoryRunOverride
                }),
                executionRecipes: admission.executionRecipes,
                commandId: commandWithId.commandId
            });
        }
    }

    /** Owns actual invocation registration and final settlement, including nested execution accounting. */
    private async runRegisteredCommand(
        commandWithId: CommandWithId,
        cachePolicy: ResultCachePolicy,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestResult> {
        const targetedClose = isTargetedRuntimeClose(commandWithId);
        const ownsExecution = isTopLevelResourceExecution(commandWithId, cachePolicy);
        if (ownsExecution) {
            this.exclusiveTopLevelCommandId = this.activeTopLevelCount === 0 ? commandWithId.commandId : undefined;
            this.activeTopLevelCount += 1;
        }

        if (commandWithId.kind !== 'recipe.cancel' && !targetedClose) {
            this.clearAbortedCancellation();
        }
        this.activeExecutionCount += 1;
        this.registerRecipeExecution(commandWithId, admission);
        let succeeded = false;
        try {
            if (commandWithId.kind === 'recipe.run' && admission.eventHistory !== undefined) {
                this.applyEventHistoryPolicy(admission.eventHistory);
            }
            const result = await this.runUncachedCommand(commandWithId, admission);
            succeeded = result.ok;
            return result;
        }
        finally {
            this.activeExecutionCount -= 1;
            if (
                admission.cacheOwner === this.cacheOwner && admission.recipeExecution !== undefined &&
                (!succeeded || admission.recipeExecution.last)
            ) {
                this.ownedRecipeExecutions.delete(admission.recipeExecution.rootCommandId);
            }
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
        if (admission.cacheOwner === this.cacheOwner && isAcceptedRuntimeCleanup(commandWithId, outcome)) {
            this.releaseOwnedRecipeExecutions(commandWithId.targetCommandId);
        }
        return this.commitResult({
            command: commandWithId,
            startedAtEpochMs,
            outcome,
            cacheOwner: admission.cacheOwner,
            resultRootCommandId: admission.resultRootCommandId,
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
        const unavailable = resolveReleasedResultReference(command, {
            releasedCommands: this.releasedCommands,
            ownedResultEvents: this.ownedResultEvents,
            state: this.currentState
        });
        if (unavailable) {
            return unavailable;
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
        if (config.eventHistory !== undefined) {
            this.configuredEventHistory = Object.freeze({ ...config.eventHistory });
        }
        const redactedConfig = this.toRedacted(this.currentConfig);
        if (config.eventHistory !== undefined) {
            this.applyEventHistoryPolicy(config.eventHistory);
        }
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
        ownership: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
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
        ownership.executionRecipes.loadedRecipe = accepted;
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
            eventHistory: admission.eventHistory ?? this.currentState.eventHistory.policy,
            ...(admission.recipeExecution?.segment === undefined ? {} : { segment: admission.recipeExecution.segment }),
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
                segment: admission.recipeExecution?.segment,
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
        this.currentState = createInitialRuntimeState(createEventHistory(
            this.currentState.eventHistory.policy,
            {
                runtimeId: this.currentState.eventHistory.runtimeId,
                generation: this.currentState.eventHistory.generation + 1
            },
            this.currentState.eventHistory.capture
        ));
        this.releasedCommands.clear();
        this.releasedReceipts.clear();
        this.currentConfig = undefined;
        this.usedBarrierIds.clear();
        this.captureDefaults.configure({});
        this.loadedRecipe = undefined;
        this.ownedRecipeExecutions.clear();
        admission.executionRecipes.loadedRecipe = undefined;
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
                return await this.waitAtBarrier(command, admission);
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

    private async waitAtBarrier(
        command: CommandOfKind<'barrier'>,
        admission: InMemoryRallarBlackBoxTestRuntime.CommandAdmission
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        return await waitForBarrier({
            command,
            reserveBarrier: (barrierId) => {
                if (this.usedBarrierIds.has(barrierId)) {
                    return false;
                }
                this.usedBarrierIds.add(barrierId);
                return true;
            },
            recordEvent: (event) => {
                this.appendEvent(event, admission);
            },
            ...this.toWaitPorts()
        });
    }

    private toWaitPorts(): Omit<WaitForEventInput, 'command'> {
        return {
            now: this.dependencies.now,
            sleep: this.dependencies.sleep,
            cancellationSignal: this.cancellationController.signal,
            cancelRequested: () => this.cancellationController.signal.aborted,
            currentStatus: () => this.currentState.status,
            currentEvents: () => this.currentState.events,
            currentEventHistory: () => this.currentState.eventHistory,
            resultCache: this.currentState.resultCache,
            subscribe: (listener) => this.subscribe((state) => listener(state.events, state.eventHistory))
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
        const admittedState = this.currentState;
        return {
            rtcCapture: captureSequence?.get(),
            state: () => this.currentState,
            config: () => this.currentConfig,
            abortSignal: () => this.cancellationController.signal,
            recordEvent: (event) => {
                this.appendEvent(event, ownership);
            },
            updateStats: (commandId) => this.readAdmittedStats(commandId, { ownership, admittedState })
        };
    }

    private async readAdmittedStats(
        commandId: string | undefined,
        reading: InMemoryRallarBlackBoxTestRuntime.AdmittedStatsReading
    ): Promise<RallarBlackBoxTestStatsSnapshot> {
        return reading.ownership.cacheOwner === this.cacheOwner
            ? this.updateStats(commandId, reading.ownership)
            : toRuntimeStats(reading.admittedState, this.dependencies.now());
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
                    eventHistory: admission.eventHistory,
                    eventHistoryRunOverride: admission.eventHistoryRunOverride,
                    captureSequence,
                    cacheOwner,
                    resultRootCommandId: admission.resultRootCommandId,
                    control,
                    loadedRecipe: admission.executionRecipes.loadedRecipe,
                    executionRecipes: admission.executionRecipes,
                    recipeExecution: undefined
                }),
            forkChildCommands: () => {
                const groupCapture = captureSequence.fork();
                return (command) =>
                    this.runCommand({
                        command,
                        cachePolicy: 'bypass',
                        eventHistory: admission.eventHistory,
                        eventHistoryRunOverride: admission.eventHistoryRunOverride,
                        captureSequence: groupCapture,
                        cacheOwner,
                        resultRootCommandId: admission.resultRootCommandId,
                        control,
                        loadedRecipe: admission.executionRecipes.loadedRecipe,
                        executionRecipes: admission.executionRecipes,
                        recipeExecution: undefined
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
            capture: {
                runtimeId: this.currentState.eventHistory.runtimeId,
                generation: this.currentState.eventHistory.generation,
                assignment: this.resultAssignment,
                ordinal: ++this.resultOrdinal,
                rootCommandId: input.resultRootCommandId
            },
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
            resultHistory: computeAppendedResultHistory(this.currentState.resultHistory, result),
            commandHistory: [...this.currentState.commandHistory, result],
            failures: result.ok ? this.currentState.failures : [...this.currentState.failures, result],
            resultCache: { ...this.currentState.resultCache, [result.commandId]: result }
        };
        this.appendEvent(
            {
                kind: 'result',
                topic: 'rallar.bb.command.result',
                commandId: result.commandId,
                severity: result.ok ? 'info' : 'error',
                payload: toCommandResultEventPayload(result)
            },
            input,
            true
        );
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
        ownership?: InMemoryRallarBlackBoxTestRuntime.EventOwnership,
        ownsResult = false
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
            payload: this.toRedacted(event.payload),
            history: {
                runtimeId: this.currentState.eventHistory.runtimeId,
                generation: this.currentState.eventHistory.generation,
                ordinal: this.currentState.eventHistory.totalEvents + 1
            }
        };
        if (ownership && ownership.cacheOwner !== this.cacheOwner) {
            return;
        }
        if (ownsResult) {
            this.ownedResultEvents.add(created);
        }
        this.currentState = { ...this.currentState, ...computeAppendedEventHistory(this.currentState, created) };
        this.notify();
    }

    private setState(patch: Partial<RallarBlackBoxTestState>): void {
        this.currentState = { ...this.currentState, ...patch };
        this.notify();
    }

    private notify(): void {
        this.pendingNotifications.push(this.currentState);
        if (this.notifying) {
            return;
        }
        this.notifying = true;
        try {
            let state = this.pendingNotifications.shift();
            while (state) {
                for (const listener of this.listeners) {
                    notifyListener(listener, state);
                }
                state = this.pendingNotifications.shift();
            }
        }
        finally {
            this.notifying = false;
        }
    }

    private toCommandWithId(command: RallarBlackBoxTestCommand): CommandWithId {
        return { ...command, commandId: command.commandId ?? this.dependencies.idFactory('command') };
    }

    private toRedacted<T>(value: T): T {
        return redactRallarBlackBoxValue(value, this.currentConfig?.redaction);
    }
}

function createInitialRuntimeState(eventHistory: RallarBlackBoxTestState['eventHistory']): RallarBlackBoxTestState {
    return {
        eventHistory,
        resultHistory: createRuntimeResultHistory(),
        connection: { connected: false, peerCount: undefined, laneHealth: undefined },
        status: 'idle',
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {}
    };
}

function toAssignmentChangedOutcome(): RallarBlackBoxTestCommandOutcome {
    return toInvalidRecipeOutcome(['Control assignment changed before this command could execute.']);
}
