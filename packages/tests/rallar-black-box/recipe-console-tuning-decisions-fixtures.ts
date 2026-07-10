import type {
    DistributedRunAnalysis,
    DistributedRunPerformanceAnalysis,
    DistributedRunTargetResolutionAnalysis,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import {
    inventoryDistributedRunTuningKnobs,
    type DistributedRunTuningInventory,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/types.ts';

export function tuningManifest(input: Readonly<{
    commands?: readonly RallarBlackBoxTestCommand[];
    referenceOnly?: boolean;
    ackTimeoutMs?: number;
    barrier?: Readonly<{ enabled?: boolean; timeoutMs?: number }>;
}> = {}): RallarBlackBoxDistributedRunManifest {
    const recipe = input.referenceOnly
        ? undefined
        : {
            schemaVersion: 1 as const,
            recipeId: 'tune-recipe',
            name: 'Tune recipe',
            commands: input.commands ?? [streamCommand()],
        };
    return {
        schemaVersion: 1,
        distributedRunId: 'tune-run',
        controlRunId: 'tune-control',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-group',
        },
        recipes: [{ recipeId: 'tune-recipe', recipe, profile: 'rtc', required: true }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-a', 'agent-b'],
            expectedParticipantCount: 2,
        },
        roleAssignments: [
            { agentId: 'agent-a', role: 'sender', required: true },
            { agentId: 'agent-b', role: 'receiver', required: true },
        ],
        ackTimeoutMs: input.ackTimeoutMs ?? 5_000,
        barrier: input.barrier ?? { enabled: true, timeoutMs: 7_500 },
        startMode: 'manual',
    };
}

export function streamCommand(input: Readonly<{
    commandId?: string;
    rateHz?: number;
    intervalMs?: number;
    thresholds?: Readonly<Record<string, number>>;
}> = {}): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.stream' }> {
    return {
        kind: 'rtc.stream',
        commandId: input.commandId ?? 'stream-position',
        transport: 'realtime',
        send: { data: { topic: 'position' } },
        durationMs: 10_000,
        rateHz: input.rateHz ?? 20,
        ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
        maxInFlight: 2,
        thresholds: {
            maxDroppedFrames: 5,
            maxP95SendDurationMs: 200,
            ...input.thresholds,
        },
    };
}

export function tuningInventory(
    manifest = tuningManifest(),
): DistributedRunTuningInventory {
    return inventoryDistributedRunTuningKnobs(manifest);
}

export function tuningAnalysis(input: Readonly<{
    ok?: boolean;
    failure?: DistributedRunAnalysis['failure'];
    performance?: DistributedRunPerformanceAnalysis;
    targetResolution?: DistributedRunTargetResolutionAnalysis;
}> = {}): DistributedRunAnalysis {
    const ok = input.ok ?? false;
    return {
        generatedAtEpochMs: 10_000,
        artifactSchemaVersion: 2,
        distributedRunId: 'tune-run',
        controlRunId: 'tune-control',
        status: ok ? 'passed' : 'failed',
        ok,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-group',
        },
        summary: {
            agents: 2,
            passRate: ok ? 1 : 0.5,
            failureGroups: input.failure ? 1 : 0,
            blockingFailures: input.failure ? 1 : 0,
        },
        parseWarnings: [],
        failure: input.failure,
        performance: input.performance,
        targetResolution: input.targetResolution,
        summaryMarkdown: '',
    };
}

export function tuningPerformance(input: Readonly<{
    commandP95Ms?: number;
    stream?: Partial<NonNullable<DistributedRunPerformanceAnalysis['streamTiming']>> | false;
    slowestAgents?: DistributedRunPerformanceAnalysis['slowestAgents'];
}> = {}): DistributedRunPerformanceAnalysis {
    const stream = input.stream === false ? undefined : {
        streamCount: 1,
        plannedFrames: 200,
        scheduledFrames: 200,
        attemptedFrames: 200,
        completedFrames: 200,
        failedFrames: 0,
        droppedFrames: 0,
        inFlightLimitDropCount: 0,
        backpressureCount: 0,
        sendSuccessRatio: 1,
        requestedRateHz: 20,
        achievedScheduleHz: 20,
        achievedCompletionHz: 20,
        maxStartDriftMs: 20,
        lateFrameCount: 0,
        duration: {
            count: 200,
            minMs: 20,
            p50Ms: 50,
            p95Ms: 100,
            p99Ms: 120,
            maxMs: 140,
            averageMs: 55,
            spreadRatio: 2,
            outlierCount: 1,
        },
        slowestAgents: [
            { agentId: 'agent-a', streamCount: 1, plannedFrames: 100, completedFrames: 100, maxMs: 500 },
            { agentId: 'agent-b', streamCount: 1, plannedFrames: 100, completedFrames: 100, maxMs: 100 },
        ],
        ...input.stream,
    } satisfies NonNullable<DistributedRunPerformanceAnalysis['streamTiming']>;
    return {
        runDurationMs: 10_000,
        agentCount: 2,
        passRate: 1,
        reconnectCount: 0,
        diagnosticCount: 0,
        warningDiagnosticCount: 0,
        errorDiagnosticCount: 0,
        exportedEventCount: 0,
        agentReportedEventCount: 0,
        failedAgentCount: 0,
        missingAgentCount: 0,
        staleAgentCount: 0,
        flakyAgentCount: 0,
        commandTiming: {
            count: 4,
            minMs: 50,
            p50Ms: 100,
            p95Ms: input.commandP95Ms ?? 200,
            p99Ms: input.commandP95Ms ?? 200,
            maxMs: input.commandP95Ms ?? 200,
            averageMs: 125,
            spreadRatio: 2,
            outlierCount: 1,
        },
        streamTiming: stream,
        slowestAgents: input.slowestAgents ?? [
            { agentId: 'agent-a', commandCount: 2, averageMs: 1_000, maxMs: 2_000 },
            { agentId: 'agent-b', commandCount: 2, averageMs: 250, maxMs: 500 },
        ],
    };
}

export function targetResolution(
    overrides: Partial<DistributedRunTargetResolutionAnalysis> = {},
): DistributedRunTargetResolutionAnalysis {
    return {
        selected: 2,
        expectedParticipantCount: 2,
        missingExpectedParticipants: 0,
        blockers: 0,
        staleAgents: 0,
        offlineAgents: 0,
        wrongGroupAgents: 0,
        agentsWithoutIdentity: 0,
        roleCounts: { sender: 1, receiver: 1 },
        regions: { 'eu-north': 2 },
        providers: { browser: 2 },
        targetAgentIds: ['agent-a', 'agent-b'],
        blockingAgentIds: [],
        ...overrides,
    };
}

export function failure(
    category: string,
    title: string,
): NonNullable<DistributedRunAnalysis['failure']> {
    return {
        category,
        title,
        likelyCause: title,
        nextAction: 'Inspect the evidence.',
        minimalFixArea: 'recipe timing',
        verificationCommand: 'npm test',
        affectedAgents: [],
        affectedRegions: [],
        evidenceFile: 'results.jsonl',
    };
}
