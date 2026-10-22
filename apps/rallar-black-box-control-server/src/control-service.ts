import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { ControlBarrierEnvelope } from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlHeartbeatEnvelope,
    type ControlRegisterEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    planControlRunRetention,
    resolveRemovedControlRunIds,
    type ControlRetentionPlan
} from '@shared-test/rallar-bb-test/control-retention.ts';
import type {
    ControlDistributedRunCommandPhase,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlRunSnapshotBounds,
    ControlRunToken,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    isAdmissibleControlRtcCaptureResult
} from '@shared-test/rallar-bb-test/control/control-rtc-capture-evidence.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedRunRollup
} from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import {
    resolveDistributedRunTargets,
    toDistributedRecipeKey
} from '@shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';
import type {
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRedactionOptions
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { snapshotExecutableCommand } from '@shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts';
import { Either } from '@shared/resilience/Either.ts';

import { markControlAgentHeartbeat, markControlAgentRegistered } from './agent-session/control-agent-presence.ts';
import { hasActiveControlRunToken, isValidControlRunToken } from './agent-session/control-run-tokens.ts';
import { toDuplicateAgentSocketDiagnostic } from './control-agent-sockets.ts';
import {
    computeControlCommandQueueWrite,
    computeDispatchableControlCommands,
    toCommandIdSegment,
    toControlCommandDispatchEnvelope,
    toControlDispatchScan,
    toControlRunEvidenceView,
    type ControlDispatchScan
} from './control-command-queue-policy.ts';
import {
    toCompactedControlReport,
    toControlReportDedupeKey,
    toSettledAssessmentCommandIds,
    toStoredControlResultEnvelope
} from './control-evidence-compaction.ts';
import {
    clearControlRunEvidence,
    trimControlReportDedupeKeys,
    trimControlRunEvidence
} from './control-runtime-retention.ts';
import {
    toControlServiceFailure,
    toDistributedRunNotFound,
    toDistributedRunTerminal,
    toRunCompleted,
    type ControlServiceFailure
} from './control-service-failure.ts';
import {
    toControlCommandSnapshot,
    toControlLifecycleRevision,
    toControlRetentionRunSafety,
    toControlRunSnapshot,
    toControlSnapshotRevision,
    toDistributedRunSnapshot,
    toPassiveDistributedRunSnapshot,
    toRestoredControlSnapshot,
    type ControlSnapshotRevision
} from './control-service-snapshots.ts';
import {
    toInitialControlAgentState,
    toInitialControlDistributedRunState,
    toInitialControlRunState,
    type ControlAgentState,
    type ControlCommandState,
    type ControlDistributedRunState,
    type ControlRunState,
    type ControlTokenState
} from './control-service-state.ts';
import {
    bindDistributedAlmReloadCommands,
    toDistributedBarrierCommands,
    toDistributedCancelCommands,
    toDistributedStageCommands,
    toDistributedStartCommands,
    toReconciledDistributedRunFields,
    toScheduledStartEpochMs,
    type DistributedPhaseCommand
} from './distributed/distributed-run-commands.ts';
import type { DistributedRunEvaluationInput } from './distributed/distributed-run-evaluation.ts';
import {
    resolveDistributedRunAdvance,
    resolveDistributedRunStartStep,
    toQueuedDistributedPhaseFields,
    type DistributedRunLifecycleInput,
    type DistributedRunNextStep
} from './distributed/distributed-run-lifecycle.ts';
import {
    DISTRIBUTED_TARGET_STALE_AFTER_MS,
    isResolvedTargetPolicy,
    toControlAgentCandidates,
    toDistributedTargetAgentIds,
    toDistributedTargetFailure,
    toExplicitDistributedTargetResolution,
    toNormalizedDistributedRunManifest
} from './distributed/distributed-run-targeting.ts';
import {
    createControlFleetAggregateReport,
    filterControlFleetReports,
    type FleetReportFilter
} from './fleet/control-fleet-aggregate-report.ts';
import { createControlFleetReportBundle } from './fleet/create-control-fleet-report-bundle.ts';
import { createControlFleetRunReport } from './fleet/create-control-fleet-run-report.ts';
import {
    computeControlRecipeBarrierArrival,
    computeControlRecipeBarrierDelivery,
    recordControlRecipeBarrierResolutionTiming
} from './recipe-barrier/compute-control-recipe-barrier.ts';
import {
    computeControlRecipeReloadStep,
    computeReloadRootDeadline,
    toCancelledControlRecipeReload,
    toControlRecipeReloadCancellationRoots
} from './recipe-reload/compute-control-recipe-reload-step.ts';
import {
    resolveControlRecipeReloadOwner,
    toPendingControlRecipeReloadRoots,
    validateControlRecipeReloadEnqueue
} from './recipe-reload/control-recipe-reload-commands.ts';
import {
    computeControlRecipeReloadCompletionWrite,
    isAdmissibleControlRecipeReloadResult
} from './recipe-reload/control-recipe-reload-evidence.ts';
import {
    computeControlReloadCleanupRefusal,
    hasControlReloadCleanup,
    isAdmissibleControlReloadCleanupResult,
    toControlReloadCleanup,
    toControlReloadCleanupSuccessor
} from './recipe-reload/control-reload-cleanup.ts';
import {
    toReloadCleanupFailureResult,
    toReloadCompletionResult
} from './recipe-reload/control-reload-completion-result.ts';
import {
    completeControlRun,
    markControlRunFileMissing,
    resolveArchivableControlRun,
    resolveCompletableControlRunIds,
    resolveLiveControlRun,
    type ArchiveCompletedRunInput,
    type ControlRunCompletionSnapshot
} from './run-completion/control-run-completion.ts';

export interface RallarBlackBoxControlServiceDependencies {
    readonly now: () => number;
    readonly createCommandId: () => string;
    readonly createRunToken: () => string;
    readonly toDistributedRunRollup: (input: DistributedRunEvaluationInput) => RallarBlackBoxDistributedRunRollup;
    /** Absent when barrier resolutions are not timed. */
    readonly timingSink: RallarTimingSink | undefined;
}

export interface RallarBlackBoxControlServiceConfig {
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
    readonly allowedCommandKinds: readonly string[] | undefined;
    readonly commandRateLimitMax: number;
    readonly commandRateLimitWindowMs: number;
    readonly runtimeRetentionBounds: ControlRunSnapshotBounds;
}

export interface CreateRallarBlackBoxControlServiceInput {
    readonly dependencies: RallarBlackBoxControlServiceDependencies;
    readonly config: RallarBlackBoxControlServiceConfig;
}

export interface EnqueueControlCommandInput {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId?: string;
    readonly command: RallarBlackBoxTestCommand;
    readonly deadlineEpochMs?: number;
}

export interface IssueControlRunTokenInput {
    readonly runId: string;
    readonly agentId: string;
    readonly ttlMs: number;
}

export interface RallarBlackBoxControlServiceReceiveResult {
    readonly kind: ControlClientEnvelope['kind'];
    readonly runId: string;
    readonly agentId: string;
    readonly accepted: boolean;
    /** False when the envelope makes no command or barrier due at once; time-driven work is the deadline sweep's. */
    readonly affectsDispatch: boolean;
}

interface ControlEnvelopeReceipt {
    readonly accepted: boolean;
    readonly affectsDispatch: boolean;
}

const DISPATCH_RECEIPT: ControlEnvelopeReceipt = { accepted: true, affectsDispatch: true };
/** Time-driven work a heartbeat used to trigger is judged by the deadline sweep instead. */
const HEARTBEAT_RECEIPT: ControlEnvelopeReceipt = { accepted: true, affectsDispatch: false };
/** A completed run's rows live in its file; nothing is appended to it. */
const COMPLETED_RUN_RECEIPT: ControlEnvelopeReceipt = { accepted: false, affectsDispatch: false };

interface ControlRetentionDeletion {
    readonly deletedRunIds: readonly string[];
    readonly distributedRunIds: readonly string[];
    readonly fleetReportIds: readonly string[];
}

export class RallarBlackBoxControlService {
    private readonly dependencies: RallarBlackBoxControlServiceDependencies;
    private readonly config: RallarBlackBoxControlServiceConfig;
    private readonly allowedCommandKinds: ReadonlySet<string> | undefined;
    private readonly runs = new Map<string, ControlRunState>();
    private readonly distributedRuns = new Map<string, ControlDistributedRunState>();
    private readonly fleetReports = new Map<string, ControlFleetRunReport>();

    constructor(input: CreateRallarBlackBoxControlServiceInput) {
        this.dependencies = input.dependencies;
        this.config = input.config;
        this.allowedCommandKinds = input.config.allowedCommandKinds
            ? new Set(input.config.allowedCommandKinds)
            : undefined;
    }

    receiveClientEnvelope(envelope: ControlClientEnvelope): RallarBlackBoxControlServiceReceiveResult {
        const receipt = this.receiveEnvelope(envelope);
        return {
            kind: envelope.kind,
            runId: envelope.runId,
            agentId: envelope.agentId,
            accepted: receipt.accepted,
            affectsDispatch: receipt.affectsDispatch
        };
    }

    enqueueCommand(input: EnqueueControlCommandInput): Either<ControlServiceFailure, ControlCommandEnvelope> {
        if (this.runs.get(input.runId)?.completion !== undefined) {
            return toRunCompleted(input.runId);
        }
        const run = this.ensureRun(input.runId);
        const agent = this.ensureAgent(run, input.agentId);
        const envelope: ControlCommandEnvelope = {
            kind: 'command',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: input.runId,
            agentId: input.agentId,
            commandId: input.commandId ?? this.dependencies.createCommandId(),
            command: snapshotExecutableCommand(input.command),
            deadlineEpochMs: input.deadlineEpochMs
        };
        if (hasControlReloadCleanup(envelope)) {
            return toControlServiceFailure(
                'command-payload-conflict',
                'Reload cleanup is owned by its paired control execution.'
            );
        }
        const issues = validateControlRecipeReloadEnqueue(run, envelope);
        if (issues.length > 0) {
            return toControlServiceFailure('command-payload-conflict', issues.join(' '));
        }
        const queued = this.queueCommand(run, agent, envelope);
        if (
            queued.right &&
            ((envelope.command.kind === 'recipe.cancel' && envelope.command.targetCommandId === undefined) ||
                envelope.command.kind === 'reset')
        ) {
            this.cancelReloadRecipes(run, input.agentId);
        }
        return queued;
    }

    private queueCommand(
        run: ControlRunState,
        agent: ControlAgentState,
        envelope: ControlCommandEnvelope
    ): Either<ControlServiceFailure, ControlCommandEnvelope> {
        const write = computeControlCommandQueueWrite({
            envelope,
            existing: run.commands.get(envelope.commandId),
            allowedKinds: this.allowedCommandKinds,
            rate: {
                enqueueTimestamps: agent.commandEnqueueTimestamps,
                nowEpochMs: this.dependencies.now(),
                maxCommands: this.config.commandRateLimitMax,
                windowMs: this.config.commandRateLimitWindowMs
            }
        });
        agent.commandEnqueueTimestamps = [...write.enqueueTimestamps];
        if (write.command) {
            run.commands.set(envelope.commandId, write.command);
            this.touch(run);
            trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        }
        return write.result;
    }

    issueRunToken(input: IssueControlRunTokenInput): ControlRunToken {
        const run = this.ensureRun(input.runId);
        this.ensureAgent(run, input.agentId);
        const issuedAtEpochMs = this.dependencies.now();
        const token: ControlTokenState = {
            runId: input.runId,
            agentId: input.agentId,
            token: this.dependencies.createRunToken(),
            issuedAtEpochMs,
            expiresAtEpochMs: issuedAtEpochMs + Math.max(1, input.ttlMs)
        };
        run.tokens.set(token.token, token);
        run.issuedRunTokenStateRevision += 1;
        this.touch(run);
        return token;
    }

    hasActiveRunToken(runId: string, agentId: string): boolean {
        return hasActiveControlRunToken(this.runs.get(runId), agentId, this.dependencies.now());
    }

    validateRunToken(runId: string, agentId: string, token: string | undefined): boolean {
        return isValidControlRunToken({
            run: this.runs.get(runId),
            agentId,
            token,
            nowEpochMs: this.dependencies.now()
        });
    }

    createDistributedRun(
        manifest: RallarBlackBoxDistributedRunManifest
    ): Either<ControlServiceFailure, ControlDistributedRunSnapshot> {
        if (this.distributedRuns.has(manifest.distributedRunId)) {
            return toControlServiceFailure(
                'distributed-run-exists',
                `Distributed run ${manifest.distributedRunId} already exists.`
            );
        }

        const normalized = toNormalizedDistributedRunManifest(manifest);
        if (this.runs.get(normalized.controlRunId)?.completion !== undefined) {
            return toRunCompleted(normalized.controlRunId);
        }
        this.ensureRun(normalized.controlRunId);
        const now = this.dependencies.now();
        const distributedRun = toInitialControlDistributedRunState(normalized.manifest, normalized.controlRunId, now);
        this.refreshDistributedTargetResolution(distributedRun);
        this.distributedRuns.set(distributedRun.distributedRunId, distributedRun);
        return Either.ofRight(this.refreshDistributedRunSnapshot(distributedRun));
    }

    resolveDistributedRunTargets(
        manifest: RallarBlackBoxDistributedRunManifest
    ): RallarBlackBoxDistributedTargetResolution {
        const normalized = toNormalizedDistributedRunManifest(manifest);
        return resolveDistributedRunTargets({
            manifest: normalized.manifest,
            agents: toControlAgentCandidates(this.runs.get(normalized.controlRunId)),
            nowEpochMs: this.dependencies.now(),
            staleAfterMs: DISTRIBUTED_TARGET_STALE_AFTER_MS
        });
    }

    listDistributedRuns(): readonly ControlDistributedRunSnapshot[] {
        return Array.from(
            this.distributedRuns.values(),
            (distributedRun) => this.refreshDistributedRunSnapshot(distributedRun)
        );
    }

    snapshotDistributedRun(distributedRunId: string): ControlDistributedRunSnapshot | undefined {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        return distributedRun ? this.refreshDistributedRunSnapshot(distributedRun) : undefined;
    }

    stageDistributedRun(distributedRunId: string): Either<ControlServiceFailure, ControlDistributedRunSnapshot> {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            return toDistributedRunNotFound(distributedRunId);
        }
        if (isDistributedRunTerminalState(distributedRun.state)) {
            return toDistributedRunTerminal(distributedRun, 'stage');
        }

        if (distributedRun.stagedAtEpochMs === undefined && distributedRun.startedAtEpochMs === undefined) {
            this.refreshDistributedTargetResolution(distributedRun);
        }
        distributedRun.updatedAtEpochMs = this.dependencies.now();
        const failure = this.failUnresolvedDistributedTargets(distributedRun)
            ? undefined
            : this.queueDistributedPhase(distributedRun, 'stage', toDistributedStageCommands(distributedRun));
        return failure ? Either.ofLeft(failure) : Either.ofRight(this.refreshDistributedRunSnapshot(distributedRun));
    }

    startDistributedRun(distributedRunId: string): Either<ControlServiceFailure, ControlDistributedRunSnapshot> {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            return toDistributedRunNotFound(distributedRunId);
        }
        this.refreshDistributedRunState(distributedRun);
        if (isDistributedRunTerminalState(distributedRun.state)) {
            return toDistributedRunTerminal(distributedRun, 'start');
        }

        if (distributedRun.targetAgentIds.length === 0) {
            this.refreshDistributedTargetResolution(distributedRun);
        }
        const failure = this.failUnresolvedDistributedTargets(distributedRun)
            ? undefined
            : this.applyDistributedRunStep(
                distributedRun,
                resolveDistributedRunStartStep(this.toLifecycleInput(distributedRun))
            );
        return failure ? Either.ofLeft(failure) : Either.ofRight(this.refreshDistributedRunSnapshot(distributedRun));
    }

    cancelDistributedRun(
        distributedRunId: string,
        reason: string
    ): Either<ControlServiceFailure, ControlDistributedRunSnapshot> {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            return toDistributedRunNotFound(distributedRunId);
        }

        const failure = isDistributedRunTerminalState(distributedRun.state)
            ? undefined
            : this.queueDistributedCancel(distributedRun, reason);
        return failure ? Either.ofLeft(failure) : Either.ofRight(this.refreshDistributedRunSnapshot(distributedRun));
    }

    listFleetReports(filter: FleetReportFilter): ControlFleetReportsResponse {
        this.ensureFleetReports();
        const reports = filterControlFleetReports([...this.fleetReports.values()], filter);
        return {
            reports,
            aggregate: createControlFleetAggregateReport(reports, this.dependencies.now())
        };
    }

    snapshotFleetReport(distributedRunId: string): ControlFleetRunReport | undefined {
        return this.ensureFleetReport(distributedRunId);
    }

    createFleetReportBundle(distributedRunId: string): ControlFleetReportBundle | undefined {
        const report = this.ensureFleetReport(distributedRunId);
        return report ? createControlFleetReportBundle(report, this.dependencies.now()) : undefined;
    }

    rebuildFleetReports(): ControlFleetReportsResponse {
        this.fleetReports.clear();
        this.ensureFleetReports();
        return this.listFleetReports({});
    }

    takeDispatchableCommandsForAgents(
        runId: string,
        agentIds: readonly string[]
    ): ReadonlyMap<string, readonly ControlCommandEnvelope[]> {
        this.refreshDistributedRunsForControlRun(runId);
        const run = this.runs.get(runId);
        if (!run) {
            return new Map();
        }
        this.advanceReloadRecipes(run);
        const scan = toControlDispatchScan(run);
        return new Map(agentIds.map((agentId) => [agentId, this.takeAgentDispatchableCommands(scan, agentId)]));
    }

    private takeAgentDispatchableCommands(
        scan: ControlDispatchScan,
        agentId: string
    ): readonly ControlCommandEnvelope[] {
        const run = scan.run;
        const agent = run.agents.get(agentId);
        if (!agent?.connected) {
            return [];
        }

        const nowEpochMs = this.dependencies.now();
        const dispatchable = computeDispatchableControlCommands({ scan, agent, nowEpochMs });
        for (const command of dispatchable) {
            const owner = scan.reloadOwners.get(command.envelope.commandId);
            if (owner) {
                owner.dispatchedAtEpochMs ??= nowEpochMs;
            }
            command.dispatchedAtEpochMs = nowEpochMs;
            command.lastDispatchedConnectionSequence = agent.connectionSequence;
            command.dispatchCount += 1;
        }
        if (dispatchable.length > 0) {
            this.touch(run);
        }
        return dispatchable.map((command) => toControlCommandDispatchEnvelope({ scan, command, agent }));
    }

    takeBarrierResolutions(runId: string, agentId: string): readonly ControlBarrierEnvelope[] {
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent?.connected) {
            return [];
        }
        const nowEpochMs = this.dependencies.now();
        const delivery = computeControlRecipeBarrierDelivery({ run, agent, nowEpochMs });
        delivery.barriers.forEach((barrier) => run.barriers.set(barrier.barrierId, barrier));
        delivery.resolved.forEach((barrier) =>
            recordControlRecipeBarrierResolutionTiming(this.dependencies.timingSink, barrier, nowEpochMs)
        );
        return delivery.envelopes;
    }

    markAgentDisconnected(runId: string, agentId: string): void {
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent) {
            return;
        }

        agent.connected = false;
        agent.disconnectedAtEpochMs = this.dependencies.now();
        agent.lastSeenAtEpochMs = agent.disconnectedAtEpochMs;
        this.touch(run);
        this.refreshDistributedRunsForControlRun(runId);
    }

    resetRun(runId: string): ControlRunSnapshot | undefined {
        const run = this.runs.get(runId);
        if (!run) {
            return undefined;
        }

        clearControlRunEvidence(run);
        this.touch(run);
        return toControlRunSnapshot(run, {}, this.distributedRuns.values());
    }

    deleteRun(runId: string): boolean {
        if (!this.runs.has(runId)) {
            return false;
        }
        return this.deleteControlRunRecords([runId]).length === 1;
    }

    applyRunRetention(maxRuns: number | undefined): readonly string[] {
        return this.deleteControlRunRecords(resolveRemovedControlRunIds(this.runs.values(), maxRuns, 'any'));
    }

    applyCompletedRunRetention(maxRuns: number | undefined): readonly string[] {
        return this.deleteControlRunRecords(resolveRemovedControlRunIds(this.runs.values(), maxRuns, 'completed'));
    }

    createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan {
        return planControlRunRetention({
            maxRuns,
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, {}, this.distributedRuns.values())),
            distributedRuns: Array.from(this.distributedRuns.values(), toPassiveDistributedRunSnapshot),
            fleetReports: Array.from(this.fleetReports.values()),
            runSafety: Array.from(this.runs.values(), toControlRetentionRunSafety)
        });
    }

    applyRetentionPlan(plan: ControlRetentionPlan): readonly string[] {
        return this.deleteRetainedRecords({
            deletedRunIds: plan.deletedRunIds,
            distributedRunIds: plan.distributedRunIds,
            fleetReportIds: plan.fleetReportIds
        });
    }

    restoreSnapshot(snapshot: ControlServerSnapshot): void {
        const restored = toRestoredControlSnapshot(snapshot, this.config.redaction);
        this.runs.clear();
        this.distributedRuns.clear();
        this.fleetReports.clear();
        for (const [runId, run] of restored.runs) {
            this.runs.set(runId, run);
        }
        for (const [distributedRunId, distributedRun] of restored.distributedRuns) {
            this.distributedRuns.set(distributedRunId, distributedRun);
        }
        for (const report of snapshot.fleetReports ?? []) {
            this.fleetReports.set(report.distributedRunId, report);
        }
    }

    snapshot(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            ...this.snapshotForPersistence(bounds),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: this.listFleetReports({}).reports
        };
    }

    /** Carries each distributed run's latest rollup; every dispatch-affecting message has already refreshed it. */
    snapshotForPersistence(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            runs: Array.from(
                this.runs.values(),
                (run) => toControlRunSnapshot(run, bounds, this.distributedRuns.values())
            ),
            distributedRuns: Array.from(this.distributedRuns.values(), toPassiveDistributedRunSnapshot),
            fleetReports: Array.from(this.fleetReports.values())
        };
    }

    snapshotRevision(): ControlSnapshotRevision {
        return toControlSnapshotRevision({
            runs: this.runs.values(),
            distributedRuns: this.distributedRuns.values(),
            fleetReports: this.fleetReports.values()
        });
    }

    snapshotLifecycleRevision(): string {
        return toControlLifecycleRevision(this.distributedRuns.values());
    }

    snapshotRun(runId: string, bounds: ControlRunSnapshotBounds = {}): ControlRunSnapshot | undefined {
        const run = this.runs.get(runId);
        if (run) {
            this.advanceReloadRecipes(run);
        }
        return run ? toControlRunSnapshot(run, bounds, this.distributedRuns.values()) : undefined;
    }

    snapshotCommand(runId: string, commandId: string): ControlQueuedCommandSnapshot | undefined {
        const command = this.runs.get(runId)?.commands.get(commandId);
        return command ? toControlCommandSnapshot(command) : undefined;
    }

    recordDuplicateAgentSocketReplacement(runId: string, agentId: string): void {
        this.receiveEvent(toDuplicateAgentSocketDiagnostic(runId, agentId, this.dependencies.now()));
    }

    resolveCompletableRunIds(quietSinceEpochMs: number): readonly string[] {
        const distributedRuns = this.distributedRuns.values();
        return resolveCompletableControlRunIds({ runs: this.runs.values(), distributedRuns, quietSinceEpochMs });
    }

    /** The run's every row, with its fleet reports generated while the rows are still here. */
    snapshotRunForCompletion(runId: string): ControlRunCompletionSnapshot | undefined {
        const run = resolveLiveControlRun(this.runs.get(runId));
        if (run === undefined) {
            return undefined;
        }
        this.ensureFleetReports();
        return {
            snapshot: toControlRunSnapshot(run, {}, this.distributedRuns.values()),
            retentionRevision: run.retentionRevision
        };
    }

    /** Replaces the run's rows by its completion; a run that changed since the rows were written keeps them. */
    archiveCompletedRun(input: ArchiveCompletedRunInput): Either<ControlServiceFailure, ControlRunSnapshot> {
        return resolveArchivableControlRun(this.runs.get(input.runId), input).mapRight((run) => {
            completeControlRun(run, input.completion);
            this.touch(run);
            return toControlRunSnapshot(run, {}, this.distributedRuns.values());
        });
    }

    markCompletedRunFileMissing(runId: string): void {
        markControlRunFileMissing(this.runs.get(runId));
    }

    private receiveEnvelope(envelope: ControlClientEnvelope): ControlEnvelopeReceipt {
        if (this.runs.get(envelope.runId)?.completion !== undefined) {
            return COMPLETED_RUN_RECEIPT;
        }
        switch (envelope.kind) {
            case 'register':
                this.register(envelope);
                return DISPATCH_RECEIPT;
            case 'heartbeat':
                this.receiveHeartbeat(envelope);
                return HEARTBEAT_RECEIPT;
            case 'result':
                return { accepted: this.receiveResult(envelope), affectsDispatch: true };
            case 'event':
            case 'diagnostic':
            case 'stats':
            case 'report':
                return this.receiveEvent(envelope);
        }
    }

    private register(envelope: ControlRegisterEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        markControlAgentRegistered(this.ensureAgent(run, envelope.agentId), envelope, this.dependencies.now());
        this.touch(run);
    }

    private receiveHeartbeat(envelope: ControlHeartbeatEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        markControlAgentHeartbeat(this.ensureAgent(run, envelope.agentId), envelope, this.dependencies.now());
        run.heartbeats.push(envelope);
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
    }

    private receiveResult(envelope: ControlResultEnvelope): boolean {
        const run = this.runs.get(envelope.runId);
        if (!run) {
            return false;
        }
        const owner = resolveControlRecipeReloadOwner(run, envelope.commandId);
        const queued = run.commands.get(envelope.commandId);
        if (!queued && envelope.ok) {
            return false;
        }
        const evidence = toControlRunEvidenceView(run);
        if (
            (queued && hasControlReloadCleanup(queued.envelope) &&
                !isAdmissibleControlReloadCleanupResult(queued, envelope)) ||
            !isAdmissibleControlRecipeReloadResult({
                owner,
                command: queued,
                envelope,
                existingResult: run.results.get(envelope.commandId)
            }) || !isAdmissibleControlRtcCaptureResult({
                command: queued?.envelope,
                envelope,
                get commands() {
                    return evidence.commands;
                },
                get results() {
                    return evidence.results;
                }
            })
        ) {
            return false;
        }
        const agent = this.ensureAgent(run, envelope.agentId);
        agent.receivedResultCount += 1;
        agent.lastSeenAtEpochMs = this.dependencies.now();
        agent.completedCommandIds.add(envelope.commandId);
        agent.resumeCompletedCommandIds.delete(envelope.commandId);
        run.results.set(
            envelope.commandId,
            toStoredControlResultEnvelope({
                envelope,
                command: queued?.envelope.command,
                preserveReloadEvidence: owner !== undefined,
                distributedRuns: this.distributedRuns.values()
            })
        );
        if (queued) {
            queued.completedAtEpochMs = this.dependencies.now();
            this.queueReloadCleanupSuccessor(run, queued, envelope);
        }
        this.touch(run);
        this.advanceReloadRecipes(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        return true;
    }

    private queueReloadCleanupSuccessor(
        run: ControlRunState,
        command: ControlCommandState,
        envelope: ControlResultEnvelope
    ): void {
        const successor = toControlReloadCleanupSuccessor(command, envelope);
        if (successor) {
            const failure = this.queueCommand(run, this.ensureAgent(run, successor.agentId!), successor).left;
            const annotated = failure === undefined ? undefined : toReloadCleanupFailureResult(envelope, failure);
            if (annotated !== undefined) {
                run.results.set(envelope.commandId, annotated);
            }
        }
    }

    private advanceReloadRecipes(run: ControlRunState): void {
        for (const pending of toPendingControlRecipeReloadRoots(run.commands.values())) {
            const root = run.commands.get(pending.envelope.commandId)!;
            const step = computeControlRecipeReloadStep({ root, run, nowEpochMs: this.dependencies.now() });
            switch (step.kind) {
                case 'queue':
                    this.queueCommand(run, this.ensureAgent(run, step.envelope.agentId!), step.envelope);
                    break;
                case 'complete':
                    this.completeReloadRecipe(run, root, step.envelope);
                    break;
            }
        }
        for (const command of run.commands.values()) {
            const refusal = computeControlReloadCleanupRefusal(command, run, this.dependencies.now());
            if (refusal) {
                command.completedAtEpochMs = this.dependencies.now();
                run.results.set(command.envelope.commandId, refusal);
                this.touch(run);
            }
        }
    }

    private cancelReloadRecipes(run: ControlRunState, agentId: string): void {
        const roots = toControlRecipeReloadCancellationRoots(run.commands.values(), agentId);
        for (const root of roots) {
            this.completeReloadRecipe(
                run,
                root,
                toCancelledControlRecipeReload({ root, run, nowEpochMs: this.dependencies.now() })
            );
        }
    }

    private completeReloadRecipe(
        run: ControlRunState,
        root: ControlCommandState,
        envelope: ControlResultEnvelope
    ): void {
        const cleanup = !envelope.ok
            ? toControlReloadCleanup({
                root,
                run,
                deadlineEpochMs: computeReloadRootDeadline(root) ?? this.dependencies.now()
            })
            : undefined;
        const cleanupResult = cleanup
            ? this.queueCommand(run, this.ensureAgent(run, cleanup.agentId!), cleanup)
            : undefined;
        const actual = toReloadCompletionResult(envelope, cleanupResult?.left);
        const completion = computeControlRecipeReloadCompletionWrite(
            { root, run, nowEpochMs: this.dependencies.now() },
            toStoredControlResultEnvelope({
                envelope: actual,
                command: root.envelope.command,
                preserveReloadEvidence: false,
                distributedRuns: this.distributedRuns.values()
            })
        );
        for (const command of completion.commands) {
            run.commands.set(command.envelope.commandId, command);
        }
        for (const result of completion.results) {
            run.results.set(result.commandId, result);
        }
        run.agents.get(envelope.agentId)?.completedCommandIds.add(envelope.commandId);
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
    }

    private receiveEvent(envelope: ControlEventEnvelope): ControlEnvelopeReceipt {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const storedEnvelope = envelope.kind === 'report'
            ? toCompactedControlReport(envelope, this.config.redaction)
            : envelope;
        if (storedEnvelope.kind === 'report' && !this.admitReportKey(run, storedEnvelope)) {
            return { accepted: false, affectsDispatch: false };
        }

        agent.receivedEventCount += 1;
        agent.lastSeenAtEpochMs = this.dependencies.now();
        run.events.push(storedEnvelope);
        const barrier = computeControlRecipeBarrierArrival({
            run,
            envelope: storedEnvelope,
            distributedRuns: this.distributedRuns.values(),
            nowEpochMs: this.dependencies.now()
        });
        if (barrier) {
            run.barriers.set(barrier.barrierId, barrier);
        }
        if (storedEnvelope.kind === 'stats') {
            run.stats.push(storedEnvelope);
        }
        if (storedEnvelope.kind === 'report') {
            run.reports.push(storedEnvelope);
        }
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        return { accepted: true, affectsDispatch: barrier !== undefined };
    }

    private admitReportKey(run: ControlRunState, report: ControlEventEnvelope): boolean {
        const reportKey = toControlReportDedupeKey(report);
        if (run.reportKeys.has(reportKey)) {
            return false;
        }
        run.reportKeys.add(reportKey);
        trimControlReportDedupeKeys(run);
        return true;
    }

    private refreshDistributedTargetResolution(distributedRun: ControlDistributedRunState): void {
        const resolution = isResolvedTargetPolicy(distributedRun.manifest)
            ? this.resolveDistributedRunTargets(distributedRun.manifest)
            : toExplicitDistributedTargetResolution(
                distributedRun,
                this.runs.get(distributedRun.controlRunId),
                this.dependencies.now()
            );
        distributedRun.targetResolution = resolution;
        distributedRun.targetAgentIds = [...resolution.targetAgentIds];
    }

    // Refused automatic queueing leaves lifecycle state unchanged;
    // the next refresh retries without turning a read into failure.
    private advanceDistributedRun(distributedRun: ControlDistributedRunState): void {
        const advance = resolveDistributedRunAdvance(this.toLifecycleInput(distributedRun));
        if (advance.completesBarrier) {
            distributedRun.barrierCompletedAtEpochMs ??= this.dependencies.now();
        }
        this.applyDistributedRunStep(distributedRun, advance.next);
    }

    private applyDistributedRunStep(
        distributedRun: ControlDistributedRunState,
        step: DistributedRunNextStep
    ): ControlServiceFailure | undefined {
        switch (step) {
            case 'queue-barrier':
                return this.queueDistributedPhase(
                    distributedRun,
                    'barrier',
                    toDistributedBarrierCommands(distributedRun)
                );
            case 'queue-start':
                return this.queueDistributedPhase(distributedRun, 'start', toDistributedStartCommands(distributedRun));
            case 'mark-ready':
                distributedRun.state = 'ready';
                distributedRun.updatedAtEpochMs = this.dependencies.now();
                return undefined;
            case 'hold':
                return undefined;
        }
    }

    private queueDistributedPhase(
        distributedRun: ControlDistributedRunState,
        phase: ControlDistributedRunCommandPhase,
        commands: readonly DistributedPhaseCommand[]
    ): ControlServiceFailure | undefined {
        if ((phase === 'stage' || phase === 'start') && this.failUnresolvedDistributedTargets(distributedRun)) {
            return undefined;
        }
        const bound = phase === 'start'
            ? bindDistributedAlmReloadCommands(distributedRun, commands)
            : Either.ofRight<readonly string[], readonly DistributedPhaseCommand[]>(commands);
        if (bound.right === undefined) {
            return {
                code: 'command-payload-conflict',
                message: bound.left?.join(' ') ?? 'Distributed commands did not bind.'
            };
        }
        for (const phaseCommand of bound.right) {
            const failure = this.enqueueLinkedDistributedCommand(distributedRun, phaseCommand);
            if (failure) {
                return failure;
            }
        }
        Object.assign(distributedRun, toQueuedDistributedPhaseFields(distributedRun, phase, this.dependencies.now()));
        return undefined;
    }

    private queueDistributedCancel(
        distributedRun: ControlDistributedRunState,
        reason: string
    ): ControlServiceFailure | undefined {
        if (distributedRun.targetAgentIds.length === 0) {
            distributedRun.targetAgentIds = toDistributedTargetAgentIds(
                distributedRun,
                this.runs.get(distributedRun.controlRunId)
            );
        }
        return this.queueDistributedPhase(
            distributedRun,
            'cancel',
            toDistributedCancelCommands(distributedRun, reason)
        );
    }

    private enqueueLinkedDistributedCommand(
        distributedRun: ControlDistributedRunState,
        { phase, agentId, selection, command }: DistributedPhaseCommand
    ): ControlServiceFailure | undefined {
        const recipeId = selection ? toDistributedRecipeKey(selection) : undefined;
        const existingLink = distributedRun.commandLinks.find((link) =>
            link.phase === phase && link.agentId === agentId && link.recipeId === recipeId
        );
        if (existingLink && this.runs.get(distributedRun.controlRunId)?.commands.has(existingLink.commandId)) {
            return undefined;
        }

        const enqueued = this.enqueueCommand({
            runId: distributedRun.controlRunId,
            agentId,
            commandId: command.commandId,
            command,
            // Paired roots use the finite execution timeout bound above. The distributed lifecycle already gates scheduled start.
            deadlineEpochMs: phase === 'start' && !toAlmReloadPair(command)
                ? toScheduledStartEpochMs(distributedRun)
                : undefined
        });
        if (enqueued.right === undefined) {
            return enqueued.left;
        }
        distributedRun.commandLinks.push({
            phase,
            agentId,
            commandId: enqueued.right.commandId,
            recipeId,
            role: selection?.role,
            queuedAtEpochMs: this.dependencies.now()
        });
        distributedRun.updatedAtEpochMs = this.dependencies.now();
        return undefined;
    }

    private refreshDistributedRunSnapshot(distributedRun: ControlDistributedRunState): ControlDistributedRunSnapshot {
        return toDistributedRunSnapshot(distributedRun, this.refreshDistributedRunState(distributedRun));
    }

    private ensureFleetReports(): void {
        for (const distributedRunId of this.distributedRuns.keys()) {
            this.ensureFleetReport(distributedRunId);
        }
    }

    private ensureFleetReport(distributedRunId: string): ControlFleetRunReport | undefined {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            this.fleetReports.delete(distributedRunId);
            return undefined;
        }
        const snapshot = this.refreshDistributedRunSnapshot(distributedRun);
        const existing = this.fleetReports.get(distributedRunId);
        if (
            !isDistributedRunTerminalState(snapshot.state) ||
            (existing && existing.generatedAtEpochMs >= snapshot.updatedAtEpochMs)
        ) {
            return existing;
        }
        const report = createControlFleetRunReport({
            distributedRun: snapshot,
            controlRun: this.snapshotRun(snapshot.controlRunId),
            generatedAtEpochMs: this.dependencies.now(),
            redaction: this.config.redaction
        });
        this.fleetReports.set(distributedRunId, report);
        return report;
    }

    private refreshDistributedRunsForControlRun(controlRunId: string): void {
        for (const distributedRun of this.distributedRuns.values()) {
            if (distributedRun.controlRunId === controlRunId) {
                this.refreshDistributedRunState(distributedRun);
            }
        }
    }

    private refreshDistributedRunState(distributedRun: ControlDistributedRunState): RallarBlackBoxDistributedRunRollup {
        const latest = distributedRun.rollup;
        if (isDistributedRunTerminalState(distributedRun.state) && latest?.state === distributedRun.state) {
            return latest;
        }

        const run = this.runs.get(distributedRun.controlRunId);
        Object.assign(distributedRun, toReconciledDistributedRunFields(distributedRun, run, this.dependencies.now()));
        this.advanceDistributedRun(distributedRun);
        const evaluated = this.dependencies.toDistributedRunRollup({
            distributedRun,
            run: this.runs.get(distributedRun.controlRunId),
            redaction: this.config.redaction,
            nowEpochMs: this.dependencies.now()
        });
        if (evaluated.state !== distributedRun.state) {
            distributedRun.state = evaluated.state;
            distributedRun.updatedAtEpochMs = this.dependencies.now();
            if (isDistributedRunTerminalState(evaluated.state)) {
                distributedRun.completedAtEpochMs ??= this.dependencies.now();
            }
        }
        distributedRun.rollup = evaluated;
        this.compactSettledAssessmentResults(distributedRun);
        return evaluated;
    }

    /** Takes effect once: a settled rollup is returned as it is and never evaluated again. */
    private compactSettledAssessmentResults(distributedRun: ControlDistributedRunState): void {
        const run = this.runs.get(distributedRun.controlRunId);
        for (const commandId of toSettledAssessmentCommandIds(distributedRun)) {
            const result = run?.results.get(commandId);
            if (run && result) {
                run.results.set(
                    commandId,
                    toStoredControlResultEnvelope({
                        envelope: result,
                        command: run.commands.get(commandId)?.envelope.command,
                        preserveReloadEvidence: resolveControlRecipeReloadOwner(run, commandId) !== undefined,
                        distributedRuns: this.distributedRuns.values()
                    })
                );
                this.touch(run);
            }
        }
    }

    private toLifecycleInput(distributedRun: ControlDistributedRunState): DistributedRunLifecycleInput {
        return {
            distributedRun,
            run: this.runs.get(distributedRun.controlRunId),
            nowEpochMs: this.dependencies.now()
        };
    }

    private failUnresolvedDistributedTargets(distributedRun: ControlDistributedRunState): boolean {
        const error = toDistributedTargetFailure(distributedRun, this.runs.get(distributedRun.controlRunId));
        if (!error) {
            return false;
        }
        distributedRun.state = 'failed';
        distributedRun.completedAtEpochMs = this.dependencies.now();
        distributedRun.error = error;
        return true;
    }

    private ensureRun(runId: string): ControlRunState {
        const existing = this.runs.get(runId);
        if (existing) {
            return existing;
        }

        const run = toInitialControlRunState(runId, this.dependencies.now());
        this.runs.set(runId, run);
        return run;
    }

    private ensureAgent(run: ControlRunState, agentId: string): ControlAgentState {
        const existing = run.agents.get(agentId);
        if (existing) {
            return existing;
        }

        const agent = toInitialControlAgentState(run.runId, agentId);
        run.agents.set(agentId, agent);
        this.touch(run);
        return agent;
    }

    private touch(run: ControlRunState): void {
        run.retentionRevision += 1;
        run.updatedAtEpochMs = this.dependencies.now();
    }

    private deleteRetainedRecords(
        { deletedRunIds, distributedRunIds, fleetReportIds }: ControlRetentionDeletion
    ): readonly string[] {
        const deleted: string[] = [];
        for (const runId of deletedRunIds) {
            if (this.runs.delete(runId)) {
                deleted.push(runId);
            }
        }
        for (const distributedRunId of distributedRunIds) {
            this.distributedRuns.delete(distributedRunId);
        }
        for (const fleetReportId of fleetReportIds) {
            this.fleetReports.delete(fleetReportId);
        }
        return deleted;
    }

    private deleteControlRunRecords(deletedRunIds: readonly string[]): readonly string[] {
        const selected = new Set(deletedRunIds);
        const distributedRunIds = Array.from(this.distributedRuns.values())
            .filter((distributedRun) => selected.has(distributedRun.controlRunId))
            .map((distributedRun) => distributedRun.distributedRunId);
        return this.deleteRetainedRecords({ deletedRunIds, distributedRunIds, fleetReportIds: distributedRunIds });
    }
}

export function createRallarBlackBoxControlService(
    input: CreateRallarBlackBoxControlServiceInput
): RallarBlackBoxControlService {
    return new RallarBlackBoxControlService(input);
}
