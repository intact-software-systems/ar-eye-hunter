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
    resolveRetainedControlRunIds,
    type ControlRetentionPlan
} from '@shared-test/rallar-bb-test/control-retention.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlRunSnapshotBounds,
    ControlRunToken,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    isDistributedRunTerminalState,
    resolveDistributedRunTargets,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunRollup,
    type RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRedactionOptions
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createControlDistributedRunArtifactBundle } from './control-artifacts.ts';
import {
    computeControlCommandRateWindow,
    isDispatchableControlCommand,
    toCommandIdSegment,
    toControlCommandFingerprint
} from './control-command-queue-policy.ts';
import {
    toCompactedControlReport,
    toCompactedResultEnvelope,
    toControlReportDedupeKey,
    toGroupAssertionEvidenceCommandIds
} from './control-evidence-compaction.ts';
import { trimControlReportDedupeKeys, trimControlRunEvidence } from './control-runtime-retention.ts';
import {
    toControlCommandSnapshot,
    toControlRetentionRunSafety,
    toControlRunSnapshot,
    toDistributedRunSnapshot,
    toPassiveDistributedRunSnapshot,
    toRestoredControlSnapshot
} from './control-service-snapshots.ts';
import type {
    ControlAgentState,
    ControlDistributedRunState,
    ControlRunState,
    ControlTokenState
} from './control-service-state.ts';
import {
    toDistributedBarrierCommands,
    toDistributedCancelCommands,
    toDistributedStageCommands,
    toDistributedStartCommands,
    toRecoveredDistributedCommandLinks,
    type DistributedPhaseCommand
} from './distributed/distributed-run-commands.ts';
import { toDistributedRunRollup } from './distributed/distributed-run-evaluation.ts';
import {
    resolveDistributedRunAdvance,
    resolveDistributedRunStartStep,
    type DistributedRunLifecycleInput,
    type DistributedRunNextStep
} from './distributed/distributed-run-lifecycle.ts';
import {
    isResolvedTargetPolicy,
    toControlAgentCandidates,
    toDistributedRecipeKey,
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

export type ControlServiceFailureCode =
    | 'command-kind-not-allowed'
    | 'command-payload-conflict'
    | 'command-rate-limited'
    | 'distributed-run-exists'
    | 'distributed-run-not-found'
    | 'distributed-run-terminal';

export interface ControlServiceFailure {
    readonly code: ControlServiceFailureCode;
    readonly message: string;
}

export interface RallarBlackBoxControlServiceDependencies {
    readonly now: () => number;
    readonly createCommandId: () => string;
}

export interface RallarBlackBoxControlServiceConfig {
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
    readonly allowedCommandKinds: readonly RallarBlackBoxTestCommandKind[] | undefined;
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
}

interface ControlRetentionDeletion {
    readonly deletedRunIds: readonly string[];
    readonly distributedRunIds: readonly string[];
    readonly fleetReportIds: readonly string[];
}

export class RallarBlackBoxControlService {
    private readonly dependencies: RallarBlackBoxControlServiceDependencies;
    private readonly config: RallarBlackBoxControlServiceConfig;
    private readonly allowedCommandKinds: ReadonlySet<RallarBlackBoxTestCommandKind> | undefined;
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
        const accepted = this.receiveEnvelope(envelope);
        return {
            kind: envelope.kind,
            runId: envelope.runId,
            agentId: envelope.agentId,
            accepted
        };
    }

    enqueueCommand(input: EnqueueControlCommandInput): Either<ControlServiceFailure, ControlCommandEnvelope> {
        const run = this.ensureRun(input.runId);
        const agent = this.ensureAgent(run, input.agentId);
        if (this.allowedCommandKinds && !this.allowedCommandKinds.has(input.command.kind)) {
            return toFailure('command-kind-not-allowed', `Command kind is not allowed: ${input.command.kind}.`);
        }

        const envelope: ControlCommandEnvelope = {
            kind: 'command',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: input.runId,
            agentId: input.agentId,
            commandId: input.commandId ?? this.dependencies.createCommandId(),
            command: input.command,
            deadlineEpochMs: input.deadlineEpochMs
        };
        const fingerprint = toControlCommandFingerprint(envelope);
        const existing = run.commands.get(envelope.commandId);
        if (existing) {
            return existing.fingerprint === fingerprint
                ? Either.ofRight(existing.envelope)
                : toFailure(
                    'command-payload-conflict',
                    `Command ${envelope.commandId} already exists with a different payload.`
                );
        }
        if (!this.admitCommandRate(agent)) {
            return toFailure('command-rate-limited', 'Command rate limit exceeded.');
        }

        run.commands.set(envelope.commandId, {
            envelope,
            fingerprint,
            queuedAtEpochMs: this.dependencies.now(),
            dispatchCount: 0
        });
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        return Either.ofRight(envelope);
    }

    issueRunToken(input: IssueControlRunTokenInput): ControlRunToken {
        const run = this.ensureRun(input.runId);
        this.ensureAgent(run, input.agentId);
        const issuedAtEpochMs = this.dependencies.now();
        const token: ControlTokenState = {
            runId: input.runId,
            agentId: input.agentId,
            token: crypto.randomUUID(),
            issuedAtEpochMs,
            expiresAtEpochMs: issuedAtEpochMs + Math.max(1, input.ttlMs)
        };
        run.tokens.set(token.token, token);
        run.issuedRunTokenStateRevision += 1;
        this.touch(run);
        return token;
    }

    hasActiveRunToken(runId: string, agentId: string): boolean {
        const run = this.runs.get(runId);
        if (!run) {
            return false;
        }

        const now = this.dependencies.now();
        return Array.from(run.tokens.values())
            .some((token) => token.agentId === agentId && token.expiresAtEpochMs > now);
    }

    validateRunToken(runId: string, agentId: string, token: string | undefined): boolean {
        if (!token) {
            return false;
        }

        const stored = this.runs.get(runId)?.tokens.get(token);
        return Boolean(stored && stored.agentId === agentId && stored.expiresAtEpochMs > this.dependencies.now());
    }

    createDistributedRun(
        manifest: RallarBlackBoxDistributedRunManifest
    ): Either<ControlServiceFailure, ControlDistributedRunSnapshot> {
        if (this.distributedRuns.has(manifest.distributedRunId)) {
            return toFailure('distributed-run-exists', `Distributed run ${manifest.distributedRunId} already exists.`);
        }

        const normalized = toNormalizedDistributedRunManifest(manifest);
        this.ensureRun(normalized.controlRunId);
        const now = this.dependencies.now();
        const distributedRun: ControlDistributedRunState = {
            distributedRunId: manifest.distributedRunId,
            controlRunId: normalized.controlRunId,
            manifest: normalized.manifest,
            state: 'draft',
            createdAtEpochMs: now,
            updatedAtEpochMs: now,
            targetAgentIds: [],
            commandLinks: []
        };
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
            nowEpochMs: this.dependencies.now()
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

        this.refreshDistributedTargetResolution(distributedRun);
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

    createDistributedRunArtifactBundle(
        distributedRunId: string,
        bounds: ControlRunSnapshotBounds
    ): ControlDistributedRunArtifactBundle | undefined {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            return undefined;
        }

        const snapshot = this.refreshDistributedRunSnapshot(distributedRun);
        const controlRun = this.snapshotRun(distributedRun.controlRunId, bounds);
        return createControlDistributedRunArtifactBundle(snapshot, controlRun, this.dependencies.now());
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

    takeDispatchableCommands(runId: string, agentId: string): readonly ControlCommandEnvelope[] {
        this.refreshDistributedRunsForControlRun(runId);
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent?.connected) {
            return [];
        }

        const dispatchable = Array.from(run.commands.values())
            .filter((command) => isDispatchableControlCommand(command, agent));
        for (const command of dispatchable) {
            command.dispatchedAtEpochMs = this.dependencies.now();
            command.lastDispatchedConnectionSequence = agent.connectionSequence;
            command.dispatchCount += 1;
        }
        if (dispatchable.length > 0) {
            this.touch(run);
        }
        return dispatchable.map((command) => command.envelope);
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

        run.commands.clear();
        run.results.clear();
        run.events = [];
        run.stats = [];
        run.reports = [];
        run.reportKeys.clear();
        run.heartbeats = [];
        for (const agent of run.agents.values()) {
            agent.receivedResultCount = 0;
            agent.receivedEventCount = 0;
            agent.completedCommandIds.clear();
            agent.resumeCompletedCommandIds.clear();
            agent.commandEnqueueTimestamps = [];
        }
        this.touch(run);
        return toControlRunSnapshot(run, {});
    }

    deleteRun(runId: string): boolean {
        if (!this.runs.has(runId)) {
            return false;
        }
        return this.deleteControlRunRecords([runId]).length === 1;
    }

    applyRunRetention(maxRuns: number | undefined): readonly string[] {
        const runs = Array.from(this.runs.values());
        const retainedIds = resolveRetainedControlRunIds(runs, maxRuns);
        if (retainedIds === undefined) {
            return [];
        }
        return this.deleteControlRunRecords(runs.filter((run) => !retainedIds.has(run.runId)).map((run) => run.runId));
    }

    createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan {
        return planControlRunRetention({
            maxRuns,
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, {})),
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
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, bounds)),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: this.listFleetReports({}).reports
        };
    }

    snapshotForPersistence(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, bounds)),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: Array.from(this.fleetReports.values())
        };
    }

    snapshotRun(runId: string, bounds: ControlRunSnapshotBounds = {}): ControlRunSnapshot | undefined {
        const run = this.runs.get(runId);
        return run ? toControlRunSnapshot(run, bounds) : undefined;
    }

    snapshotCommand(runId: string, commandId: string): ControlQueuedCommandSnapshot | undefined {
        const command = this.runs.get(runId)?.commands.get(commandId);
        return command ? toControlCommandSnapshot(command) : undefined;
    }

    recordDuplicateAgentSocketReplacement(runId: string, agentId: string): void {
        const run = this.ensureRun(runId);
        const agent = this.ensureAgent(run, agentId);
        const atEpochMs = this.dependencies.now();
        agent.receivedEventCount += 1;
        agent.lastSeenAtEpochMs = atEpochMs;
        run.events.push({
            kind: 'diagnostic',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId,
            agentId,
            atEpochMs,
            eventId: `duplicate-agent-socket-${toCommandIdSegment(agentId, 'segment')}-${atEpochMs}`,
            payload: {
                topic: 'rallar.bb.control.duplicate-agent-socket',
                severity: 'warning',
                message: 'Another websocket registered with the same runId and agentId; replacing the previous socket.',
                runId,
                agentId
            }
        });
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
    }

    private receiveEnvelope(envelope: ControlClientEnvelope): boolean {
        switch (envelope.kind) {
            case 'register':
                this.register(envelope);
                return true;
            case 'heartbeat':
                this.receiveHeartbeat(envelope);
                return true;
            case 'result':
                this.receiveResult(envelope);
                return true;
            case 'event':
            case 'diagnostic':
            case 'stats':
            case 'report':
                return this.receiveEvent(envelope);
        }
    }

    private register(envelope: ControlRegisterEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const reconnecting = agent.registeredAtEpochMs !== undefined && !agent.connected;
        agent.connected = true;
        agent.registeredAtEpochMs = envelope.atEpochMs;
        agent.disconnectedAtEpochMs = undefined;
        agent.lastSeenAtEpochMs = this.dependencies.now();
        agent.identity = envelope.identity ?? agent.identity;
        agent.connectionSequence += 1;
        if (reconnecting) {
            agent.reconnectCount += 1;
        }
        agent.resumeCompletedCommandIds = new Set(envelope.resume.completedCommandIds);
        this.touch(run);
    }

    private receiveHeartbeat(envelope: ControlHeartbeatEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        agent.lastHeartbeatAtEpochMs = envelope.atEpochMs;
        agent.lastSeenAtEpochMs = this.dependencies.now();
        agent.status = envelope.status;
        agent.identity = envelope.identity ?? agent.identity;
        run.heartbeats.push(envelope);
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        this.refreshDistributedRunsForControlRun(run.runId);
    }

    private receiveResult(envelope: ControlResultEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        agent.receivedResultCount += 1;
        agent.lastSeenAtEpochMs = this.dependencies.now();
        agent.completedCommandIds.add(envelope.commandId);
        agent.resumeCompletedCommandIds.delete(envelope.commandId);
        run.results.set(
            envelope.commandId,
            this.isGroupAssertionEvidenceCommand(envelope.runId, envelope.commandId)
                ? envelope
                : toCompactedResultEnvelope(envelope)
        );

        const command = run.commands.get(envelope.commandId);
        if (command) {
            command.completedAtEpochMs = this.dependencies.now();
        }
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        this.refreshDistributedRunsForControlRun(run.runId);
    }

    private receiveEvent(envelope: ControlEventEnvelope): boolean {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const storedEnvelope = envelope.kind === 'report'
            ? toCompactedControlReport(envelope, this.config.redaction)
            : envelope;
        if (storedEnvelope.kind === 'report' && !this.admitReportKey(run, storedEnvelope)) {
            return false;
        }

        agent.receivedEventCount += 1;
        agent.lastSeenAtEpochMs = this.dependencies.now();
        run.events.push(storedEnvelope);
        if (storedEnvelope.kind === 'stats') {
            run.stats.push(storedEnvelope);
        }
        if (storedEnvelope.kind === 'report') {
            run.reports.push(storedEnvelope);
        }
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.config.runtimeRetentionBounds);
        return true;
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

    private admitCommandRate(agent: ControlAgentState): boolean {
        const rateWindow = computeControlCommandRateWindow({
            enqueueTimestamps: agent.commandEnqueueTimestamps,
            nowEpochMs: this.dependencies.now(),
            maxCommands: this.config.commandRateLimitMax,
            windowMs: this.config.commandRateLimitWindowMs
        });
        agent.commandEnqueueTimestamps = [...rateWindow.enqueueTimestamps];
        return !rateWindow.limited;
    }

    // Group assertions read per-command evidence out of start-phase recipe
    // results after completion, so those envelopes keep their full composite
    // value instead of the compacted resultCount projection.
    private isGroupAssertionEvidenceCommand(runId: string, commandId: string): boolean {
        return Array.from(this.distributedRuns.values()).some((distributedRun) =>
            distributedRun.controlRunId === runId &&
            toGroupAssertionEvidenceCommandIds(distributedRun).includes(commandId)
        );
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

    // Orchestration is re-evaluated on every refresh, so an automatic step whose command
    // queueing is refused (rate limit, allowlist) leaves the run in its current state and is
    // attempted again on the next refresh instead of failing the read that triggered it.
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
        for (const phaseCommand of commands) {
            const failure = this.enqueueLinkedDistributedCommand(distributedRun, phaseCommand);
            if (failure) {
                return failure;
            }
        }
        this.markDistributedPhaseQueued(distributedRun, phase);
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

    private markDistributedPhaseQueued(
        distributedRun: ControlDistributedRunState,
        phase: ControlDistributedRunCommandPhase
    ): void {
        const now = this.dependencies.now();
        switch (phase) {
            case 'stage':
                distributedRun.state = 'waiting-for-ack';
                distributedRun.stagedAtEpochMs ??= now;
                break;
            case 'barrier':
                distributedRun.state = 'waiting-for-barrier';
                distributedRun.barrierStartedAtEpochMs ??= now;
                break;
            case 'start':
                distributedRun.state = 'running';
                distributedRun.startedAtEpochMs ??= now;
                break;
            case 'cancel':
                distributedRun.state = 'cancelled';
                distributedRun.cancelledAtEpochMs = now;
                distributedRun.completedAtEpochMs = now;
                break;
        }
        distributedRun.updatedAtEpochMs = now;
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
            deadlineEpochMs: phase === 'start' ? distributedRun.manifest.startDeadlineEpochMs : undefined
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

    private reconcileDistributedCommandLinks(distributedRun: ControlDistributedRunState): void {
        const run = this.runs.get(distributedRun.controlRunId);
        for (const recovered of toRecoveredDistributedCommandLinks(distributedRun, run)) {
            const queuedAtEpochMs = recovered.evidenceQueuedAtEpochMs ?? distributedRun.updatedAtEpochMs;
            distributedRun.commandLinks.push({
                phase: recovered.phase,
                agentId: recovered.agentId,
                commandId: recovered.commandId,
                recipeId: recovered.recipeId,
                role: recovered.role,
                queuedAtEpochMs
            });
            if (recovered.phase === 'start') {
                distributedRun.startedAtEpochMs ??= queuedAtEpochMs;
            }
            if (recovered.phase === 'barrier') {
                distributedRun.barrierStartedAtEpochMs ??= queuedAtEpochMs;
            }
            distributedRun.updatedAtEpochMs = this.dependencies.now();
        }
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
        if (isDistributedRunTerminalState(distributedRun.state) && distributedRun.rollup) {
            return distributedRun.rollup;
        }

        this.reconcileDistributedCommandLinks(distributedRun);
        this.advanceDistributedRun(distributedRun);
        const evaluated = toDistributedRunRollup({
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
        if (isDistributedRunTerminalState(distributedRun.state)) {
            distributedRun.rollup = evaluated;
        }
        return evaluated;
    }

    private toLifecycleInput(distributedRun: ControlDistributedRunState): DistributedRunLifecycleInput {
        return {
            distributedRun,
            run: this.runs.get(distributedRun.controlRunId),
            nowEpochMs: this.dependencies.now()
        };
    }

    private failUnresolvedDistributedTargets(distributedRun: ControlDistributedRunState): boolean {
        const error = toDistributedTargetFailure(distributedRun);
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

        const now = this.dependencies.now();
        const run: ControlRunState = {
            runId,
            createdAtEpochMs: now,
            updatedAtEpochMs: now,
            agents: new Map(),
            commands: new Map(),
            results: new Map(),
            events: [],
            stats: [],
            reports: [],
            reportKeys: new Set(),
            heartbeats: [],
            tokens: new Map(),
            retentionRevision: 0,
            issuedRunTokenStateRevision: 0
        };
        this.runs.set(runId, run);
        return run;
    }

    private ensureAgent(run: ControlRunState, agentId: string): ControlAgentState {
        const existing = run.agents.get(agentId);
        if (existing) {
            return existing;
        }

        const agent: ControlAgentState = {
            runId: run.runId,
            agentId,
            connected: false,
            connectionSequence: 0,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: new Set(),
            resumeCompletedCommandIds: new Set(),
            commandEnqueueTimestamps: []
        };
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

function toFailure<TValue>(code: ControlServiceFailureCode, message: string): Either<ControlServiceFailure, TValue> {
    return Either.ofLeft({ code, message });
}

function toDistributedRunNotFound<TValue>(distributedRunId: string): Either<ControlServiceFailure, TValue> {
    return toFailure('distributed-run-not-found', `Distributed run not found: ${distributedRunId}.`);
}

function toDistributedRunTerminal<TValue>(
    distributedRun: ControlDistributedRunState,
    action: ControlDistributedRunCommandPhase
): Either<ControlServiceFailure, TValue> {
    return toFailure(
        'distributed-run-terminal',
        `Cannot ${action} distributed run ${distributedRun.distributedRunId} in terminal state ${distributedRun.state}.`
    );
}
