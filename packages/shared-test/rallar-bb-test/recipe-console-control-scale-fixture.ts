import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from './control-snapshots.ts';
import type { RallarBlackBoxDistributedRunManifest } from './distributed-run.ts';
import {
    boundedInteger,
    createControlScaleRetention,
    type ControlScaleRetentionFixture,
    type ControlScaleRetentionOptions
} from './recipe-console-control-scale-retention.ts';

export const RECIPE_CONSOLE_CONTROL_SCALE_DEFAULT_PAIR_COUNT = 5_000;

const MAX_PAIR_COUNT = 10_000;
const MAX_TOTAL_AGENTS = 100_000;
const BASE_EPOCH_MS = 2_000_000_000_000;
const GROUP = Object.freeze({
    applicationId: 'rallar-server',
    workspaceId: 'recipe-console-scale',
    groupId: 'recipe-console-scale'
});
const RECIPE = Object.freeze({
    schemaVersion: 1 as const,
    recipeId: 'recipe-console-control-scale-health',
    commands: Object.freeze([{ kind: 'health' as const, commandId: 'scale-health' }])
});

type ScalePosition = 'first' | 'middle' | 'last' | 'longBidi';
type ScalePositions = Readonly<Record<ScalePosition, number>>;

export type RecipeConsoleControlScaleFixtureOptions = Readonly<{
    pairCount?: number;
    agentsPerRun?: number;
    retention?: ControlScaleRetentionOptions;
}>;

export type RecipeConsoleControlScaleFixture = Readonly<{
    snapshot:
        & ControlServerSnapshot
        & Readonly<{
            distributedRuns: readonly ControlDistributedRunSnapshot[];
        }>;
    positions: ScalePositions;
    needles: Readonly<{
        controlRunIds: Readonly<Record<ScalePosition, string>>;
        distributedRunIds: Readonly<Record<ScalePosition, string>>;
        agentIds: Readonly<Record<ScalePosition, string>>;
    }>;
    counts: Readonly<{
        pairs: number;
        agents: number;
        retentionCandidates: number;
        retentionDistributedRuns: number;
        retentionFleetReports: number;
    }>;
    retention: ControlScaleRetentionFixture;
}>;

export function createRecipeConsoleControlScaleFixture(
    options: RecipeConsoleControlScaleFixtureOptions = {}
): RecipeConsoleControlScaleFixture {
    const pairCount = boundedInteger(
        options.pairCount ?? RECIPE_CONSOLE_CONTROL_SCALE_DEFAULT_PAIR_COUNT,
        'pairCount',
        4,
        MAX_PAIR_COUNT
    );
    const agentsPerRun = boundedInteger(
        options.agentsPerRun ?? 1,
        'agentsPerRun',
        1,
        MAX_TOTAL_AGENTS
    );
    if (pairCount * agentsPerRun > MAX_TOTAL_AGENTS) {
        throw new Error(`pairCount × agentsPerRun must not exceed ${MAX_TOTAL_AGENTS}.`);
    }
    const positions = scalePositions(pairCount);
    const runs: ControlRunSnapshot[] = [];
    const distributedRuns: ControlDistributedRunSnapshot[] = [];
    for (let ordinal = 0; ordinal < pairCount; ordinal += 1) {
        const controlRunId = controlId(ordinal, positions.longBidi);
        const distributedRunId = distributedId(ordinal, positions.longBidi);
        const updatedAtEpochMs = BASE_EPOCH_MS - ordinal;
        const agents = Array.from(
            { length: agentsPerRun },
            (_, agentOrdinal) => agent(controlRunId, ordinal, agentOrdinal, positions.longBidi, updatedAtEpochMs)
        );
        const manifest = distributedManifest(
            controlRunId,
            distributedRunId,
            agents.map((row) => row.agentId)
        );
        runs.push(controlRun(controlRunId, updatedAtEpochMs, agents));
        distributedRuns.push(distributedRun(
            controlRunId,
            distributedRunId,
            updatedAtEpochMs,
            agents.map((row) => row.agentId),
            manifest
        ));
    }
    const retention = createControlScaleRetention(
        options.retention,
        runs,
        distributedRuns
    );
    return {
        snapshot: { runs, distributedRuns },
        positions,
        needles: {
            controlRunIds: positionValues(positions, (index) => controlId(index, positions.longBidi)),
            distributedRunIds: positionValues(positions, (index) => distributedId(index, positions.longBidi)),
            agentIds: positionValues(positions, (index) => agentId(index, 0, positions.longBidi))
        },
        counts: {
            pairs: pairCount,
            agents: pairCount * agentsPerRun,
            retentionCandidates: retention.candidates.length,
            retentionDistributedRuns: retention.wouldDeleteDistributedRunIds.length,
            retentionFleetReports: retention.wouldDeleteFleetReportIds.length
        },
        retention
    };
}

function controlRun(
    runId: string,
    updatedAtEpochMs: number,
    agents: readonly ControlAgentSnapshot[]
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: updatedAtEpochMs - 10_000,
        updatedAtEpochMs,
        agents,
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function agent(
    runId: string,
    runOrdinal: number,
    agentOrdinal: number,
    longBidiOrdinal: number,
    updatedAtEpochMs: number
): ControlAgentSnapshot {
    const id = agentId(runOrdinal, agentOrdinal, longBidiOrdinal);
    return {
        runId,
        agentId: id,
        connected: true,
        registeredAtEpochMs: updatedAtEpochMs - 5_000,
        lastSeenAtEpochMs: updatedAtEpochMs,
        lastHeartbeatAtEpochMs: updatedAtEpochMs,
        identity: {
            principalId: `principal-${id}`,
            clientId: `client-${id}`,
            sessionId: `session-${id}`,
            ...GROUP,
            updatedAtEpochMs
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: []
    };
}

function distributedManifest(
    controlRunId: string,
    distributedRunId: string,
    agentIds: readonly string[]
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId,
        controlRunId,
        displayName: `Scale run ${distributedRunId}`,
        group: GROUP,
        recipes: [{ recipeId: RECIPE.recipeId, recipe: RECIPE }],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: agentIds.length,
            agentIds
        },
        startMode: 'manual'
    };
}

function distributedRun(
    controlRunId: string,
    distributedRunId: string,
    updatedAtEpochMs: number,
    targetAgentIds: readonly string[],
    manifest: RallarBlackBoxDistributedRunManifest
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        manifest,
        state: 'passed',
        createdAtEpochMs: updatedAtEpochMs - 10_000,
        updatedAtEpochMs,
        startedAtEpochMs: updatedAtEpochMs - 5_000,
        completedAtEpochMs: updatedAtEpochMs,
        targetAgentIds,
        commandLinks: [],
        rollup: {
            state: 'passed',
            ok: true,
            failures: [],
            summary: {
                participants: targetAgentIds.length,
                requiredParticipants: targetAgentIds.length,
                readyParticipants: targetAgentIds.length,
                passedParticipants: targetAgentIds.length,
                failedParticipants: 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 1,
                failedRecipes: 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 0
            }
        }
    };
}

function scalePositions(count: number): ScalePositions {
    const occupied = new Set([0, Math.floor(count / 2), count - 1]);
    let longBidi = Math.floor(count * 3 / 4);
    while (occupied.has(longBidi)) {
        longBidi = (longBidi + 1) % count;
    }
    return { first: 0, middle: Math.floor(count / 2), last: count - 1, longBidi };
}

function positionValues(
    positions: ScalePositions,
    value: (index: number) => string
): Readonly<Record<ScalePosition, string>> {
    return {
        first: value(positions.first),
        middle: value(positions.middle),
        last: value(positions.last),
        longBidi: value(positions.longBidi)
    };
}

function controlId(ordinal: number, longBidiOrdinal: number): string {
    return ordinal === longBidiOrdinal
        ? `scale-control-\u202egnol-界-\u2066exact\u2069-${'control'.repeat(20)}`
        : `scale-control-${padded(ordinal)}`;
}

function distributedId(ordinal: number, longBidiOrdinal: number): string {
    return ordinal === longBidiOrdinal
        ? `scale-distributed-\u202egnol-界-\u2066exact\u2069-${'distributed'.repeat(14)}`
        : `scale-distributed-${padded(ordinal)}`;
}

function agentId(
    runOrdinal: number,
    agentOrdinal: number,
    longBidiOrdinal: number
): string {
    return runOrdinal === longBidiOrdinal && agentOrdinal === 0
        ? `scale-agent-\u202egnol-界-\u2066exact\u2069-${'agent'.repeat(24)}`
        : `scale-agent-${padded(runOrdinal)}-${padded(agentOrdinal)}`;
}

function padded(value: number): string {
    return String(value).padStart(6, '0');
}
