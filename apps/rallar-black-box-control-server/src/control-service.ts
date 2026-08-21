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
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
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
    type RallarBlackBoxControlAgentCandidate,
    type RallarBlackBoxControlAgentIdentity,
    type RallarBlackBoxDistributedParticipantResult,
    type RallarBlackBoxDistributedRecipeResult,
    type RallarBlackBoxDistributedRoleAssignment,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunRecipeSelection,
    type RallarBlackBoxDistributedRunRollup,
    type RallarBlackBoxDistributedRunState,
    type RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    evaluateDistributedGroupAssertions
} from '@shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import {
    toDistributedGroupAssertionParticipants,
    toDistributedGroupAssertionRecipeEvidence
} from '@shared-test/rallar-bb-test/distributed/group-assertions-evidence.ts';
import type {
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRedactionOptions
} from '@shared-test/rallar-bb-test/types.ts';
import { createControlDistributedRunArtifactBundle } from './control-artifacts.ts';
import {
    resolveFirstStartedAtEpochMs,
    resolveLastEndedAtEpochMs,
    toDistributedRecipeResult,
    toDistributedRunResultError
} from './control-distributed-recipe-results.ts';
import {
    createControlFleetAggregateReport,
    createControlFleetReportBundle,
    createControlFleetRunReport,
    filterControlFleetReports
} from './control-fleet.ts';

const DEFAULT_DISTRIBUTED_BARRIER_TIMEOUT_MS = 15_000;
const DEFAULT_RUNTIME_RETENTION_BOUNDS: Required<ControlRunSnapshotBounds> = {
    commands: 1_000,
    results: 1_000,
    events: 2_000,
    stats: 500,
    reports: 20,
    heartbeats: 500
};
const REPORT_DEDUPE_KEY_LIMIT = 1_000;

export type EnqueueControlCommandInput = Readonly<{
    runId: string;
    agentId: string;
    commandId?: string;
    command: RallarBlackBoxTestCommand;
    deadlineEpochMs?: number;
}>;

export type RallarBlackBoxControlServiceOptions = Readonly<{
    now?: () => number;
    commandIdFactory?: () => string;
    redaction?: RallarBlackBoxTestRedactionOptions;
    allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    commandRateLimitMax?: number;
    commandRateLimitWindowMs?: number;
    runTokenTtlMs?: number;
    runtimeRetentionBounds?: ControlRunSnapshotBounds;
}>;

export type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlRunSnapshotBounds,
    ControlRunToken,
    ControlServerSnapshot
};

export type RallarBlackBoxControlServiceReceiveResult = Readonly<{
    kind: ControlClientEnvelope['kind'];
    runId: string;
    agentId: string;
    accepted: boolean;
}>;

type StoredCommand = {
    envelope: ControlCommandEnvelope;
    fingerprint: string;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
    lastDispatchedConnectionSequence?: number;
};

type StoredAgent = {
    runId: string;
    agentId: string;
    connected: boolean;
    registeredAtEpochMs?: number;
    disconnectedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    status?: string;
    identity?: RallarBlackBoxControlAgentIdentity;
    connectionSequence: number;
    reconnectCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    completedCommandIds: Set<string>;
    resumeCompletedCommandIds: Set<string>;
    commandEnqueueTimestamps: number[];
};

type StoredToken = {
    runId: string;
    agentId: string;
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
};

type StoredRun = {
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: Map<string, StoredAgent>;
    commands: Map<string, StoredCommand>;
    results: Map<string, ControlResultEnvelope>;
    events: ControlEventEnvelope[];
    stats: ControlEventEnvelope[];
    reports: ControlEventEnvelope[];
    reportKeys: Set<string>;
    heartbeats: ControlHeartbeatEnvelope[];
    tokens: Map<string, StoredToken>;
    retentionRevision: number;
    issuedRunTokenStateRevision: number;
};

type StoredDistributedRun = {
    distributedRunId: string;
    controlRunId: string;
    manifest: RallarBlackBoxDistributedRunManifest;
    state: RallarBlackBoxDistributedRunState;
    rollup?: RallarBlackBoxDistributedRunRollup;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    stagedAtEpochMs?: number;
    barrierStartedAtEpochMs?: number;
    barrierCompletedAtEpochMs?: number;
    startedAtEpochMs?: number;
    cancelledAtEpochMs?: number;
    completedAtEpochMs?: number;
    targetAgentIds: string[];
    targetResolution?: RallarBlackBoxDistributedTargetResolution;
    commandLinks: ControlDistributedRunCommandLink[];
    error?: ControlDistributedRunSnapshot['error'];
};

export class RallarBlackBoxControlService {
    private readonly now: () => number;
    private readonly commandIdFactory: () => string;
    private readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
    private readonly allowedCommandKinds: Set<RallarBlackBoxTestCommandKind> | undefined;
    private readonly commandRateLimitMax: number;
    private readonly commandRateLimitWindowMs: number;
    private readonly runTokenTtlMs: number;
    private readonly runtimeRetentionBounds: ControlRunSnapshotBounds;
    private readonly runs = new Map<string, StoredRun>();
    private readonly distributedRuns = new Map<string, StoredDistributedRun>();
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
        const fingerprint = this.commandFingerprint(envelope);
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
        this.trimRunToRuntimeBounds(run);
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
        const token: StoredToken = {
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
        const stored: StoredDistributedRun = {
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
            agents: this.controlAgentCandidates(controlRunId),
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

        if (distributedRun.targetAgentIds.length === 0) {
            distributedRun.state = 'failed';
            distributedRun.completedAtEpochMs = this.now();
            distributedRun.error = {
                code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
                message: 'No target control agents were resolved for this distributed run.',
                details: {
                    targetPolicy: distributedRun.manifest.targetPolicy,
                    group: distributedRun.manifest.group
                }
            };
            return this.snapshotDistributedRunValue(distributedRun);
        }
        const expectedParticipantCount = distributedRun.manifest.targetPolicy.expectedParticipantCount;
        if (
            expectedParticipantCount !== undefined &&
            distributedRun.targetAgentIds.length !== expectedParticipantCount
        ) {
            distributedRun.state = 'failed';
            distributedRun.completedAtEpochMs = this.now();
            distributedRun.error = {
                code: 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH',
                message:
                    `Resolved ${distributedRun.targetAgentIds.length} target agents, expected ${expectedParticipantCount}.`,
                details: {
                    targetAgentIds: distributedRun.targetAgentIds,
                    expectedParticipantCount
                }
            };
            return this.snapshotDistributedRunValue(distributedRun);
        }

        for (const agentId of distributedRun.targetAgentIds) {
            for (const selection of this.recipeSelectionsForAgent(distributedRun, agentId)) {
                this.enqueueLinkedDistributedCommand(
                    distributedRun,
                    'stage',
                    agentId,
                    selection,
                    this.stageCommandForSelection(distributedRun, agentId, selection)
                );
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
        if (distributedRun.targetAgentIds.length === 0) {
            distributedRun.state = 'failed';
            distributedRun.completedAtEpochMs = this.now();
            distributedRun.error = {
                code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
                message: 'No target control agents were resolved for this distributed run.',
                details: {
                    targetPolicy: distributedRun.manifest.targetPolicy,
                    group: distributedRun.manifest.group
                }
            };
            return this.snapshotDistributedRunValue(distributedRun);
        }
        const expectedParticipantCount = distributedRun.manifest.targetPolicy.expectedParticipantCount;
        if (
            expectedParticipantCount !== undefined &&
            distributedRun.targetAgentIds.length !== expectedParticipantCount
        ) {
            distributedRun.state = 'failed';
            distributedRun.completedAtEpochMs = this.now();
            distributedRun.error = {
                code: 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH',
                message:
                    `Resolved ${distributedRun.targetAgentIds.length} target agents, expected ${expectedParticipantCount}.`,
                details: {
                    targetAgentIds: distributedRun.targetAgentIds,
                    expectedParticipantCount
                }
            };
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
                distributedRun.targetAgentIds = this.resolveDistributedTargetAgentIds(distributedRun);
            }
            for (const agentId of distributedRun.targetAgentIds) {
                const commandId = this.distributedCommandId(distributedRun, 'cancel', agentId, 'run');
                this.enqueueLinkedDistributedCommand(distributedRun, 'cancel', agentId, undefined, {
                    kind: 'recipe.cancel',
                    commandId,
                    label: `Cancel distributed run ${distributedRun.distributedRunId}`,
                    reason,
                    metadata: this.distributedCommandMetadata(
                        distributedRun,
                        'cancel',
                        agentId,
                        undefined
                    )
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
        return this.snapshotRunValue(run);
    }

    deleteRun(runId: string): boolean {
        const deleted = this.runs.delete(runId);
        if (deleted) {
            for (const [distributedRunId, distributedRun] of this.distributedRuns.entries()) {
                if (distributedRun.controlRunId === runId) {
                    this.distributedRuns.delete(distributedRunId);
                    this.fleetReports.delete(distributedRunId);
                }
            }
        }
        return deleted;
    }

    pruneRuns(maxRuns: number | undefined): readonly string[] {
        if (maxRuns === undefined || maxRuns <= 0 || this.runs.size <= maxRuns) {
            return [];
        }
        const keep = new Set(
            Array.from(this.runs.values())
                .sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs)
                .slice(0, maxRuns)
                .map((run) => run.runId)
        );
        const deletedRunIds: string[] = [];
        for (const runId of this.runs.keys()) {
            if (!keep.has(runId)) {
                this.runs.delete(runId);
                deletedRunIds.push(runId);
            }
        }
        for (const [distributedRunId, distributedRun] of this.distributedRuns.entries()) {
            if (deletedRunIds.includes(distributedRun.controlRunId)) {
                this.distributedRuns.delete(distributedRunId);
                this.fleetReports.delete(distributedRunId);
            }
        }
        return deletedRunIds;
    }

    createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan {
        return planControlRunRetention({
            maxRuns,
            runs: Array.from(this.runs.values(), (run) => this.snapshotRunValue(run)),
            distributedRuns: Array.from(
                this.distributedRuns.values(),
                (run) => this.passiveDistributedRunSnapshotValue(run)
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
        const deletedRunIds: string[] = [];
        for (const runId of plan.deletedRunIds) {
            if (this.runs.delete(runId)) {
                deletedRunIds.push(runId);
            }
        }
        for (const distributedRunId of plan.distributedRunIds) {
            this.distributedRuns.delete(distributedRunId);
        }
        for (const fleetReportId of plan.fleetReportIds) {
            this.fleetReports.delete(fleetReportId);
        }
        return deletedRunIds;
    }

    restoreSnapshot(snapshot: ControlServerSnapshot): void {
        this.runs.clear();
        this.distributedRuns.clear();
        this.fleetReports.clear();
        const evidenceCommandKeys = new Set<string>();
        for (const distributedRunSnapshot of snapshot.distributedRuns ?? []) {
            if ((distributedRunSnapshot.manifest.groupAssertions?.length ?? 0) === 0) {
                continue;
            }
            distributedRunSnapshot.commandLinks
                .filter((link) => link.phase === 'start')
                .forEach((link) =>
                    evidenceCommandKeys.add(
                        resultCommandKey(distributedRunSnapshot.controlRunId, link.commandId)
                    )
                );
        }
        for (const runSnapshot of snapshot.runs) {
            const run: StoredRun = {
                runId: runSnapshot.runId,
                createdAtEpochMs: runSnapshot.createdAtEpochMs,
                updatedAtEpochMs: runSnapshot.updatedAtEpochMs,
                agents: new Map(),
                commands: new Map(),
                results: new Map(),
                events: runSnapshot.events.map((event) =>
                    event.kind === 'report' ? this.compactReportEnvelope(event) : event
                ),
                stats: [...runSnapshot.stats],
                reports: runSnapshot.reports.map((event) => this.compactReportEnvelope(event)),
                reportKeys: new Set(
                    runSnapshot.reports.map((report) => this.reportDedupeKey(report))
                ),
                heartbeats: [...runSnapshot.heartbeats],
                tokens: new Map(),
                retentionRevision: 0,
                issuedRunTokenStateRevision: 0
            };
            for (const agentSnapshot of runSnapshot.agents) {
                run.agents.set(agentSnapshot.agentId, {
                    runId: agentSnapshot.runId,
                    agentId: agentSnapshot.agentId,
                    connected: false,
                    registeredAtEpochMs: agentSnapshot.registeredAtEpochMs,
                    disconnectedAtEpochMs: agentSnapshot.disconnectedAtEpochMs,
                    lastSeenAtEpochMs: agentSnapshot.lastSeenAtEpochMs,
                    lastHeartbeatAtEpochMs: agentSnapshot.lastHeartbeatAtEpochMs,
                    status: agentSnapshot.status,
                    identity: agentSnapshot.identity,
                    connectionSequence: agentSnapshot.connectionSequence,
                    reconnectCount: agentSnapshot.reconnectCount,
                    receivedResultCount: agentSnapshot.receivedResultCount,
                    receivedEventCount: agentSnapshot.receivedEventCount,
                    completedCommandIds: new Set(agentSnapshot.completedCommandIds),
                    resumeCompletedCommandIds: new Set(agentSnapshot.resumeCompletedCommandIds),
                    commandEnqueueTimestamps: []
                });
            }
            for (const commandSnapshot of runSnapshot.commands) {
                run.commands.set(commandSnapshot.envelope.commandId, {
                    envelope: commandSnapshot.envelope,
                    fingerprint: this.commandFingerprint(commandSnapshot.envelope),
                    queuedAtEpochMs: commandSnapshot.queuedAtEpochMs,
                    dispatchedAtEpochMs: commandSnapshot.dispatchedAtEpochMs,
                    completedAtEpochMs: commandSnapshot.completedAtEpochMs,
                    dispatchCount: commandSnapshot.dispatchCount
                });
            }
            for (const result of runSnapshot.results) {
                run.results.set(
                    result.commandId,
                    evidenceCommandKeys.has(resultCommandKey(run.runId, result.commandId))
                        ? result
                        : this.compactResultEnvelope(result)
                );
            }
            this.runs.set(run.runId, run);
        }
        for (const distributedRunSnapshot of snapshot.distributedRuns ?? []) {
            this.distributedRuns.set(distributedRunSnapshot.distributedRunId, {
                distributedRunId: distributedRunSnapshot.distributedRunId,
                controlRunId: distributedRunSnapshot.controlRunId,
                manifest: distributedRunSnapshot.manifest,
                state: distributedRunSnapshot.state,
                createdAtEpochMs: distributedRunSnapshot.createdAtEpochMs,
                updatedAtEpochMs: distributedRunSnapshot.updatedAtEpochMs,
                stagedAtEpochMs: distributedRunSnapshot.stagedAtEpochMs,
                barrierStartedAtEpochMs: distributedRunSnapshot.barrierStartedAtEpochMs,
                barrierCompletedAtEpochMs: distributedRunSnapshot.barrierCompletedAtEpochMs,
                startedAtEpochMs: distributedRunSnapshot.startedAtEpochMs,
                cancelledAtEpochMs: distributedRunSnapshot.cancelledAtEpochMs,
                completedAtEpochMs: distributedRunSnapshot.completedAtEpochMs,
                targetAgentIds: [...distributedRunSnapshot.targetAgentIds],
                targetResolution: distributedRunSnapshot.targetResolution,
                commandLinks: [...distributedRunSnapshot.commandLinks],
                rollup: distributedRunSnapshot.rollup,
                error: distributedRunSnapshot.error
            });
        }
        for (const fleetReport of snapshot.fleetReports ?? []) {
            this.fleetReports.set(fleetReport.distributedRunId, fleetReport);
        }
    }

    snapshot(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            runs: Array.from(this.runs.values(), (run) => this.snapshotRunValue(run, bounds)),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: this.listFleetReports().reports
        };
    }

    snapshotForPersistence(bounds: ControlRunSnapshotBounds = {}): ControlServerSnapshot {
        return {
            runs: Array.from(this.runs.values(), (run) => this.snapshotRunValue(run, bounds)),
            distributedRuns: this.listDistributedRuns(),
            fleetReports: Array.from(this.fleetReports.values())
        };
    }

    snapshotRun(
        runId: string,
        bounds: ControlRunSnapshotBounds = {}
    ): ControlRunSnapshot | undefined {
        const run = this.runs.get(runId);
        return run ? this.snapshotRunValue(run, bounds) : undefined;
    }

    snapshotCommand(
        runId: string,
        commandId: string
    ): ControlQueuedCommandSnapshot | undefined {
        const command = this.runs.get(runId)?.commands.get(commandId);
        return command ? this.snapshotCommandValue(command) : undefined;
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
        this.trimRunToRuntimeBounds(run);
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
        this.trimRunToRuntimeBounds(run);
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
                : this.compactResultEnvelope(envelope)
        );

        const command = run.commands.get(envelope.commandId);
        if (command) {
            command.completedAtEpochMs = this.now();
        }
        this.touch(run);
        this.trimRunToRuntimeBounds(run);
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
            ? this.compactReportEnvelope(envelope)
            : envelope;
        if (storedEnvelope.kind === 'report') {
            const reportKey = this.reportDedupeKey(storedEnvelope);
            if (run.reportKeys.has(reportKey)) {
                return false;
            }
            run.reportKeys.add(reportKey);
            this.trimReportDedupeKeys(run);
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
        this.trimRunToRuntimeBounds(run);
        return true;
    }

    private compactReportEnvelope(envelope: ControlEventEnvelope): ControlEventEnvelope {
        return {
            ...envelope,
            payload: redactRallarBlackBoxValue(compactReportPayload(envelope.payload), this.redaction)
        };
    }

    private compactResultEnvelope(envelope: ControlResultEnvelope): ControlResultEnvelope {
        return compactResultEnvelope(envelope);
    }

    private reportDedupeKey(envelope: ControlEventEnvelope): string {
        const payload = isRecord(envelope.payload) ? envelope.payload : undefined;
        const report = payload && isRecord(payload.payload) ? payload.payload : payload;
        const reportId = report && typeof report.reportId === 'string' ? report.reportId : undefined;
        return [
            envelope.runId,
            envelope.agentId,
            envelope.eventId ?? reportId ?? envelope.atEpochMs
        ].join('\u0000');
    }

    private trimRunToRuntimeBounds(run: StoredRun): void {
        const protectedCommandIds = this.protectedRuntimeCommandIds(run.runId);
        for (const command of run.commands.values()) {
            if (command.completedAtEpochMs === undefined) {
                protectedCommandIds.add(command.envelope.commandId);
            }
        }
        this.trimMapByInsertion(
            run.commands,
            this.runtimeRetentionBounds.commands,
            protectedCommandIds
        );
        this.trimMapByInsertion(run.results, this.runtimeRetentionBounds.results, protectedCommandIds);
        run.events = this.trimArray(run.events, this.runtimeRetentionBounds.events);
        run.stats = this.trimArray(run.stats, this.runtimeRetentionBounds.stats);
        run.reports = this.trimArray(run.reports, this.runtimeRetentionBounds.reports);
        run.heartbeats = this.trimArray(run.heartbeats, this.runtimeRetentionBounds.heartbeats);
    }

    private trimReportDedupeKeys(run: StoredRun): void {
        for (const key of run.reportKeys) {
            if (run.reportKeys.size <= REPORT_DEDUPE_KEY_LIMIT) {
                return;
            }
            run.reportKeys.delete(key);
        }
    }

    private protectedRuntimeCommandIds(runId: string): Set<string> {
        const commandIds = new Set<string>();
        for (const distributedRun of this.distributedRuns.values()) {
            if (
                distributedRun.controlRunId !== runId || isDistributedRunTerminalState(distributedRun.state)
            ) {
                continue;
            }
            distributedRun.commandLinks.forEach((link) => commandIds.add(link.commandId));
        }
        return commandIds;
    }

    private trimMapByInsertion<T>(
        values: Map<string, T>,
        limit: number | undefined,
        protectedKeys: ReadonlySet<string>
    ): void {
        if (limit === undefined || !Number.isFinite(limit) || limit < 0 || values.size <= limit) {
            return;
        }

        for (const key of values.keys()) {
            if (values.size <= limit) {
                return;
            }
            if (protectedKeys.has(key)) {
                continue;
            }
            values.delete(key);
        }
    }

    private trimArray<T>(values: readonly T[], limit: number | undefined): T[] {
        if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
            return [...values];
        }
        return values.slice(Math.max(0, values.length - Math.floor(limit)));
    }

    private assertCommandAllowed(kind: RallarBlackBoxTestCommandKind): void {
        if (!this.allowedCommandKinds || this.allowedCommandKinds.has(kind)) {
            return;
        }

        throw new Error(`Command kind is not allowed: ${kind}.`);
    }

    private assertCommandRateLimit(agent: StoredAgent): void {
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

    private commandFingerprint(envelope: ControlCommandEnvelope): string {
        return JSON.stringify({
            command: envelope.command,
            deadlineEpochMs: envelope.deadlineEpochMs
        });
    }

    private requireDistributedRun(distributedRunId: string): StoredDistributedRun {
        const distributedRun = this.distributedRuns.get(distributedRunId);
        if (!distributedRun) {
            throw new Error(`Distributed run not found: ${distributedRunId}.`);
        }
        return distributedRun;
    }

    private assertDistributedRunCanMutate(
        distributedRun: StoredDistributedRun,
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
        distributedRun: StoredDistributedRun
    ): RallarBlackBoxDistributedTargetResolution {
        const resolution = this.shouldUseResolvedTargetIds(distributedRun.manifest)
            ? this.resolveDistributedRunTargets(distributedRun.manifest)
            : this.explicitDistributedTargetResolution(distributedRun);
        distributedRun.targetResolution = resolution;
        distributedRun.targetAgentIds = [...resolution.targetAgentIds];
        return resolution;
    }

    private shouldUseResolvedTargetIds(manifest: RallarBlackBoxDistributedRunManifest): boolean {
        return manifest.targetPolicy.mode === 'all-online-group-members' ||
            manifest.roleAssignmentPolicy !== undefined;
    }

    private controlAgentCandidates(
        controlRunId: string
    ): readonly RallarBlackBoxControlAgentCandidate[] {
        const run = this.runs.get(controlRunId);
        if (!run) {
            return [];
        }
        return Array.from(run.agents.values(), (agent) => ({
            agentId: agent.agentId,
            connected: agent.connected,
            lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
            lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
            identity: agent.identity
        }));
    }

    private explicitDistributedTargetResolution(
        distributedRun: StoredDistributedRun
    ): RallarBlackBoxDistributedTargetResolution {
        const targetAgentIds = this.resolveDistributedTargetAgentIds(distributedRun);
        const roleAssignments = this.explicitRoleAssignmentsForTargets(
            distributedRun.manifest,
            targetAgentIds
        );
        const roleCounts = countStrings(roleAssignments.map((assignment) => assignment.role));
        const candidates = this.controlAgentCandidates(distributedRun.controlRunId);
        const candidateById = new Map(candidates.map((candidate) => [candidate.agentId, candidate]));
        const selectedCandidates = targetAgentIds
            .map((agentId) => candidateById.get(agentId))
            .filter((candidate): candidate is RallarBlackBoxControlAgentCandidate => Boolean(candidate));
        const expected = distributedRun.manifest.targetPolicy.expectedParticipantCount;

        return {
            group: distributedRun.manifest.group,
            resolvedAtEpochMs: this.now(),
            staleAfterMs: 30_000,
            targetPolicyMode: distributedRun.manifest.targetPolicy.mode,
            targetAgentIds,
            roleAssignments,
            blockers: [],
            summary: {
                agents: candidates.length,
                targetable: targetAgentIds.length,
                selected: targetAgentIds.length,
                expectedParticipantCount: expected,
                missingExpectedParticipants: expected === undefined
                    ? 0
                    : Math.max(0, expected - targetAgentIds.length),
                staleAgents: 0,
                offlineAgents: 0,
                wrongGroupAgents: 0,
                agentsWithoutIdentity: 0,
                roleCounts,
                regions: countStrings(selectedCandidates.map((candidate) => candidate.identity?.region)),
                providers: countStrings(selectedCandidates.map((candidate) => candidate.identity?.provider))
            }
        };
    }

    private explicitRoleAssignmentsForTargets(
        manifest: RallarBlackBoxDistributedRunManifest,
        targetAgentIds: readonly string[]
    ): readonly RallarBlackBoxDistributedRoleAssignment[] {
        const selected = new Set(targetAgentIds);
        const explicitAssignments = manifest.roleAssignments ?? [];
        if (explicitAssignments.length > 0) {
            return explicitAssignments
                .filter((assignment) => selected.has(assignment.agentId))
                .map((assignment) => ({ ...assignment }));
        }

        return Object.entries(manifest.targetPolicy.roles ?? {})
            .flatMap(([role, agentIds]) =>
                agentIds
                    .filter((agentId) => selected.has(agentId))
                    .map((agentId) => ({ role, agentId, required: true }))
            );
    }

    private resolveDistributedTargetAgentIds(distributedRun: StoredDistributedRun): string[] {
        const policy = distributedRun.manifest.targetPolicy;
        const unique = (values: readonly string[]) => [
            ...new Set(
                values.map(cleanSegment).filter((value): value is string => Boolean(value))
            )
        ];

        if (policy.mode === 'selected-agents') {
            return unique(policy.agentIds ?? []);
        }

        if (policy.mode === 'role-map') {
            return unique([
                ...Object.values(policy.roles ?? {}).flat(),
                ...(distributedRun.manifest.roleAssignments ?? []).map((assignment) => assignment.agentId)
            ]);
        }

        const run = this.runs.get(distributedRun.controlRunId);
        if (!run) {
            return [];
        }

        return Array.from(run.agents.values())
            .filter((agent) =>
                agent.connected &&
                this.identityMatchesDistributedGroup(agent.identity, distributedRun.manifest)
            )
            .map((agent) => agent.agentId);
    }

    private identityMatchesDistributedGroup(
        identity: RallarBlackBoxControlAgentIdentity | undefined,
        manifest: RallarBlackBoxDistributedRunManifest
    ): boolean {
        return identity?.applicationId === manifest.group.applicationId &&
            identity.workspaceId === manifest.group.workspaceId &&
            identity.groupId === manifest.group.groupId;
    }

    private recipeSelectionsForAgent(
        distributedRun: StoredDistributedRun,
        agentId: string
    ): readonly RallarBlackBoxDistributedRunRecipeSelection[] {
        const manifest = distributedRun.manifest;
        const roles = this.rolesForAgent(distributedRun, agentId);
        const assignments = this.roleAssignmentsForAgent(distributedRun, agentId);
        const assignedRecipeIds = new Set(
            assignments.flatMap((assignment) => assignment.recipeIds ?? [])
        );
        const selections = manifest.recipes.filter((selection) => {
            const recipeId = this.recipeKey(selection);
            if (assignedRecipeIds.size > 0 && recipeId && assignedRecipeIds.has(recipeId)) {
                return true;
            }
            if (selection.role) {
                return roles.has(selection.role);
            }
            return assignedRecipeIds.size === 0;
        });

        return selections.length > 0
            ? selections
            : manifest.recipes.filter((selection) => !selection.role);
    }

    private rolesForAgent(
        distributedRun: StoredDistributedRun,
        agentId: string
    ): Set<string> {
        const manifest = distributedRun.manifest;
        const roles = new Set<string>();
        const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
        if (resolvedAssignments) {
            for (const assignment of resolvedAssignments) {
                if (assignment.agentId === agentId) {
                    roles.add(assignment.role);
                }
            }
            return roles;
        }

        for (const [role, agentIds] of Object.entries(manifest.targetPolicy.roles ?? {})) {
            if (agentIds.includes(agentId)) {
                roles.add(role);
            }
        }
        for (const assignment of manifest.roleAssignments ?? []) {
            if (assignment.agentId === agentId) {
                roles.add(assignment.role);
            }
        }
        return roles;
    }

    private roleAssignmentsForAgent(
        distributedRun: StoredDistributedRun,
        agentId: string
    ): readonly RallarBlackBoxDistributedRoleAssignment[] {
        const assignments = distributedRun.targetResolution?.roleAssignments ??
            distributedRun.manifest.roleAssignments ??
            [];
        return assignments.filter((assignment) => assignment.agentId === agentId);
    }

    private advanceDistributedRunOrchestration(distributedRun: StoredDistributedRun): void {
        if (isDistributedRunTerminalState(distributedRun.state)) {
            return;
        }

        if (distributedRun.state === 'waiting-for-ack') {
            if (this.distributedRunAckTimedOut(distributedRun)) {
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
            if (this.distributedRunBarrierTimedOut(distributedRun)) {
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

    private readyOrAutoStartDistributedRun(distributedRun: StoredDistributedRun): void {
        if (this.shouldAutoStartDistributedRun(distributedRun)) {
            this.queueDistributedStartCommands(distributedRun);
            return;
        }

        distributedRun.state = 'ready';
        distributedRun.updatedAtEpochMs = this.now();
    }

    private shouldAutoStartDistributedRun(distributedRun: StoredDistributedRun): boolean {
        if (distributedRun.manifest.startMode === 'auto-after-ready') {
            return true;
        }
        return distributedRun.manifest.startMode === 'scheduled' &&
            distributedRun.manifest.startDeadlineEpochMs !== undefined &&
            this.now() >= distributedRun.manifest.startDeadlineEpochMs;
    }

    private distributedRunScheduledStartPending(distributedRun: StoredDistributedRun): boolean {
        return distributedRun.manifest.startMode === 'scheduled' &&
            distributedRun.manifest.startDeadlineEpochMs !== undefined &&
            this.now() < distributedRun.manifest.startDeadlineEpochMs;
    }

    private distributedRunStartPrerequisitePending(distributedRun: StoredDistributedRun): boolean {
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

    private queueDistributedBarrierCommands(distributedRun: StoredDistributedRun): void {
        for (const agentId of distributedRun.targetAgentIds) {
            this.enqueueLinkedDistributedCommand(
                distributedRun,
                'barrier',
                agentId,
                undefined,
                this.barrierCommandForAgent(distributedRun, agentId)
            );
        }
    }

    private queueDistributedStartCommands(distributedRun: StoredDistributedRun): void {
        for (const agentId of distributedRun.targetAgentIds) {
            for (const selection of this.recipeSelectionsForAgent(distributedRun, agentId)) {
                this.enqueueLinkedDistributedCommand(
                    distributedRun,
                    'start',
                    agentId,
                    selection,
                    this.startCommandForSelection(distributedRun, agentId, selection)
                );
            }
        }

        distributedRun.state = 'running';
        distributedRun.startedAtEpochMs ??= this.now();
        distributedRun.updatedAtEpochMs = this.now();
    }

    private reconcileDistributedCommandLinks(distributedRun: StoredDistributedRun): void {
        const run = this.runs.get(distributedRun.controlRunId);
        if (!run || distributedRun.targetAgentIds.length === 0) {
            return;
        }

        for (const agentId of distributedRun.targetAgentIds) {
            for (const selection of this.recipeSelectionsForAgent(distributedRun, agentId)) {
                this.reconcileDistributedCommandLink(distributedRun, run, 'stage', agentId, selection);
                this.reconcileDistributedCommandLink(distributedRun, run, 'start', agentId, selection);
            }
            if (this.distributedRunBarrierEnabled(distributedRun)) {
                this.reconcileDistributedCommandLink(distributedRun, run, 'barrier', agentId, undefined);
            }
        }
    }

    private reconcileDistributedCommandLink(
        distributedRun: StoredDistributedRun,
        run: StoredRun,
        phase: ControlDistributedRunCommandPhase,
        agentId: string,
        selection: RallarBlackBoxDistributedRunRecipeSelection | undefined
    ): void {
        const recipeId = selection ? this.recipeKey(selection) : undefined;
        const commandId = phase === 'barrier'
            ? this.distributedCommandId(distributedRun, phase, agentId, 'ready')
            : this.distributedCommandId(
                distributedRun,
                phase,
                agentId,
                recipeId ?? 'recipe'
            );
        if (distributedRun.commandLinks.some((link) => link.commandId === commandId)) {
            return;
        }

        const command = run.commands.get(commandId);
        const result = run.results.get(commandId);
        if (!command && !result) {
            return;
        }

        const queuedAtEpochMs = command?.queuedAtEpochMs ??
            result?.result?.startedAtEpochMs ??
            result?.result?.endedAtEpochMs ??
            distributedRun.updatedAtEpochMs;
        distributedRun.commandLinks.push({
            phase,
            agentId,
            commandId,
            recipeId,
            role: selection?.role,
            queuedAtEpochMs
        });
        if (phase === 'start') {
            distributedRun.startedAtEpochMs ??= queuedAtEpochMs;
        }
        if (phase === 'barrier') {
            distributedRun.barrierStartedAtEpochMs ??= queuedAtEpochMs;
        }
        distributedRun.updatedAtEpochMs = this.now();
    }

    private allTargetPhaseCommandsSucceeded(
        distributedRun: StoredDistributedRun,
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

    private distributedRunBarrierEnabled(distributedRun: StoredDistributedRun): boolean {
        return distributedRun.manifest.barrier?.enabled === true;
    }

    private distributedRunBarrierTimeoutMs(distributedRun: StoredDistributedRun): number {
        const timeoutMs = distributedRun.manifest.barrier?.timeoutMs;
        return typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : distributedRun.manifest.ackTimeoutMs ?? DEFAULT_DISTRIBUTED_BARRIER_TIMEOUT_MS;
    }

    private stageCommandForSelection(
        distributedRun: StoredDistributedRun,
        agentId: string,
        selection: RallarBlackBoxDistributedRunRecipeSelection
    ): RallarBlackBoxTestCommand {
        const commandId = this.distributedCommandId(
            distributedRun,
            'stage',
            agentId,
            this.recipeKey(selection) ?? 'recipe'
        );
        if (selection.recipe) {
            return {
                kind: 'recipe.load',
                commandId,
                label: `Stage ${selection.recipe.recipeId}`,
                recipe: selection.recipe,
                metadata: this.distributedCommandMetadata(distributedRun, 'stage', agentId, selection)
            };
        }

        return {
            kind: 'health',
            commandId,
            label: `Preflight ${selection.recipeId ?? 'recipe reference'}`,
            metadata: {
                ...this.distributedCommandMetadata(distributedRun, 'stage', agentId, selection),
                recipeReferenceOnly: true
            }
        };
    }

    private startCommandForSelection(
        distributedRun: StoredDistributedRun,
        agentId: string,
        selection: RallarBlackBoxDistributedRunRecipeSelection
    ): RallarBlackBoxTestCommand {
        const commandId = this.distributedCommandId(
            distributedRun,
            'start',
            agentId,
            this.recipeKey(selection) ?? 'recipe'
        );
        return selection.recipe
            ? {
                kind: 'recipe.run',
                commandId,
                label: `Run ${selection.recipe.recipeId}`,
                recipe: selection.recipe,
                metadata: this.distributedCommandMetadata(distributedRun, 'start', agentId, selection)
            }
            : {
                kind: 'recipe.run',
                commandId,
                label: `Run ${selection.recipeId ?? 'loaded recipe'}`,
                metadata: this.distributedCommandMetadata(distributedRun, 'start', agentId, selection)
            };
    }

    private barrierCommandForAgent(
        distributedRun: StoredDistributedRun,
        agentId: string
    ): RallarBlackBoxTestCommand {
        const commandId = this.distributedCommandId(
            distributedRun,
            'barrier',
            agentId,
            'ready'
        );
        return {
            kind: 'health',
            commandId,
            label: `Barrier ready ${distributedRun.distributedRunId}`,
            metadata: {
                ...this.distributedCommandMetadata(distributedRun, 'barrier', agentId, undefined),
                barrier: {
                    event: 'barrier.ready',
                    expectedAgentIds: [...distributedRun.targetAgentIds],
                    timeoutMs: this.distributedRunBarrierTimeoutMs(distributedRun),
                    scheduledStartEpochMs: distributedRun.manifest.startMode === 'scheduled'
                        ? distributedRun.manifest.startDeadlineEpochMs
                        : undefined
                }
            }
        };
    }

    private enqueueLinkedDistributedCommand(
        distributedRun: StoredDistributedRun,
        phase: ControlDistributedRunCommandPhase,
        agentId: string,
        selection: RallarBlackBoxDistributedRunRecipeSelection | undefined,
        command: RallarBlackBoxTestCommand
    ): ControlCommandEnvelope {
        const recipeId = selection ? this.recipeKey(selection) : undefined;
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

    private distributedCommandMetadata(
        distributedRun: StoredDistributedRun,
        phase: ControlDistributedRunCommandPhase,
        agentId: string,
        selection: RallarBlackBoxDistributedRunRecipeSelection | undefined
    ): Readonly<Record<string, unknown>> {
        return {
            distributedRun: {
                distributedRunId: distributedRun.distributedRunId,
                controlRunId: distributedRun.controlRunId,
                phase,
                agentId,
                recipeId: selection ? this.recipeKey(selection) : undefined,
                role: selection?.role,
                profile: selection?.profile
            }
        };
    }

    private distributedCommandId(
        distributedRun: StoredDistributedRun,
        phase: ControlDistributedRunCommandPhase,
        agentId: string,
        recipeKey: string
    ): string {
        return [
            'distributed',
            safeCommandIdSegment(distributedRun.distributedRunId),
            phase,
            safeCommandIdSegment(agentId),
            safeCommandIdSegment(recipeKey)
        ].join('-');
    }

    private recipeKey(selection: RallarBlackBoxDistributedRunRecipeSelection): string | undefined {
        return cleanSegment(selection.recipeId) ??
            cleanSegment(selection.recipe?.recipeId) ??
            cleanSegment(selection.role) ??
            undefined;
    }

    private snapshotDistributedRunValue(
        distributedRun: StoredDistributedRun
    ): ControlDistributedRunSnapshot {
        const rollup = this.refreshDistributedRunState(distributedRun);
        return {
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
            manifest: distributedRun.manifest,
            state: distributedRun.state,
            createdAtEpochMs: distributedRun.createdAtEpochMs,
            updatedAtEpochMs: distributedRun.updatedAtEpochMs,
            stagedAtEpochMs: distributedRun.stagedAtEpochMs,
            barrierStartedAtEpochMs: distributedRun.barrierStartedAtEpochMs,
            barrierCompletedAtEpochMs: distributedRun.barrierCompletedAtEpochMs,
            startedAtEpochMs: distributedRun.startedAtEpochMs,
            cancelledAtEpochMs: distributedRun.cancelledAtEpochMs,
            completedAtEpochMs: distributedRun.completedAtEpochMs,
            targetAgentIds: [...distributedRun.targetAgentIds],
            targetResolution: distributedRun.targetResolution,
            commandLinks: [...distributedRun.commandLinks],
            rollup,
            error: distributedRun.error
        };
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
        distributedRun: StoredDistributedRun
    ): RallarBlackBoxDistributedRunRollup {
        if (isDistributedRunTerminalState(distributedRun.state) && distributedRun.rollup) {
            return distributedRun.rollup;
        }

        this.reconcileDistributedCommandLinks(distributedRun);
        this.advanceDistributedRunOrchestration(distributedRun);
        const evaluated = this.evaluateDistributedRun(distributedRun);
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

    private evaluateDistributedRun(
        distributedRun: StoredDistributedRun
    ): RallarBlackBoxDistributedRunRollup {
        const run = this.runs.get(distributedRun.controlRunId);
        const participants = distributedRun.targetAgentIds.map((agentId) =>
            this.distributedParticipantResult(distributedRun, run, agentId)
        );
        const recipes = distributedRun.commandLinks
            .filter((link) => link.phase === 'start')
            .map((link) =>
                toDistributedRecipeResult({
                    link,
                    dispatched: run?.commands.get(link.commandId)?.dispatchedAtEpochMs !== undefined,
                    result: run?.results.get(link.commandId)
                })
            );
        const groupAssertions = evaluateDistributedGroupAssertions({
            manifest: distributedRun.manifest,
            participants: toDistributedGroupAssertionParticipants(distributedRun.targetResolution),
            recipeResults: recipes,
            recipeEvidence: toDistributedGroupAssertionRecipeEvidence({
                commandLinks: distributedRun.commandLinks,
                resultByCommandId: run?.results ?? new Map()
            }),
            redaction: this.redaction
        });

        return rollupDistributedRunResult({
            stateHint: distributedRun.state,
            participants,
            recipes,
            groupAssertions
        });
    }

    private distributedParticipantResult(
        distributedRun: StoredDistributedRun,
        run: StoredRun | undefined,
        agentId: string
    ): RallarBlackBoxDistributedParticipantResult {
        const agent = run?.agents.get(agentId);
        const stageLinks = distributedRun.commandLinks
            .filter((link) => link.phase === 'stage' && link.agentId === agentId);
        const barrierLinks = distributedRun.commandLinks
            .filter((link) => link.phase === 'barrier' && link.agentId === agentId);
        const startLinks = distributedRun.commandLinks
            .filter((link) => link.phase === 'start' && link.agentId === agentId);
        const stageResults = stageLinks
            .map((link) => run?.results.get(link.commandId))
            .filter((result): result is ControlResultEnvelope => Boolean(result));
        const barrierResults = barrierLinks
            .map((link) => run?.results.get(link.commandId))
            .filter((result): result is ControlResultEnvelope => Boolean(result));
        const startResults = startLinks
            .map((link) => run?.results.get(link.commandId))
            .filter((result): result is ControlResultEnvelope => Boolean(result));
        const failedResult = [...stageResults, ...barrierResults, ...startResults].find((result) => !result.ok);
        const roles = Array.from(this.rolesForAgent(distributedRun, agentId));
        const ackTimedOut = this.distributedRunAckTimedOut(distributedRun);
        const barrierTimedOut = this.distributedRunBarrierTimedOut(distributedRun);

        if (failedResult) {
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'failed',
                ok: false,
                error: toDistributedRunResultError(failedResult)
            };
        }

        if (
            ackTimedOut &&
            startLinks.length === 0 &&
            (stageLinks.length === 0 || stageResults.length < stageLinks.length)
        ) {
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'timed-out',
                ok: false,
                error: {
                    code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
                    message: `Agent ${agentId} did not ACK distributed-run staging before ackTimeoutMs.`,
                    details: {
                        ackTimeoutMs: distributedRun.manifest.ackTimeoutMs,
                        stagedAtEpochMs: distributedRun.stagedAtEpochMs
                    }
                }
            };
        }

        if (
            barrierTimedOut &&
            startLinks.length === 0 &&
            barrierLinks.length > 0 &&
            barrierResults.length < barrierLinks.length
        ) {
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'timed-out',
                ok: false,
                error: {
                    code: 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT',
                    message: `Agent ${agentId} did not report barrier.ready before barrier timeout.`,
                    details: {
                        barrierTimeoutMs: this.distributedRunBarrierTimeoutMs(distributedRun),
                        barrierStartedAtEpochMs: distributedRun.barrierStartedAtEpochMs
                    }
                }
            };
        }

        if (startLinks.length > 0) {
            if (startResults.length === startLinks.length) {
                return {
                    agentId,
                    clientId: agent?.identity?.clientId,
                    sessionId: agent?.identity?.sessionId,
                    roles,
                    state: 'passed',
                    ok: true,
                    startedAtEpochMs: resolveFirstStartedAtEpochMs(startResults),
                    endedAtEpochMs: resolveLastEndedAtEpochMs(startResults)
                };
            }
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'running'
            };
        }

        if (barrierLinks.length > 0) {
            if (barrierResults.length === barrierLinks.length) {
                return {
                    agentId,
                    clientId: agent?.identity?.clientId,
                    sessionId: agent?.identity?.sessionId,
                    roles,
                    state: 'ready',
                    ok: true,
                    acknowledgedAtEpochMs: resolveLastEndedAtEpochMs([...stageResults, ...barrierResults])
                };
            }
            if (agent && !agent.connected) {
                return {
                    agentId,
                    clientId: agent.identity?.clientId,
                    sessionId: agent.identity?.sessionId,
                    roles,
                    state: 'disconnected',
                    ok: false,
                    error: {
                        code: 'RALLAR_BB_DISTRIBUTED_BARRIER_DISCONNECTED',
                        message: `Agent ${agentId} disconnected while waiting at the distributed barrier.`
                    }
                };
            }
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'acknowledged',
                acknowledgedAtEpochMs: resolveLastEndedAtEpochMs(stageResults)
            };
        }

        if (stageLinks.length > 0 && stageResults.length === stageLinks.length) {
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'ready',
                ok: true,
                acknowledgedAtEpochMs: resolveLastEndedAtEpochMs(stageResults)
            };
        }

        if (stageResults.length > 0) {
            return {
                agentId,
                clientId: agent?.identity?.clientId,
                sessionId: agent?.identity?.sessionId,
                roles,
                state: 'acknowledged'
            };
        }

        return {
            agentId,
            clientId: agent?.identity?.clientId,
            sessionId: agent?.identity?.sessionId,
            roles,
            state: agent && !agent.connected ? 'disconnected' : 'targeted'
        };
    }

    private distributedRunAckTimedOut(distributedRun: StoredDistributedRun): boolean {
        return (distributedRun.state === 'waiting-for-ack' || distributedRun.state === 'timed-out') &&
            distributedRun.stagedAtEpochMs !== undefined &&
            distributedRun.manifest.ackTimeoutMs !== undefined &&
            this.now() > distributedRun.stagedAtEpochMs + distributedRun.manifest.ackTimeoutMs;
    }

    private distributedRunBarrierTimedOut(distributedRun: StoredDistributedRun): boolean {
        return (distributedRun.state === 'waiting-for-barrier' ||
            distributedRun.state === 'timed-out') &&
            distributedRun.barrierStartedAtEpochMs !== undefined &&
            this.now() >
                distributedRun.barrierStartedAtEpochMs +
                    this.distributedRunBarrierTimeoutMs(distributedRun);
    }

    private ensureRun(runId: string): StoredRun {
        const existing = this.runs.get(runId);
        if (existing) {
            return existing;
        }

        const now = this.now();
        const run: StoredRun = {
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

    private ensureAgent(run: StoredRun, agentId: string): StoredAgent {
        const existing = run.agents.get(agentId);
        if (existing) {
            return existing;
        }

        const agent: StoredAgent = {
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

    private touch(run: StoredRun): void {
        run.retentionRevision += 1;
        run.updatedAtEpochMs = this.now();
    }

    private passiveDistributedRunSnapshotValue(
        distributedRun: StoredDistributedRun
    ): ControlDistributedRunSnapshot {
        return {
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
            manifest: distributedRun.manifest,
            state: distributedRun.state,
            createdAtEpochMs: distributedRun.createdAtEpochMs,
            updatedAtEpochMs: distributedRun.updatedAtEpochMs,
            stagedAtEpochMs: distributedRun.stagedAtEpochMs,
            barrierStartedAtEpochMs: distributedRun.barrierStartedAtEpochMs,
            barrierCompletedAtEpochMs: distributedRun.barrierCompletedAtEpochMs,
            startedAtEpochMs: distributedRun.startedAtEpochMs,
            cancelledAtEpochMs: distributedRun.cancelledAtEpochMs,
            completedAtEpochMs: distributedRun.completedAtEpochMs,
            targetAgentIds: [...distributedRun.targetAgentIds],
            targetResolution: distributedRun.targetResolution,
            commandLinks: [...distributedRun.commandLinks],
            rollup: distributedRun.rollup ?? rollupDistributedRunResult({
                stateHint: distributedRun.state
            }),
            error: distributedRun.error
        };
    }

    private boundedTail<T>(values: readonly T[], limit: number | undefined): readonly T[] {
        if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
            return values;
        }

        return values.slice(Math.max(0, values.length - Math.floor(limit)));
    }

    private snapshotCommandValue(command: StoredCommand): ControlQueuedCommandSnapshot {
        return {
            envelope: command.envelope,
            queuedAtEpochMs: command.queuedAtEpochMs,
            dispatchedAtEpochMs: command.dispatchedAtEpochMs,
            completedAtEpochMs: command.completedAtEpochMs,
            dispatchCount: command.dispatchCount
        };
    }

    private snapshotRunValue(
        run: StoredRun,
        bounds: ControlRunSnapshotBounds = {}
    ): ControlRunSnapshot {
        const commands = Array.from(
            run.commands.values(),
            (command) => this.snapshotCommandValue(command)
        );
        const results = Array.from(run.results.values());
        return {
            runId: run.runId,
            createdAtEpochMs: run.createdAtEpochMs,
            updatedAtEpochMs: run.updatedAtEpochMs,
            agents: Array.from(run.agents.values(), (agent) => ({
                runId: agent.runId,
                agentId: agent.agentId,
                connected: agent.connected,
                registeredAtEpochMs: agent.registeredAtEpochMs,
                disconnectedAtEpochMs: agent.disconnectedAtEpochMs,
                lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
                lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
                status: agent.status,
                identity: agent.identity,
                connectionSequence: agent.connectionSequence,
                reconnectCount: agent.reconnectCount,
                receivedResultCount: agent.receivedResultCount,
                receivedEventCount: agent.receivedEventCount,
                completedCommandIds: Array.from(agent.completedCommandIds),
                resumeCompletedCommandIds: Array.from(agent.resumeCompletedCommandIds)
            })),
            commands: this.boundedTail(commands, bounds.commands),
            results: this.boundedTail(results, bounds.results),
            events: this.boundedTail(run.events, bounds.events),
            stats: this.boundedTail(run.stats, bounds.stats),
            reports: this.boundedTail(run.reports, bounds.reports),
            heartbeats: this.boundedTail(run.heartbeats, bounds.heartbeats)
        };
    }
}

export function createRallarBlackBoxControlService(
    options: RallarBlackBoxControlServiceOptions = {}
): RallarBlackBoxControlService {
    return new RallarBlackBoxControlService(options);
}

function compactReportPayload(payload: unknown): unknown {
    if (!isRecord(payload)) {
        return payload;
    }

    const compactedPayload = compactReportValue(payload);
    if (!isRecord(compactedPayload) || !isRecord(compactedPayload.payload)) {
        return compactedPayload;
    }

    const nestedPayload = compactReportValue(compactedPayload.payload);
    return nestedPayload === compactedPayload.payload ? compactedPayload : {
        ...compactedPayload,
        payload: nestedPayload
    };
}

function compactReportValue(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }

    const resultCount = Array.isArray(value.results) ? value.results.length : undefined;
    const eventCount = Array.isArray(value.events) ? value.events.length : undefined;
    if (resultCount === undefined && eventCount === undefined) {
        return value;
    }

    const { results: _results, events: _events, ...rest } = value;
    const summary = isRecord(rest.summary) ? rest.summary : {};
    return {
        ...rest,
        summary: {
            ...summary,
            ...(resultCount === undefined ? {} : { omittedResultCount: resultCount }),
            ...(eventCount === undefined ? {} : { omittedEventCount: eventCount })
        }
    };
}

function compactResultEnvelope(envelope: ControlResultEnvelope): ControlResultEnvelope {
    const result = envelope.result;
    if (!result || !isRecord(result.value) || !Array.isArray(result.value.results)) {
        return envelope;
    }

    return {
        ...envelope,
        result: {
            ...result,
            value: compactRecipeRunValue(result.value)
        }
    };
}

function compactRecipeRunValue(value: Record<string, unknown>): Record<string, unknown> {
    const childResults = Array.isArray(value.results) ? value.results : [];
    const failedChildren = childResults.filter(isFailedCompositeChild);
    const failures = failedChildren.slice(0, 20).map(compactChildFailure);
    const { results: _results, ...rest } = value;
    return {
        ...rest,
        resultCount: childResults.length,
        failureCount: failedChildren.length,
        ...(failures.length > 0 ? { failures } : {}),
        resultsOmitted: true
    };
}

function isFailedCompositeChild(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (value.ok === false) {
        return true;
    }
    return isRecord(value.result) && value.result.ok === false;
}

function compactChildFailure(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        return { value };
    }
    const result = isRecord(value.result) ? value.result : undefined;
    const error = isRecord(value.error)
        ? value.error
        : result && isRecord(result.error)
        ? result.error
        : undefined;
    return {
        commandId: value.commandId ?? result?.commandId,
        kind: value.kind ?? result?.kind,
        status: value.status ?? result?.status,
        ok: value.ok ?? result?.ok,
        error: error
            ? {
                code: error.code,
                message: error.message
            }
            : undefined
    };
}

function resultCommandKey(runId: string, commandId: string): string {
    return `${runId} ${commandId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanSegment(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function countStrings(values: readonly unknown[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            continue;
        }
        const key = value.trim();
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
    );
}

function safeCommandIdSegment(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') ||
        'segment';
}
