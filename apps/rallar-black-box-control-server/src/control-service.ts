import type {
  ControlClientEnvelope,
  ControlCommandEnvelope,
  ControlEventEnvelope,
  ControlHeartbeatEnvelope,
  ControlRegisterEnvelope,
  ControlResultEnvelope,
} from '../../rallar-black-box/src/control-protocol.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '../../rallar-black-box/src/control-protocol.ts';
import type {
  RallarBlackBoxTestCommand,
  RallarBlackBoxTestCommandKind,
  RallarBlackBoxTestRedactionOptions,
} from '@shared-test/rallar-bb-test/types.ts';
import {
  isDistributedRunTerminalState,
  type RallarBlackBoxControlAgentIdentity,
  type RallarBlackBoxDistributedParticipantResult,
  type RallarBlackBoxDistributedRecipeResult,
  type RallarBlackBoxDistributedRunManifest,
  type RallarBlackBoxDistributedRunRecipeSelection,
  type RallarBlackBoxDistributedRunRollup,
  type RallarBlackBoxDistributedRunState,
  rollupDistributedRunResult,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import {
  type ControlDistributedRunArtifactBundle,
  createControlDistributedRunArtifactBundle,
} from './control-artifacts.ts';
import {
  createControlFleetAggregateReport,
  createControlFleetReportBundle,
  createControlFleetRunReport,
  filterControlFleetReports,
} from './control-fleet.ts';
import type {
  ControlFleetReportBundle,
  ControlFleetReportsResponse,
  ControlFleetRunReport,
} from '@shared-test/rallar-bb-test/fleet-report.ts';

const DEFAULT_DISTRIBUTED_BARRIER_TIMEOUT_MS = 15_000;

export type EnqueueControlCommandInput = Readonly<{
  runId: string;
  agentId: string;
  commandId?: string;
  command: RallarBlackBoxTestCommand;
  deadlineEpochMs?: number;
}>;

export type ControlRunSnapshotBounds = Readonly<{
  commands?: number;
  results?: number;
  events?: number;
  stats?: number;
  reports?: number;
  heartbeats?: number;
}>;

export type RallarBlackBoxControlServiceOptions = Readonly<{
  now?: () => number;
  commandIdFactory?: () => string;
  redaction?: RallarBlackBoxTestRedactionOptions;
  allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
  commandRateLimitMax?: number;
  commandRateLimitWindowMs?: number;
  runTokenTtlMs?: number;
}>;

export type ControlRunToken = Readonly<{
  runId: string;
  agentId: string;
  token: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs: number;
}>;

export type ControlDistributedRunCommandPhase = 'stage' | 'barrier' | 'start' | 'cancel';

export type ControlDistributedRunCommandLink = Readonly<{
  phase: ControlDistributedRunCommandPhase;
  agentId: string;
  commandId: string;
  recipeId?: string;
  role?: string;
  queuedAtEpochMs: number;
}>;

export type ControlDistributedRunSnapshot = Readonly<{
  distributedRunId: string;
  controlRunId: string;
  manifest: RallarBlackBoxDistributedRunManifest;
  state: RallarBlackBoxDistributedRunState;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  stagedAtEpochMs?: number;
  barrierStartedAtEpochMs?: number;
  barrierCompletedAtEpochMs?: number;
  startedAtEpochMs?: number;
  cancelledAtEpochMs?: number;
  completedAtEpochMs?: number;
  targetAgentIds: readonly string[];
  commandLinks: readonly ControlDistributedRunCommandLink[];
  rollup: RallarBlackBoxDistributedRunRollup;
  error?: Readonly<{
    code: string;
    message: string;
    details?: unknown;
  }>;
}>;

export type RallarBlackBoxControlServiceReceiveResult = Readonly<{
  kind: ControlClientEnvelope['kind'];
  runId: string;
  agentId: string;
}>;

export type ControlQueuedCommandSnapshot = Readonly<{
  envelope: ControlCommandEnvelope;
  queuedAtEpochMs: number;
  dispatchedAtEpochMs?: number;
  completedAtEpochMs?: number;
  dispatchCount: number;
}>;

export type ControlAgentSnapshot = Readonly<{
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
  completedCommandIds: readonly string[];
  resumeCompletedCommandIds: readonly string[];
}>;

export type ControlRunSnapshot = Readonly<{
  runId: string;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  agents: readonly ControlAgentSnapshot[];
  commands: readonly ControlQueuedCommandSnapshot[];
  results: readonly ControlResultEnvelope[];
  events: readonly ControlEventEnvelope[];
  stats: readonly ControlEventEnvelope[];
  reports: readonly ControlEventEnvelope[];
  heartbeats: readonly ControlHeartbeatEnvelope[];
}>;

export type ControlServerSnapshot = Readonly<{
  runs: readonly ControlRunSnapshot[];
  distributedRuns?: readonly ControlDistributedRunSnapshot[];
  fleetReports?: readonly ControlFleetRunReport[];
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
  heartbeats: ControlHeartbeatEnvelope[];
  tokens: Map<string, StoredToken>;
};

type StoredDistributedRun = {
  distributedRunId: string;
  controlRunId: string;
  manifest: RallarBlackBoxDistributedRunManifest;
  state: RallarBlackBoxDistributedRunState;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  stagedAtEpochMs?: number;
  barrierStartedAtEpochMs?: number;
  barrierCompletedAtEpochMs?: number;
  startedAtEpochMs?: number;
  cancelledAtEpochMs?: number;
  completedAtEpochMs?: number;
  targetAgentIds: string[];
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
  }

  receiveClientEnvelope(
    envelope: ControlClientEnvelope,
  ): RallarBlackBoxControlServiceReceiveResult {
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
        this.receiveEvent(envelope);
        break;
    }

    return {
      kind: envelope.kind,
      runId: envelope.runId,
      agentId: envelope.agentId,
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
      deadlineEpochMs: input.deadlineEpochMs,
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
      dispatchCount: 0,
    });
    this.touch(run);
    return envelope;
  }

  issueRunToken(
    input: Readonly<{
      runId: string;
      agentId: string;
      ttlMs?: number;
    }>,
  ): ControlRunToken {
    const run = this.ensureRun(input.runId);
    this.ensureAgent(run, input.agentId);
    const issuedAtEpochMs = this.now();
    const token: StoredToken = {
      runId: input.runId,
      agentId: input.agentId,
      token: crypto.randomUUID(),
      issuedAtEpochMs,
      expiresAtEpochMs: issuedAtEpochMs + Math.max(1, input.ttlMs ?? this.runTokenTtlMs),
    };
    run.tokens.set(token.token, token);
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
    token: string | undefined,
  ): boolean {
    if (!token) {
      return false;
    }

    const stored = this.runs.get(runId)?.tokens.get(token);
    return Boolean(
      stored &&
        stored.agentId === agentId &&
        stored.expiresAtEpochMs > this.now(),
    );
  }

  createDistributedRun(
    manifest: RallarBlackBoxDistributedRunManifest,
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
        controlRunId,
      },
      state: 'draft',
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
      targetAgentIds: [],
      commandLinks: [],
    };
    stored.targetAgentIds = this.resolveDistributedTargetAgentIds(stored);
    this.distributedRuns.set(stored.distributedRunId, stored);
    return this.snapshotDistributedRunValue(stored);
  }

  listDistributedRuns(): readonly ControlDistributedRunSnapshot[] {
    return Array.from(
      this.distributedRuns.values(),
      (distributedRun) => this.snapshotDistributedRunValue(distributedRun),
    );
  }

  snapshotDistributedRun(
    distributedRunId: string,
  ): ControlDistributedRunSnapshot | undefined {
    const distributedRun = this.distributedRuns.get(distributedRunId);
    return distributedRun ? this.snapshotDistributedRunValue(distributedRun) : undefined;
  }

  stageDistributedRun(distributedRunId: string): ControlDistributedRunSnapshot {
    const distributedRun = this.requireDistributedRun(distributedRunId);
    this.assertDistributedRunCanMutate(distributedRun, 'stage');
    distributedRun.targetAgentIds = this.resolveDistributedTargetAgentIds(distributedRun);
    distributedRun.updatedAtEpochMs = this.now();

    if (distributedRun.targetAgentIds.length === 0) {
      distributedRun.state = 'failed';
      distributedRun.completedAtEpochMs = this.now();
      distributedRun.error = {
        code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
        message: 'No target control agents were resolved for this distributed run.',
        details: {
          targetPolicy: distributedRun.manifest.targetPolicy,
          group: distributedRun.manifest.group,
        },
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
          expectedParticipantCount,
        },
      };
      return this.snapshotDistributedRunValue(distributedRun);
    }

    for (const agentId of distributedRun.targetAgentIds) {
      for (const selection of this.recipeSelectionsForAgent(distributedRun.manifest, agentId)) {
        this.enqueueLinkedDistributedCommand(
          distributedRun,
          'stage',
          agentId,
          selection,
          this.stageCommandForSelection(distributedRun, agentId, selection),
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
      distributedRun.targetAgentIds = this.resolveDistributedTargetAgentIds(distributedRun);
    }
    if (distributedRun.targetAgentIds.length === 0) {
      distributedRun.state = 'failed';
      distributedRun.completedAtEpochMs = this.now();
      distributedRun.error = {
        code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
        message: 'No target control agents were resolved for this distributed run.',
        details: {
          targetPolicy: distributedRun.manifest.targetPolicy,
          group: distributedRun.manifest.group,
        },
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
          expectedParticipantCount,
        },
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
    reason = 'Distributed run cancelled.',
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
            undefined,
          ),
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
  ): ControlDistributedRunArtifactBundle | undefined {
    const distributedRun = this.distributedRuns.get(distributedRunId);
    if (!distributedRun) {
      return undefined;
    }

    const snapshot = this.snapshotDistributedRunValue(distributedRun);
    const controlRun = this.snapshotRun(distributedRun.controlRunId);
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
      aggregate: createControlFleetAggregateReport(reports, this.now()),
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
        .map((run) => run.runId),
    );
    const deletedRunIds: string[] = [];
    for (const runId of this.runs.keys()) {
      if (keep.has(runId)) {
        continue;
      }
      this.runs.delete(runId);
      deletedRunIds.push(runId);
    }
    for (const [distributedRunId, distributedRun] of this.distributedRuns.entries()) {
      if (deletedRunIds.includes(distributedRun.controlRunId)) {
        this.distributedRuns.delete(distributedRunId);
        this.fleetReports.delete(distributedRunId);
      }
    }
    return deletedRunIds;
  }

  restoreSnapshot(snapshot: ControlServerSnapshot): void {
    this.runs.clear();
    this.distributedRuns.clear();
    this.fleetReports.clear();
    for (const runSnapshot of snapshot.runs) {
      const run: StoredRun = {
        runId: runSnapshot.runId,
        createdAtEpochMs: runSnapshot.createdAtEpochMs,
        updatedAtEpochMs: runSnapshot.updatedAtEpochMs,
        agents: new Map(),
        commands: new Map(),
        results: new Map(),
        events: [...runSnapshot.events],
        stats: [...runSnapshot.stats],
        reports: [...runSnapshot.reports],
        heartbeats: [...runSnapshot.heartbeats],
        tokens: new Map(),
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
          commandEnqueueTimestamps: [],
        });
      }
      for (const commandSnapshot of runSnapshot.commands) {
        run.commands.set(commandSnapshot.envelope.commandId, {
          envelope: commandSnapshot.envelope,
          fingerprint: this.commandFingerprint(commandSnapshot.envelope),
          queuedAtEpochMs: commandSnapshot.queuedAtEpochMs,
          dispatchedAtEpochMs: commandSnapshot.dispatchedAtEpochMs,
          completedAtEpochMs: commandSnapshot.completedAtEpochMs,
          dispatchCount: commandSnapshot.dispatchCount,
        });
      }
      for (const result of runSnapshot.results) {
        run.results.set(result.commandId, result);
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
        commandLinks: [...distributedRunSnapshot.commandLinks],
        error: distributedRunSnapshot.error,
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
      fleetReports: this.listFleetReports().reports,
    };
  }

  snapshotRun(
    runId: string,
    bounds: ControlRunSnapshotBounds = {},
  ): ControlRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.snapshotRunValue(run, bounds) : undefined;
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
    this.refreshDistributedRunsForControlRun(run.runId);
  }

  private receiveResult(envelope: ControlResultEnvelope): void {
    const run = this.ensureRun(envelope.runId);
    const agent = this.ensureAgent(run, envelope.agentId);
    agent.receivedResultCount += 1;
    agent.lastSeenAtEpochMs = this.now();
    agent.completedCommandIds.add(envelope.commandId);
    agent.resumeCompletedCommandIds.delete(envelope.commandId);
    run.results.set(envelope.commandId, envelope);

    const command = run.commands.get(envelope.commandId);
    if (command) {
      command.completedAtEpochMs = this.now();
    }
    this.touch(run);
    this.refreshDistributedRunsForControlRun(run.runId);
  }

  private receiveEvent(envelope: ControlEventEnvelope): void {
    const run = this.ensureRun(envelope.runId);
    const agent = this.ensureAgent(run, envelope.agentId);
    const storedEnvelope = envelope.kind === 'report'
      ? this.redactReportEnvelope(envelope)
      : envelope;
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
  }

  private redactReportEnvelope(envelope: ControlEventEnvelope): ControlEventEnvelope {
    return {
      ...envelope,
      payload: redactRallarBlackBoxValue(envelope.payload, this.redaction),
    };
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
      deadlineEpochMs: envelope.deadlineEpochMs,
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
    action: ControlDistributedRunCommandPhase,
  ): void {
    if (!isDistributedRunTerminalState(distributedRun.state)) {
      return;
    }

    throw new Error(
      `Cannot ${action} distributed run ${distributedRun.distributedRunId} in terminal state ${distributedRun.state}.`,
    );
  }

  private resolveDistributedTargetAgentIds(distributedRun: StoredDistributedRun): string[] {
    const policy = distributedRun.manifest.targetPolicy;
    const unique = (values: readonly string[]) => [
      ...new Set(
        values.map(cleanSegment).filter((value): value is string => Boolean(value)),
      ),
    ];

    if (policy.mode === 'selected-agents') {
      return unique(policy.agentIds ?? []);
    }

    if (policy.mode === 'role-map') {
      return unique([
        ...Object.values(policy.roles ?? {}).flat(),
        ...(distributedRun.manifest.roleAssignments ?? []).map((assignment) => assignment.agentId),
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
    manifest: RallarBlackBoxDistributedRunManifest,
  ): boolean {
    return identity?.applicationId === manifest.group.applicationId &&
      identity.workspaceId === manifest.group.workspaceId &&
      identity.groupId === manifest.group.groupId;
  }

  private recipeSelectionsForAgent(
    manifest: RallarBlackBoxDistributedRunManifest,
    agentId: string,
  ): readonly RallarBlackBoxDistributedRunRecipeSelection[] {
    const roles = this.rolesForAgent(manifest, agentId);
    const assignments = (manifest.roleAssignments ?? [])
      .filter((assignment) => assignment.agentId === agentId);
    const assignedRecipeIds = new Set(
      assignments.flatMap((assignment) => assignment.recipeIds ?? []),
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
    manifest: RallarBlackBoxDistributedRunManifest,
    agentId: string,
  ): Set<string> {
    const roles = new Set<string>();
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
        this.barrierCommandForAgent(distributedRun, agentId),
      );
    }
  }

  private queueDistributedStartCommands(distributedRun: StoredDistributedRun): void {
    for (const agentId of distributedRun.targetAgentIds) {
      for (const selection of this.recipeSelectionsForAgent(distributedRun.manifest, agentId)) {
        this.enqueueLinkedDistributedCommand(
          distributedRun,
          'start',
          agentId,
          selection,
          this.startCommandForSelection(distributedRun, agentId, selection),
        );
      }
    }

    distributedRun.state = 'running';
    distributedRun.startedAtEpochMs ??= this.now();
    distributedRun.updatedAtEpochMs = this.now();
  }

  private allTargetPhaseCommandsSucceeded(
    distributedRun: StoredDistributedRun,
    phase: ControlDistributedRunCommandPhase,
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
    selection: RallarBlackBoxDistributedRunRecipeSelection,
  ): RallarBlackBoxTestCommand {
    const commandId = this.distributedCommandId(
      distributedRun,
      'stage',
      agentId,
      this.recipeKey(selection) ?? 'recipe',
    );
    if (selection.recipe) {
      return {
        kind: 'recipe.load',
        commandId,
        label: `Stage ${selection.recipe.recipeId}`,
        recipe: selection.recipe,
        metadata: this.distributedCommandMetadata(distributedRun, 'stage', agentId, selection),
      };
    }

    return {
      kind: 'health',
      commandId,
      label: `Preflight ${selection.recipeId ?? 'recipe reference'}`,
      metadata: {
        ...this.distributedCommandMetadata(distributedRun, 'stage', agentId, selection),
        recipeReferenceOnly: true,
      },
    };
  }

  private startCommandForSelection(
    distributedRun: StoredDistributedRun,
    agentId: string,
    selection: RallarBlackBoxDistributedRunRecipeSelection,
  ): RallarBlackBoxTestCommand {
    const commandId = this.distributedCommandId(
      distributedRun,
      'start',
      agentId,
      this.recipeKey(selection) ?? 'recipe',
    );
    return selection.recipe
      ? {
        kind: 'recipe.run',
        commandId,
        label: `Run ${selection.recipe.recipeId}`,
        recipe: selection.recipe,
        metadata: this.distributedCommandMetadata(distributedRun, 'start', agentId, selection),
      }
      : {
        kind: 'recipe.run',
        commandId,
        label: `Run ${selection.recipeId ?? 'loaded recipe'}`,
        metadata: this.distributedCommandMetadata(distributedRun, 'start', agentId, selection),
      };
  }

  private barrierCommandForAgent(
    distributedRun: StoredDistributedRun,
    agentId: string,
  ): RallarBlackBoxTestCommand {
    const commandId = this.distributedCommandId(
      distributedRun,
      'barrier',
      agentId,
      'ready',
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
            : undefined,
        },
      },
    };
  }

  private enqueueLinkedDistributedCommand(
    distributedRun: StoredDistributedRun,
    phase: ControlDistributedRunCommandPhase,
    agentId: string,
    selection: RallarBlackBoxDistributedRunRecipeSelection | undefined,
    command: RallarBlackBoxTestCommand,
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
      deadlineEpochMs: phase === 'start' ? distributedRun.manifest.startDeadlineEpochMs : undefined,
    });
    distributedRun.commandLinks.push({
      phase,
      agentId,
      commandId: envelope.commandId,
      recipeId,
      role: selection?.role,
      queuedAtEpochMs: this.now(),
    });
    distributedRun.updatedAtEpochMs = this.now();
    return envelope;
  }

  private distributedCommandMetadata(
    distributedRun: StoredDistributedRun,
    phase: ControlDistributedRunCommandPhase,
    agentId: string,
    selection: RallarBlackBoxDistributedRunRecipeSelection | undefined,
  ): Readonly<Record<string, unknown>> {
    return {
      distributedRun: {
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        phase,
        agentId,
        recipeId: selection ? this.recipeKey(selection) : undefined,
        role: selection?.role,
        profile: selection?.profile,
      },
    };
  }

  private distributedCommandId(
    distributedRun: StoredDistributedRun,
    phase: ControlDistributedRunCommandPhase,
    agentId: string,
    recipeKey: string,
  ): string {
    return [
      'distributed',
      safeCommandIdSegment(distributedRun.distributedRunId),
      phase,
      safeCommandIdSegment(agentId),
      safeCommandIdSegment(recipeKey),
    ].join('-');
  }

  private recipeKey(selection: RallarBlackBoxDistributedRunRecipeSelection): string | undefined {
    return cleanSegment(selection.recipeId) ??
      cleanSegment(selection.recipe?.recipeId) ??
      cleanSegment(selection.role) ??
      undefined;
  }

  private snapshotDistributedRunValue(
    distributedRun: StoredDistributedRun,
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
      commandLinks: [...distributedRun.commandLinks],
      rollup,
      error: distributedRun.error,
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
      redaction: this.redaction,
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
    distributedRun: StoredDistributedRun,
  ): RallarBlackBoxDistributedRunRollup {
    this.advanceDistributedRunOrchestration(distributedRun);
    const evaluated = this.evaluateDistributedRun(distributedRun);
    if (evaluated.state !== distributedRun.state) {
      distributedRun.state = evaluated.state;
      distributedRun.updatedAtEpochMs = this.now();
      if (isDistributedRunTerminalState(evaluated.state)) {
        distributedRun.completedAtEpochMs ??= this.now();
      }
    }
    return evaluated;
  }

  private evaluateDistributedRun(
    distributedRun: StoredDistributedRun,
  ): RallarBlackBoxDistributedRunRollup {
    const run = this.runs.get(distributedRun.controlRunId);
    const participants = distributedRun.targetAgentIds.map((agentId) =>
      this.distributedParticipantResult(distributedRun, run, agentId)
    );
    const recipes = distributedRun.commandLinks
      .filter((link) => link.phase === 'start')
      .map((link) => this.distributedRecipeResult(distributedRun, run, link));

    return rollupDistributedRunResult({
      stateHint: distributedRun.state,
      participants,
      recipes,
    });
  }

  private distributedParticipantResult(
    distributedRun: StoredDistributedRun,
    run: StoredRun | undefined,
    agentId: string,
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
    const failedResult = [...stageResults, ...barrierResults, ...startResults].find((result) =>
      !result.ok
    );
    const roles = Array.from(this.rolesForAgent(distributedRun.manifest, agentId));
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
        error: this.resultError(failedResult),
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
            stagedAtEpochMs: distributedRun.stagedAtEpochMs,
          },
        },
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
            barrierStartedAtEpochMs: distributedRun.barrierStartedAtEpochMs,
          },
        },
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
          startedAtEpochMs: this.firstStartedAt(startResults),
          endedAtEpochMs: this.lastEndedAt(startResults),
        };
      }
      return {
        agentId,
        clientId: agent?.identity?.clientId,
        sessionId: agent?.identity?.sessionId,
        roles,
        state: 'running',
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
          acknowledgedAtEpochMs: this.lastEndedAt([...stageResults, ...barrierResults]),
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
            message: `Agent ${agentId} disconnected while waiting at the distributed barrier.`,
          },
        };
      }
      return {
        agentId,
        clientId: agent?.identity?.clientId,
        sessionId: agent?.identity?.sessionId,
        roles,
        state: 'acknowledged',
        acknowledgedAtEpochMs: this.lastEndedAt(stageResults),
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
        acknowledgedAtEpochMs: this.lastEndedAt(stageResults),
      };
    }

    if (stageResults.length > 0) {
      return {
        agentId,
        clientId: agent?.identity?.clientId,
        sessionId: agent?.identity?.sessionId,
        roles,
        state: 'acknowledged',
      };
    }

    return {
      agentId,
      clientId: agent?.identity?.clientId,
      sessionId: agent?.identity?.sessionId,
      roles,
      state: agent && !agent.connected ? 'disconnected' : 'targeted',
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

  private distributedRecipeResult(
    _distributedRun: StoredDistributedRun,
    run: StoredRun | undefined,
    link: ControlDistributedRunCommandLink,
  ): RallarBlackBoxDistributedRecipeResult {
    const command = run?.commands.get(link.commandId);
    const result = run?.results.get(link.commandId);
    const recipeKey = [
      link.agentId,
      link.recipeId ?? link.role ?? link.commandId,
    ].join(':');

    if (!result) {
      return {
        recipeKey,
        recipeId: link.recipeId,
        agentId: link.agentId,
        role: link.role,
        state: command?.dispatchedAtEpochMs ? 'running' : 'pending',
      };
    }

    return {
      recipeKey,
      recipeId: link.recipeId,
      agentId: link.agentId,
      role: link.role,
      state: result.ok ? 'passed' : 'failed',
      ok: result.ok,
      commandResultCount: this.nestedRecipeResultCount(result),
      failureCount: result.ok ? 0 : 1,
      startedAtEpochMs: result.result?.startedAtEpochMs,
      endedAtEpochMs: result.result?.endedAtEpochMs,
      error: result.ok ? undefined : this.resultError(result),
    };
  }

  private resultError(result: ControlResultEnvelope): Readonly<{
    code: string;
    message: string;
    details?: unknown;
  }> {
    return result.error ?? result.result?.error ?? {
      code: 'RALLAR_BB_DISTRIBUTED_COMMAND_FAILED',
      message: `Distributed command ${result.commandId} failed.`,
    };
  }

  private nestedRecipeResultCount(result: ControlResultEnvelope): number {
    const value = result.result?.value;
    if (
      value && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results)
    ) {
      return (value as { results: readonly unknown[] }).results.length;
    }
    return result.result ? 1 : 0;
  }

  private firstStartedAt(results: readonly ControlResultEnvelope[]): number | undefined {
    return results
      .map((result) => result.result?.startedAtEpochMs)
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => left - right)[0];
  }

  private lastEndedAt(results: readonly ControlResultEnvelope[]): number | undefined {
    return results
      .map((result) => result.result?.endedAtEpochMs)
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => right - left)[0];
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
      heartbeats: [],
      tokens: new Map(),
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
      commandEnqueueTimestamps: [],
    };
    run.agents.set(agentId, agent);
    this.touch(run);
    return agent;
  }

  private touch(run: StoredRun): void {
    run.updatedAtEpochMs = this.now();
  }

  private boundedTail<T>(values: readonly T[], limit: number | undefined): readonly T[] {
    if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
      return values;
    }

    return values.slice(Math.max(0, values.length - Math.floor(limit)));
  }

  private snapshotRunValue(
    run: StoredRun,
    bounds: ControlRunSnapshotBounds = {},
  ): ControlRunSnapshot {
    const commands = Array.from(run.commands.values(), (command) => ({
      envelope: command.envelope,
      queuedAtEpochMs: command.queuedAtEpochMs,
      dispatchedAtEpochMs: command.dispatchedAtEpochMs,
      completedAtEpochMs: command.completedAtEpochMs,
      dispatchCount: command.dispatchCount,
    }));
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
        resumeCompletedCommandIds: Array.from(agent.resumeCompletedCommandIds),
      })),
      commands: this.boundedTail(commands, bounds.commands),
      results: this.boundedTail(results, bounds.results),
      events: this.boundedTail(run.events, bounds.events),
      stats: this.boundedTail(run.stats, bounds.stats),
      reports: this.boundedTail(run.reports, bounds.reports),
      heartbeats: this.boundedTail(run.heartbeats, bounds.heartbeats),
    };
  }
}

export function createRallarBlackBoxControlService(
  options: RallarBlackBoxControlServiceOptions = {},
): RallarBlackBoxControlService {
  return new RallarBlackBoxControlService(options);
}

function cleanSegment(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function safeCommandIdSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'segment';
}
