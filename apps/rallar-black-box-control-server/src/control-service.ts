import type {
    ControlClientEnvelope,
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlRegisterEnvelope,
    ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { planControlRunRetention, type ControlRetentionPlan } from '@shared-test/rallar-bb-test/control-retention.ts';
import { resolveRetainedControlRunIds } from '@shared-test/rallar-bb-test/control-retention.ts';
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
    rollupDistributedRunResult,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunRecipeSelection,
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
import { createControlDistributedRunArtifactBundle } from './control-artifacts.ts';
import { toControlCommandFingerprint } from './control-command-identity.ts';
import {
    safeCommandIdSegment,
    toDistributedBarrierCommand,
    toDistributedCommandId,
    toDistributedCommandMetadata,
    toDistributedStageCommand,
    toDistributedStartCommand,
    toRecoveredDistributedCommandLink,
    type ReconcileDistributedCommandInput
} from './control-distributed-commands.ts';
import {
    isDistributedAckTimedOut,
    isDistributedBarrierTimedOut,
    toDistributedRunRollup
} from './control-distributed-evaluation.ts';
import {
    isResolvedTargetPolicy,
    toControlAgentCandidates,
    toDistributedRecipeKey,
    toDistributedTargetAgentIds,
    toDistributedTargetFailure,
    toExplicitDistributedTargetResolution,
    toRecipeSelectionsForAgent
} from './control-distributed-targeting.ts';
import {
    compactResultEnvelope,
    toCompactedControlReport,
    toControlReportDedupeKey
} from './control-evidence-compaction.ts';
import {
    createControlFleetAggregateReport,
    createControlFleetReportBundle,
    createControlFleetRunReport,
    filterControlFleetReports
} from './control-fleet.ts';
import { trimControlReportDedupeKeys, trimControlRunEvidence } from './control-runtime-retention.ts';
import {
    toControlCommandSnapshot,
    toControlRunSnapshot,
    toDistributedRunSnapshot,
    toRestoredControlSnapshot
} from './control-service-snapshots.ts';
import type {
    ControlAgentState,
    ControlDistributedRunState,
    ControlRunState,
    ControlTokenState
} from './control-service-state.ts';

const DEFAULT_RUNTIME_RETENTION_BOUNDS: Required<ControlRunSnapshotBounds> = {
    commands: 1_000,
    results: 1_000,
    events: 2_000,
    stats: 500,
    reports: 20,
    heartbeats: 500
};

export interface EnqueueControlCommandInput {
    runId: string;
    agentId: string;
    commandId?: string;
    command: RallarBlackBoxTestCommand;
    deadlineEpochMs?: number;
}

export interface RallarBlackBoxControlServiceOptions {
    now?: () => number;
    commandIdFactory?: () => string;
    redaction?: RallarBlackBoxTestRedactionOptions;
    allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    commandRateLimitMax?: number;
    commandRateLimitWindowMs?: number;
    runTokenTtlMs?: number;
    runtimeRetentionBounds?: ControlRunSnapshotBounds;
}

export interface RallarBlackBoxControlServiceReceiveResult {
    kind: ControlClientEnvelope['kind'];
    runId: string;
    agentId: string;
    accepted: boolean;
}

interface LinkedDistributedCommandInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection | undefined;
    readonly command: RallarBlackBoxTestCommand;
}
interface ControlRetentionDeletion {
    readonly deletedRunIds: readonly string[];
    readonly distributedRunIds: readonly string[];
    readonly fleetReportIds: readonly string[];
}

export class RallarBlackBoxControlService {
    private readonly now: () => number;
    private readonly commandIdFactory: () => string;
    private readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
    private readonly allowedCommandKinds: Set<RallarBlackBoxTestCommandKind> | undefined;
    private readonly commandRateLimitMax: number;
    private readonly commandRateLimitWindowMs: number;
    private readonly runTokenTtlMs: number;
    private readonly runtimeRetentionBounds: ControlRunSnapshotBounds;
    private readonly runs = new Map<string, ControlRunState>();
    private readonly distributedRuns = new Map<string, ControlDistributedRunState>();
    private readonly fleetReports = new Map<string, ControlFleetRunReport>();

    constructor(options: RallarBlackBoxControlServiceOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.commandIdFactory = options.commandIdFactory ?? (() => crypto.randomUUID());
        this.redaction = options.redaction;
        this.allowedCommandKinds = options.allowedCommandKinds
            ? new Set(options.allowedCommandKinds)
            : undefined;
        this.commandRateLimitMax = options.commandRateLimitMax ?? 120;
        this.commandRateLimitWindowMs = options.commandRateLimitWindowMs ?? 60_000;
        this.runTokenTtlMs = options.runTokenTtlMs ?? 15 * 60_000;
        this.runtimeRetentionBounds = {
            ...DEFAULT_RUNTIME_RETENTION_BOUNDS,
            ...options.runtimeRetentionBounds
        };
    }

    receiveClientEnvelope(
        envelope: ControlClientEnvelope
    ): RallarBlackBoxControlServiceReceiveResult {
        let accepted = true;
        switch (envelope.kind) {
            case 'register':
                this.register(envelope);
                break;
            case 'heartbeat':
                this.receiveHeartbeat(envelope);
                break;
            case 'result':
                this.receiveResult(envelope);
                break;
            case 'event':
            case 'diagnostic':
            case 'stats':
            case 'report':
                accepted = this.receiveEvent(envelope);
                break;
        }

        return {
            kind: envelope.kind,
            runId: envelope.runId,
            agentId: envelope.agentId,
            accepted
        };
    }

    enqueueCommand(input: EnqueueControlCommandInput): ControlCommandEnvelope {
        const run = this.ensureRun(input.runId);
        const agent = this.ensureAgent(run, input.agentId);
        this.assertCommandAllowed(input.command.kind);
        const commandId = input.commandId ?? this.commandIdFactory();
        const envelope: ControlCommandEnvelope = {
            kind: 'command',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: input.runId,
            agentId: input.agentId,
            commandId,
            command: input.command,
            deadlineEpochMs: input.deadlineEpochMs
        };
        const fingerprint = toControlCommandFingerprint(envelope);
        const existing = run.commands.get(commandId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                throw new Error(`Command ${commandId} already exists with a different payload.`);
            }
            return existing.envelope;
        }

        this.assertCommandRateLimit(agent);
        run.commands.set(commandId, {
            envelope,
            fingerprint,
            queuedAtEpochMs: this.now(),
            dispatchCount: 0
        });
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.runtimeRetentionBounds);
        return envelope;
    }

    issueRunToken(
        input: Readonly<{
            runId: string;
            agentId: string;
            ttlMs?: number;
        }>
    ): ControlRunToken {
        const run = this.ensureRun(input.runId);
        this.ensureAgent(run, input.agentId);
        const issuedAtEpochMs = this.now();
        const token: ControlTokenState = {
            runId: input.runId,
            agentId: input.agentId,
            token: crypto.randomUUID(),
            issuedAtEpochMs,
            expiresAtEpochMs: issuedAtEpochMs + Math.max(1, input.ttlMs ?? this.runTokenTtlMs)
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

        const now = this.now();
        return Array.from(run.tokens.values())
            .some((token) =>
                token.agentId === agentId &&
                token.expiresAtEpochMs > now
            );
    }

    validateRunToken(
        runId: string,
        agentId: string,
        token: string | undefined
    ): boolean {
        if (!token) {
            return false;
        }

        const stored = this.runs.get(runId)?.tokens.get(token);
        return Boolean(
            stored &&
                stored.agentId === agentId &&
                stored.expiresAtEpochMs > this.now()
        );
    }

    createDistributedRun(
        manifest: RallarBlackBoxDistributedRunManifest
    ): ControlDistributedRunSnapshot {
        const controlRunId = cleanSegment(manifest.controlRunId) ?? manifest.distributedRunId;
        if (this.distributedRuns.has(manifest.distributedRunId)) {
            throw new Error(`Distributed run ${manifest.distributedRunId} already exists.`);
        }

        this.ensureRun(controlRunId);
        const now = this.now();
        const stored: ControlDistributedRunState = {
            distributedRunId: manifest.distributedRunId,
            controlRunId,
            manifest: {
                ...manifest,
                schemaVersion: manifest.schemaVersion ?? 1,
                controlRunId
            },
            state: 'draft',
            createdAtEpochMs: now,
            updatedAtEpochMs: now,
            targetAgentIds: [],
            commandLinks: []
        };
        this.refreshDistributedTargetResolution(stored);
        this.distributedRuns.set(stored.distributedRunId, stored);
        return this.snapshotDistributedRunValue(stored);
    }

    resolveDistributedRunTargets(
        manifest: RallarBlackBoxDistributedRunManifest
    ): RallarBlackBoxDistributedTargetResolution {
        const controlRunId = cleanSegment(manifest.controlRunId) ?? manifest.distributedRunId;
        return resolveDistributedRunTargets({
            manifest: {
                ...manifest,
                schemaVersion: manifest.schemaVersion ?? 1,
                controlRunId
            },
            agents: toControlAgentCandidates(this.runs.get(controlRunId)),
            nowEpochMs: this.now()
        });
    }

    listDistributedRuns(): readonly ControlDistributedRunSnapshot[] {
        return Array.from(
            this.distributedRuns.values(),
            (distributedRun) => this.snapshotDistributedRunValue(distributedRun)
        );
    }

    snapshotDistributedRun(
        distributedRunId: string
    ): ControlDistributedRunSnapshot | undefined {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        return distributedRun ? this.snapshotDistributedRunValue(distributedRun) : undefined;
    }

    stageDistributedRun(distributedRunId: string): ControlDistributedRunSnapshot {
        const distributedRun = this.requireDistributedRun(distributedRunId);
        this.assertDistributedRunCanMutate(distributedRun, 'stage');
        this.refreshDistributedTargetResolution(distributedRun);
        distributedRun.updatedAtEpochMs = this.now();

        if (this.rejectUnresolvedDistributedTargets(distributedRun)) {
            return this.snapshotDistributedRunValue(distributedRun);
        }

        for (const agentId of distributedRun.targetAgentIds) {
            for (const selection of toRecipeSelectionsForAgent(distributedRun, agentId)) {
                this.enqueueLinkedDistributedCommand({
                    distributedRun,
                    phase: 'stage',
                    agentId,
                    selection,
                    command: toDistributedStageCommand(distributedRun, agentId, selection)
                });
            }
        }

        distributedRun.state = 'waiting-for-ack';
        distributedRun.stagedAtEpochMs ??= this.now();
        distributedRun.updatedAtEpochMs = this.now();
        return this.snapshotDistributedRunValue(distributedRun);
    }

    startDistributedRun(distributedRunId: string): ControlDistributedRunSnapshot {
        const distributedRun = this.requireDistributedRun(distributedRunId);
        this.refreshDistributedRunState(distributedRun);
        this.assertDistributedRunCanMutate(distributedRun, 'start');
        if (distributedRun.targetAgentIds.length === 0) {
            this.refreshDistributedTargetResolution(distributedRun);
        }
        if (this.rejectUnresolvedDistributedTargets(distributedRun)) {
            return this.snapshotDistributedRunValue(distributedRun);
        }

        if (this.distributedRunStartPrerequisitePending(distributedRun)) {
            return this.snapshotDistributedRunValue(distributedRun);
        }

        if (this.distributedRunScheduledStartPending(distributedRun)) {
            distributedRun.state = 'ready';
            distributedRun.updatedAtEpochMs = this.now();
            return this.snapshotDistributedRunValue(distributedRun);
        }

        this.queueDistributedStartCommands(distributedRun);
        return this.snapshotDistributedRunValue(distributedRun);
    }

    cancelDistributedRun(
        distributedRunId: string,
        reason = 'Distributed run cancelled.'
    ): ControlDistributedRunSnapshot {
        const distributedRun = this.requireDistributedRun(distributedRunId);
        if (!isDistributedRunTerminalState(distributedRun.state)) {
            if (distributedRun.targetAgentIds.length === 0) {
                distributedRun.targetAgentIds = toDistributedTargetAgentIds(
                    distributedRun,
                    this.runs.get(distributedRun.controlRunId)
                );
            }
            for (const agentId of distributedRun.targetAgentIds) {
                const commandId = toDistributedCommandId({
                    distributedRun,
                    phase: 'cancel',
                    agentId,
                    recipeKey: 'run'
                });
                this.enqueueLinkedDistributedCommand({
                    distributedRun,
                    phase: 'cancel',
                    agentId,
                    selection: undefined,
                    command: {
                        kind: 'recipe.cancel',
                        commandId,
                        label: `Cancel distributed run ${distributedRun.distributedRunId}`,
                        reason,
                        metadata: toDistributedCommandMetadata({
                            distributedRun,
                            phase: 'cancel',
                            agentId,
                            selection: undefined
                        })
                    }
                });
            }
            distributedRun.state = 'cancelled';
            distributedRun.cancelledAtEpochMs = this.now();
            distributedRun.completedAtEpochMs = distributedRun.cancelledAtEpochMs;
            distributedRun.updatedAtEpochMs = distributedRun.cancelledAtEpochMs;
        }

        return this.snapshotDistributedRunValue(distributedRun);
    }

    distributedRunArtifactBundle(
        distributedRunId: string,
        bounds: ControlRunSnapshotBounds = {}
    ): ControlDistributedRunArtifactBundle | undefined {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            return undefined;
        }

        const snapshot = this.snapshotDistributedRunValue(distributedRun);
        const controlRun = this.snapshotRun(distributedRun.controlRunId, bounds);
        return createControlDistributedRunArtifactBundle(snapshot, controlRun, this.now());
    }

    listFleetReports(filter: Readonly<{
        region?: string;
        provider?: string;
        recipeId?: string;
        groupId?: string;
        state?: string;
        fromEpochMs?: number;
        toEpochMs?: number;
    }> = {}): ControlFleetReportsResponse {
        this.ensureFleetReports();
        const reports = filterControlFleetReports([...this.fleetReports.values()], filter);
        return {
            reports,
            aggregate: createControlFleetAggregateReport(reports, this.now())
        };
    }

    snapshotFleetReport(distributedRunId: string): ControlFleetRunReport | undefined {
        return this.ensureFleetReport(distributedRunId);
    }

    fleetReportBundle(distributedRunId: string): ControlFleetReportBundle | undefined {
        const report = this.ensureFleetReport(distributedRunId);
        return report ? createControlFleetReportBundle(report) : undefined;
    }

    rebuildFleetReports(): ControlFleetReportsResponse {
        this.fleetReports.clear();
        this.ensureFleetReports();
        return this.listFleetReports();
    }

    takeDispatchableCommands(runId: string, agentId: string): readonly ControlCommandEnvelope[] {
        this.refreshDistributedRunsForControlRun(runId);
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent?.connected) {
            return [];
        }

        const dispatchable: ControlCommandEnvelope[] = [];
        for (const command of run.commands.values()) {
            if (command.envelope.agentId !== agentId) {
                continue;
            }
            if (command.completedAtEpochMs !== undefined) {
                continue;
            }
            if (agent.resumeCompletedCommandIds.has(command.envelope.commandId)) {
                continue;
            }
            if (command.lastDispatchedConnectionSequence === agent.connectionSequence) {
                continue;
            }

            command.dispatchedAtEpochMs = this.now();
            command.lastDispatchedConnectionSequence = agent.connectionSequence;
            command.dispatchCount += 1;
            dispatchable.push(command.envelope);
        }

        if (dispatchable.length > 0) {
            this.touch(run);
        }
        return dispatchable;
    }

    markAgentDisconnected(runId: string, agentId: string): void {
        const run = this.runs.get(runId);
        const agent = run?.agents.get(agentId);
        if (!run || !agent) {
            return;
        }

        agent.connected = false;
        agent.disconnectedAtEpochMs = this.now();
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
        const deletedRunIds = runs.filter((run) => !retainedIds.has(run.runId)).map((run) => run.runId);
        return this.deleteControlRunRecords(deletedRunIds);
    }

    createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan {
        return planControlRunRetention({
            maxRuns,
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, {})),
            distributedRuns: Array.from(
                this.distributedRuns.values(),
                (run) =>
                    toDistributedRunSnapshot(run, run.rollup ?? rollupDistributedRunResult({ stateHint: run.state }))
            ),
            fleetReports: Array.from(this.fleetReports.values()),
            runSafety: Array.from(this.runs.values(), (run) => ({
                runId: run.runId,
                connectedAgentIds: Array.from(run.agents.values())
                    .filter((agent) => agent.connected)
                    .map((agent) => agent.agentId),
                issuedRunTokens: Array.from(run.tokens.values(), (token) => ({
                    agentId: token.agentId,
                    issuedAtEpochMs: token.issuedAtEpochMs,
                    expiresAtEpochMs: token.expiresAtEpochMs
                })),
                runStateFingerprint: `revision:${run.retentionRevision}`,
                issuedRunTokenStateFingerprint: `revision:${run.issuedRunTokenStateRevision}`
            }))
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
        const restored = toRestoredControlSnapshot(snapshot, this.redaction);
        this.runs.clear();
        this.distributedRuns.clear();
        this.fleetReports.clear();
        for (const [runId, run] of restored.runs) {
            this.runs.set(runId, run);
        }
        for (const [runId, run] of restored.distributedRuns) {
            this.distributedRuns.set(runId, run);
        }
        for (const report of snapshot.fleetReports ?? []) {
            this.fleetReports.set(report.distributedRunId, report);
        }
    }

    snapshot(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, bounds)),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: this.listFleetReports().reports
        };
    }

    snapshotForPersistence(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            runs: Array.from(this.runs.values(), (run) => toControlRunSnapshot(run, bounds)),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: Array.from(this.fleetReports.values())
        };
    }

    snapshotRun(
        runId: string,
        bounds: ControlRunSnapshotBounds = {}
    ): ControlRunSnapshot | undefined {
        const run = this.runs.get(runId);
        return run ? toControlRunSnapshot(run, bounds) : undefined;
    }

    snapshotCommand(
        runId: string,
        commandId: string
    ): ControlQueuedCommandSnapshot | undefined {
        const command = this.runs.get(runId)?.commands.get(commandId);
        return command ? toControlCommandSnapshot(command) : undefined;
    }

    recordDuplicateAgentSocketReplacement(runId: string, agentId: string): void {
        const run = this.ensureRun(runId);
        const agent = this.ensureAgent(run, agentId);
        const atEpochMs = this.now();
        agent.receivedEventCount += 1;
        agent.lastSeenAtEpochMs = atEpochMs;
        run.events.push({
            kind: 'diagnostic',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId,
            agentId,
            atEpochMs,
            eventId: `duplicate-agent-socket-${safeCommandIdSegment(agentId)}-${atEpochMs}`,
            payload: {
                topic: 'rallar.bb.control.duplicate-agent-socket',
                severity: 'warning',
                message: 'Another websocket registered with the same runId and agentId; replacing the previous socket.',
                runId,
                agentId
            }
        });
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.runtimeRetentionBounds);
    }

    private register(envelope: ControlRegisterEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const reconnecting = agent.registeredAtEpochMs !== undefined && !agent.connected;
        agent.connected = true;
        agent.registeredAtEpochMs = envelope.atEpochMs;
        agent.disconnectedAtEpochMs = undefined;
        agent.lastSeenAtEpochMs = this.now();
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
        agent.lastSeenAtEpochMs = this.now();
        agent.status = envelope.status;
        agent.identity = envelope.identity ?? agent.identity;
        run.heartbeats.push(envelope);
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.runtimeRetentionBounds);
        this.refreshDistributedRunsForControlRun(run.runId);
    }

    private receiveResult(envelope: ControlResultEnvelope): void {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        agent.receivedResultCount += 1;
        agent.lastSeenAtEpochMs = this.now();
        agent.completedCommandIds.add(envelope.commandId);
        agent.resumeCompletedCommandIds.delete(envelope.commandId);
        run.results.set(
            envelope.commandId,
            this.isGroupAssertionEvidenceCommand(envelope.runId, envelope.commandId)
                ? envelope
                : compactResultEnvelope(envelope)
        );

        const command = run.commands.get(envelope.commandId);
        if (command) {
            command.completedAtEpochMs = this.now();
        }
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.runtimeRetentionBounds);
        this.refreshDistributedRunsForControlRun(run.runId);
    }

    // Group assertions read per-command evidence out of start-phase recipe
    // results after completion, so those envelopes keep their full composite
    // value instead of the compacted resultCount projection.
    private isGroupAssertionEvidenceCommand(runId: string, commandId: string): boolean {
        for (const distributedRun of this.distributedRuns.values()) {
            if (
                distributedRun.controlRunId !== runId ||
                (distributedRun.manifest.groupAssertions?.length ?? 0) === 0
            ) {
                continue;
            }
            const linked = distributedRun.commandLinks.some((link) =>
                link.phase === 'start' && link.commandId === commandId
            );
            if (linked) {
                return true;
            }
        }
        return false;
    }

    private receiveEvent(envelope: ControlEventEnvelope): boolean {
        const run = this.ensureRun(envelope.runId);
        const agent = this.ensureAgent(run, envelope.agentId);
        const storedEnvelope = envelope.kind === 'report'
            ? toCompactedControlReport(envelope, this.redaction)
            : envelope;
        if (storedEnvelope.kind === 'report') {
            const reportKey = toControlReportDedupeKey(storedEnvelope);
            if (run.reportKeys.has(reportKey)) {
                return false;
            }
            run.reportKeys.add(reportKey);
            trimControlReportDedupeKeys(run);
        }
        agent.receivedEventCount += 1;
        agent.lastSeenAtEpochMs = this.now();
        run.events.push(storedEnvelope);
        if (storedEnvelope.kind === 'stats') {
            run.stats.push(storedEnvelope);
        }
        if (storedEnvelope.kind === 'report') {
            run.reports.push(storedEnvelope);
        }
        this.touch(run);
        trimControlRunEvidence(run, this.distributedRuns.values(), this.runtimeRetentionBounds);
        return true;
    }

    private assertCommandAllowed(kind: RallarBlackBoxTestCommandKind): void {
        if (!this.allowedCommandKinds || this.allowedCommandKinds.has(kind)) {
            return;
        }

        throw new Error(`Command kind is not allowed: ${kind}.`);
    }

    private assertCommandRateLimit(agent: ControlAgentState): void {
        if (this.commandRateLimitMax <= 0) {
            return;
        }

        const now = this.now();
        const windowStart = now - this.commandRateLimitWindowMs;
        agent.commandEnqueueTimestamps = agent.commandEnqueueTimestamps
            .filter((timestamp) => timestamp >= windowStart);
        if (agent.commandEnqueueTimestamps.length >= this.commandRateLimitMax) {
            throw new Error('Command rate limit exceeded.');
        }

        agent.commandEnqueueTimestamps.push(now);
    }

    private requireDistributedRun(distributedRunId: string): ControlDistributedRunState {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            throw new Error(`Distributed run not found: ${distributedRunId}.`);
        }
        return distributedRun;
    }

    private assertDistributedRunCanMutate(
        distributedRun: ControlDistributedRunState,
        action: ControlDistributedRunCommandPhase
    ): void {
        if (!isDistributedRunTerminalState(distributedRun.state)) {
            return;
        }

        throw new Error(
            `Cannot ${action} distributed run ${distributedRun.distributedRunId} in terminal state ${distributedRun.state}.`
        );
    }

    private refreshDistributedTargetResolution(
        distributedRun: ControlDistributedRunState
    ): RallarBlackBoxDistributedTargetResolution {
        const resolution = isResolvedTargetPolicy(distributedRun.manifest)
            ? this.resolveDistributedRunTargets(distributedRun.manifest)
            : toExplicitDistributedTargetResolution(
                distributedRun,
                this.runs.get(distributedRun.controlRunId),
                this.now()
            );
        distributedRun.targetResolution = resolution;
        distributedRun.targetAgentIds = [...resolution.targetAgentIds];
        return resolution;
    }

    private advanceDistributedRunOrchestration(distributedRun: ControlDistributedRunState): void {
        if (isDistributedRunTerminalState(distributedRun.state)) {
            return;
        }

        if (distributedRun.state === 'waiting-for-ack') {
            if (isDistributedAckTimedOut(distributedRun, this.now())) {
                return;
            }
            if (this.allTargetPhaseCommandsSucceeded(distributedRun, 'stage')) {
                if (this.distributedRunBarrierEnabled(distributedRun)) {
                    this.queueDistributedBarrierCommands(distributedRun);
                    distributedRun.state = 'waiting-for-barrier';
                    distributedRun.barrierStartedAtEpochMs ??= this.now();
                    distributedRun.updatedAtEpochMs = this.now();
                    return;
                }
                this.readyOrAutoStartDistributedRun(distributedRun);
            }
        }

        if (distributedRun.state === 'waiting-for-barrier') {
            if (isDistributedBarrierTimedOut(distributedRun, this.now())) {
                return;
            }
            if (this.allTargetPhaseCommandsSucceeded(distributedRun, 'barrier')) {
                distributedRun.barrierCompletedAtEpochMs ??= this.now();
                this.readyOrAutoStartDistributedRun(distributedRun);
            }
        }

        if (distributedRun.state === 'ready' && this.shouldAutoStartDistributedRun(distributedRun)) {
            this.queueDistributedStartCommands(distributedRun);
        }
    }

    private readyOrAutoStartDistributedRun(distributedRun: ControlDistributedRunState): void {
        if (this.shouldAutoStartDistributedRun(distributedRun)) {
            this.queueDistributedStartCommands(distributedRun);
            return;
        }

        distributedRun.state = 'ready';
        distributedRun.updatedAtEpochMs = this.now();
    }

    private shouldAutoStartDistributedRun(distributedRun: ControlDistributedRunState): boolean {
        if (distributedRun.manifest.startMode === 'auto-after-ready') {
            return true;
        }
        return distributedRun.manifest.startMode === 'scheduled' &&
            distributedRun.manifest.startDeadlineEpochMs !== undefined &&
            this.now() >= distributedRun.manifest.startDeadlineEpochMs;
    }

    private distributedRunScheduledStartPending(distributedRun: ControlDistributedRunState): boolean {
        return distributedRun.manifest.startMode === 'scheduled' &&
            distributedRun.manifest.startDeadlineEpochMs !== undefined &&
            this.now() < distributedRun.manifest.startDeadlineEpochMs;
    }

    private distributedRunStartPrerequisitePending(distributedRun: ControlDistributedRunState): boolean {
        const hasStageLinks = distributedRun.commandLinks.some((link) => link.phase === 'stage');
        if (hasStageLinks && !this.allTargetPhaseCommandsSucceeded(distributedRun, 'stage')) {
            return true;
        }

        if (!this.distributedRunBarrierEnabled(distributedRun) || !hasStageLinks) {
            return false;
        }

        if (!distributedRun.commandLinks.some((link) => link.phase === 'barrier')) {
            this.queueDistributedBarrierCommands(distributedRun);
            distributedRun.state = 'waiting-for-barrier';
            distributedRun.barrierStartedAtEpochMs ??= this.now();
            distributedRun.updatedAtEpochMs = this.now();
            return true;
        }

        return !this.allTargetPhaseCommandsSucceeded(distributedRun, 'barrier');
    }

    private queueDistributedBarrierCommands(distributedRun: ControlDistributedRunState): void {
        for (const agentId of distributedRun.targetAgentIds) {
            this.enqueueLinkedDistributedCommand({
                distributedRun,
                phase: 'barrier',
                agentId,
                selection: undefined,
                command: toDistributedBarrierCommand(distributedRun, agentId)
            });
        }
    }

    private queueDistributedStartCommands(distributedRun: ControlDistributedRunState): void {
        for (const agentId of distributedRun.targetAgentIds) {
            for (const selection of toRecipeSelectionsForAgent(distributedRun, agentId)) {
                this.enqueueLinkedDistributedCommand({
                    distributedRun,
                    phase: 'start',
                    agentId,
                    selection,
                    command: toDistributedStartCommand(distributedRun, agentId, selection)
                });
            }
        }

        distributedRun.state = 'running';
        distributedRun.startedAtEpochMs ??= this.now();
        distributedRun.updatedAtEpochMs = this.now();
    }

    private reconcileDistributedCommandLinks(distributedRun: ControlDistributedRunState): void {
        const run = this.runs.get(distributedRun.controlRunId);
        if (!run || distributedRun.targetAgentIds.length === 0) {
            return;
        }

        for (const agentId of distributedRun.targetAgentIds) {
            for (const selection of toRecipeSelectionsForAgent(distributedRun, agentId)) {
                this.reconcileDistributedCommandLink({
                    distributedRun,
                    run,
                    phase: 'stage',
                    agentId,
                    selection
                });
                this.reconcileDistributedCommandLink({
                    distributedRun,
                    run,
                    phase: 'start',
                    agentId,
                    selection
                });
            }
            if (this.distributedRunBarrierEnabled(distributedRun)) {
                this.reconcileDistributedCommandLink({
                    distributedRun,
                    run,
                    phase: 'barrier',
                    agentId,
                    selection: undefined
                });
            }
        }
    }

    private reconcileDistributedCommandLink(
        input: ReconcileDistributedCommandInput
    ): void {
        const link = toRecoveredDistributedCommandLink(input);
        if (!link) {
            return;
        }
        const { distributedRun, phase } = input;
        distributedRun.commandLinks.push(link);
        if (phase === 'start') {
            distributedRun.startedAtEpochMs ??= link.queuedAtEpochMs;
        }
        if (phase === 'barrier') {
            distributedRun.barrierStartedAtEpochMs ??= link.queuedAtEpochMs;
        }
        distributedRun.updatedAtEpochMs = this.now();
    }

    private allTargetPhaseCommandsSucceeded(
        distributedRun: ControlDistributedRunState,
        phase: ControlDistributedRunCommandPhase
    ): boolean {
        const run = this.runs.get(distributedRun.controlRunId);
        if (!run || distributedRun.targetAgentIds.length === 0) {
            return false;
        }

        return distributedRun.targetAgentIds.every((agentId) => {
            const links = distributedRun.commandLinks.filter((link) =>
                link.phase === phase && link.agentId === agentId
            );
            return links.length > 0 &&
                links.every((link) => run.results.get(link.commandId)?.ok === true);
        });
    }

    private distributedRunBarrierEnabled(distributedRun: ControlDistributedRunState): boolean {
        return distributedRun.manifest.barrier?.enabled === true;
    }

    private enqueueLinkedDistributedCommand(
        { distributedRun, phase, agentId, selection, command }: LinkedDistributedCommandInput
    ): ControlCommandEnvelope {
        const recipeId = selection ? toDistributedRecipeKey(selection) : undefined;
        const existingLink = distributedRun.commandLinks.find((link) =>
            link.phase === phase &&
            link.agentId === agentId &&
            link.recipeId === recipeId
        );
        if (existingLink) {
            const run = this.runs.get(distributedRun.controlRunId);
            const existingCommand = run?.commands.get(existingLink.commandId);
            if (existingCommand) {
                return existingCommand.envelope;
            }
        }

        const envelope = this.enqueueCommand({
            runId: distributedRun.controlRunId,
            agentId,
            commandId: command.commandId,
            command,
            deadlineEpochMs: phase === 'start' ? distributedRun.manifest.startDeadlineEpochMs : undefined
        });
        distributedRun.commandLinks.push({
            phase,
            agentId,
            commandId: envelope.commandId,
            recipeId,
            role: selection?.role,
            queuedAtEpochMs: this.now()
        });
        distributedRun.updatedAtEpochMs = this.now();
        return envelope;
    }

    private snapshotDistributedRunValue(
        distributedRun: ControlDistributedRunState
    ): ControlDistributedRunSnapshot {
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
        const snapshot = this.snapshotDistributedRunValue(distributedRun);
        if (!isDistributedRunTerminalState(snapshot.state)) {
            return this.fleetReports.get(distributedRunId);
        }
        const existing = this.fleetReports.get(distributedRunId);
        if (existing && existing.generatedAtEpochMs >= snapshot.updatedAtEpochMs) {
            return existing;
        }
        const report = createControlFleetRunReport({
            distributedRun: snapshot,
            controlRun: this.snapshotRun(snapshot.controlRunId),
            generatedAtEpochMs: this.now(),
            redaction: this.redaction
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

    private refreshDistributedRunState(
        distributedRun: ControlDistributedRunState
    ): RallarBlackBoxDistributedRunRollup {
        if (isDistributedRunTerminalState(distributedRun.state) && distributedRun.rollup) {
            return distributedRun.rollup;
        }

        this.reconcileDistributedCommandLinks(distributedRun);
        this.advanceDistributedRunOrchestration(distributedRun);
        const evaluated = toDistributedRunRollup({
            distributedRun,
            run: this.runs.get(distributedRun.controlRunId),
            redaction: this.redaction,
            nowEpochMs: this.now()
        });
        if (evaluated.state !== distributedRun.state) {
            distributedRun.state = evaluated.state;
            distributedRun.updatedAtEpochMs = this.now();
            if (isDistributedRunTerminalState(evaluated.state)) {
                distributedRun.completedAtEpochMs ??= this.now();
            }
        }
        if (isDistributedRunTerminalState(distributedRun.state)) {
            distributedRun.rollup = evaluated;
        }
        return evaluated;
    }

    private ensureRun(runId: string): ControlRunState {
        const existing = this.runs.get(runId);
        if (existing) {
            return existing;
        }

        const now = this.now();
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
        run.updatedAtEpochMs = this.now();
    }

    private rejectUnresolvedDistributedTargets(distributedRun: ControlDistributedRunState): boolean {
        const error = toDistributedTargetFailure(distributedRun);
        if (!error) {
            return false;
        }
        distributedRun.state = 'failed';
        distributedRun.completedAtEpochMs = this.now();
        distributedRun.error = error;
        return true;
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
        const distributedRunIds = Array.from(this.distributedRuns.values()).filter((run) =>
            selected.has(run.controlRunId)
        ).map((run) => run.distributedRunId);
        return this.deleteRetainedRecords({ deletedRunIds, distributedRunIds, fleetReportIds: distributedRunIds });
    }
}

export function createRallarBlackBoxControlService(
    options: RallarBlackBoxControlServiceOptions = {}
): RallarBlackBoxControlService {
    return new RallarBlackBoxControlService(options);
}

function cleanSegment(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
