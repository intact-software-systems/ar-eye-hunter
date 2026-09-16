import type {
    ControlEventEnvelope,
    ControlResultEnvelope
} from '../../../shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '../../../shared-test/rallar-bb-test/control-snapshots.ts';
import {
    computeDistributedRunArtifactAnalysis,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
    type DistributedRunFailedAnalysis
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxDistributedTargetResolution
} from '../../../shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxDistributedRunRollup,
    RallarBlackBoxDistributedRunRollupFailure
} from '../../../shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecipe
} from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** The generation time the analysis suites pass when the time itself is not under test. */
export const ANALYSIS_GENERATED_AT_EPOCH_MS = 123;

export const FIXTURE_GROUP: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'bb-group'
};

export const HEALTH_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'health-only',
    commands: [{ kind: 'health' }]
};

export interface DistributedRunManifestFixtureInput {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly agentIds: readonly string[];
    readonly recipes?: RallarBlackBoxDistributedRunManifest['recipes'];
}

export interface DistributedRunSnapshotFixtureInput {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly state: RallarBlackBoxDistributedRunState;
    readonly agentIds: readonly string[];
    readonly createdAtEpochMs?: number;
    readonly startedAtEpochMs?: number;
    readonly completedAtEpochMs?: number;
    readonly commandLinks?: readonly ControlDistributedRunCommandLink[];
    readonly failures?: readonly RallarBlackBoxDistributedRunRollupFailure[];
    readonly summary?: Partial<RallarBlackBoxDistributedRunRollup['summary']>;
    readonly manifest?: RallarBlackBoxDistributedRunManifest;
    readonly targetResolution?: RallarBlackBoxDistributedTargetResolution;
}

export interface ControlAgentFixtureInput {
    readonly agentId: string;
    readonly connected?: boolean;
    readonly reconnectCount?: number;
    readonly receivedEventCount?: number;
}

export interface ControlRunSnapshotFixtureInput {
    readonly runId: string;
    readonly agents?: readonly ControlAgentFixtureInput[];
    readonly commands?: readonly ControlQueuedCommandSnapshot[];
    readonly results?: readonly ControlResultEnvelope[];
    readonly events?: readonly ControlEventEnvelope[];
}

export interface QueuedCommandFixtureInput {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly command?: RallarBlackBoxTestCommand;
    readonly queuedAtEpochMs: number;
    readonly dispatchedAtEpochMs?: number;
    readonly completedAtEpochMs?: number;
}

export interface ResultEnvelopeFixtureInput<Value> {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestCommandKind;
    readonly ok: boolean;
    readonly startedAtEpochMs: number;
    readonly durationMs: number;
    readonly value?: Value;
    readonly error?: RallarBlackBoxTestError;
}

export interface DistributedRunArtifactFilesFixtureInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot;
    readonly files?: DistributedRunArtifactFiles;
}

/** The analysis of files a case built as a distributed run; any other outcome throws and fails the case. */
export function computeDistributedRunAnalysis(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs: number
): DistributedRunAnalysis {
    const analyzed = computeDistributedRunArtifactAnalysis({ files, generatedAtEpochMs });
    if (analyzed.right?.variant !== 'distributed-run') {
        throw new Error(`Expected a distributed run analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
}

/** The analysis of files a case built as a failed distributed run; any other outcome throws and fails the case. */
export function computeFailedDistributedRunAnalysis(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs: number
): DistributedRunFailedAnalysis {
    const analysis = computeDistributedRunAnalysis(files, generatedAtEpochMs);
    if (analysis.ok) {
        throw new Error('Expected a failed distributed run analysis.');
    }
    return analysis;
}

export function createDistributedRunManifest(
    input: DistributedRunManifestFixtureInput
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        group: FIXTURE_GROUP,
        recipes: input.recipes ?? [{ recipeId: HEALTH_RECIPE.recipeId, recipe: HEALTH_RECIPE }],
        targetPolicy: { mode: 'selected-agents', agentIds: [...input.agentIds] },
        roleAssignments: [],
        startMode: 'manual',
        metadata: {}
    };
}

export function createDistributedRunSnapshot(
    input: DistributedRunSnapshotFixtureInput
): ControlDistributedRunSnapshot {
    const ok = input.state === 'passed';
    const createdAtEpochMs = input.createdAtEpochMs ?? input.startedAtEpochMs ?? 1;
    return {
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        manifest: input.manifest ?? createDistributedRunManifest(input),
        state: input.state,
        createdAtEpochMs,
        updatedAtEpochMs: input.completedAtEpochMs ?? createdAtEpochMs,
        ...(input.startedAtEpochMs === undefined ? {} : { startedAtEpochMs: input.startedAtEpochMs }),
        ...(input.completedAtEpochMs === undefined ? {} : { completedAtEpochMs: input.completedAtEpochMs }),
        targetAgentIds: input.agentIds,
        ...(input.targetResolution === undefined ? {} : { targetResolution: input.targetResolution }),
        commandLinks: input.commandLinks ?? [],
        rollup: {
            state: input.state,
            ok,
            summary: {
                participants: input.agentIds.length,
                requiredParticipants: input.agentIds.length,
                readyParticipants: input.agentIds.length,
                passedParticipants: ok ? input.agentIds.length : 0,
                failedParticipants: ok ? 0 : input.agentIds.length,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: ok ? 1 : 0,
                failedRecipes: ok ? 0 : 1,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: ok ? 0 : 1,
                ...input.summary
            },
            failures: input.failures ?? []
        }
    };
}

export function createControlRunSnapshot(input: ControlRunSnapshotFixtureInput): ControlRunSnapshot {
    return {
        runId: input.runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: (input.agents ?? []).map((agent) => createControlAgentSnapshot(input.runId, agent)),
        commands: input.commands ?? [],
        results: input.results ?? [],
        events: input.events ?? [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

export function createQueuedCommandSnapshot(input: QueuedCommandFixtureInput): ControlQueuedCommandSnapshot {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: input.runId,
            agentId: input.agentId,
            commandId: input.commandId,
            command: input.command ?? { kind: 'health' }
        },
        queuedAtEpochMs: input.queuedAtEpochMs,
        ...(input.dispatchedAtEpochMs === undefined ? {} : { dispatchedAtEpochMs: input.dispatchedAtEpochMs }),
        ...(input.completedAtEpochMs === undefined ? {} : { completedAtEpochMs: input.completedAtEpochMs }),
        dispatchCount: 1
    };
}

export function createResultEnvelope<Value>(input: ResultEnvelopeFixtureInput<Value>): ControlResultEnvelope {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agentId,
        commandId: input.commandId,
        ok: input.ok,
        result: {
            commandId: input.commandId,
            kind: input.kind,
            status: input.ok ? 'ok' : 'failed',
            ok: input.ok,
            startedAtEpochMs: input.startedAtEpochMs,
            endedAtEpochMs: input.startedAtEpochMs + input.durationMs,
            durationMs: input.durationMs,
            ...(input.value === undefined ? {} : { value: input.value }),
            ...(input.error === undefined ? {} : { error: input.error })
        },
        ...(input.error === undefined ? {} : { error: { code: input.error.code, message: input.error.message } })
    };
}

export function toDistributedRunArtifactFiles(
    input: DistributedRunArtifactFilesFixtureInput
): DistributedRunArtifactFiles {
    return {
        'distributed-run.json': JSON.stringify(input.distributedRun),
        'manifest.json': JSON.stringify(input.distributedRun.manifest),
        'control-run.json': JSON.stringify(input.controlRun),
        ...input.files
    };
}

function createControlAgentSnapshot(runId: string, agent: ControlAgentFixtureInput): ControlAgentSnapshot {
    return {
        runId,
        agentId: agent.agentId,
        connected: agent.connected ?? true,
        connectionSequence: 1,
        reconnectCount: agent.reconnectCount ?? 0,
        receivedResultCount: 0,
        receivedEventCount: agent.receivedEventCount ?? 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: []
    };
}
