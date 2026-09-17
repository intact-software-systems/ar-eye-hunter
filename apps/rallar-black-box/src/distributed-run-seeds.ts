import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '@shared-test/rallar-bb-test/assert/assert-value-operators.ts';
import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { toRallarBlackBoxRuntimeDiagnostic } from '@shared-test/rallar-bb-test/diagnostics.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxDistributedRunRollup
} from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from './control-run-manager.ts';

export type DistributedRunSeedId =
    | 'passed-clean'
    | 'passed-warnings'
    | 'failed-command'
    | 'high-latency-rtc'
    | 'artifact-missing';

export interface DistributedRunSeedMetadata {
    readonly id: DistributedRunSeedId;
    readonly label: string;
    readonly description: string;
}

export type SyntheticDistributedRunSeed =
    & DistributedRunSeedMetadata
    & Readonly<{
        source: 'synthetic';
        generatedAtEpochMs: number;
        distributedRun: ControlDistributedRunSnapshot;
        controlRun: ControlRunSnapshot;
        /** Absent for the seed whose whole point is a run with no artifact bundle to analyze. */
        artifactBundle: ControlDistributedRunArtifactBundle | undefined;
    }>;

interface SeedAgentInput {
    readonly agentId: string;
    readonly principalId: string;
    readonly role: string;
    readonly stageDurationMs: number;
    readonly startDurationMs: number;
    readonly startOk: boolean;
    readonly eventCount: number;
    /** Absent when the agent's start succeeds, so the seed carries no failure text for it. */
    readonly failureMessage?: string;
}

type SeedShape = Readonly<{
    state: ControlDistributedRunSnapshot['state'];
    ok: boolean;
    agents: readonly SeedAgentInput[];
    warningDiagnostic: boolean;
    omitArtifact: boolean;
}>;

type SeedBuildInput = DistributedRunSeedMetadata & SeedShape;

/** The outcome a seeded command reports; a failure always names the text its evidence shows. */
type SeedCommandOutcome =
    | Readonly<{ ok: true; }>
    | Readonly<{ ok: false; errorMessage: string; }>;

const SEED_BASE_EPOCH_MS = 1_900_000_000_000;
const SYNTHETIC_COMMAND_FAILURE_MESSAGE = 'Synthetic command failed.';
const SYNTHETIC_WARNING_DIAGNOSTIC_MESSAGE = 'Synthetic RTC evidence includes a warning diagnostic.';

const SEED_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'seed-rtc-recipe',
    name: 'Synthetic RTC evidence recipe',
    commands: [
        { kind: 'rtc.connect', commandId: 'seed-connect' },
        {
            kind: 'rtc.send',
            commandId: 'seed-send',
            send: {
                data: {
                    topic: 'synthetic.rtc.payload',
                    distributedRunSeed: true
                },
                roomId: 'seed-room'
            }
        },
        {
            kind: 'wait',
            commandId: 'seed-receive',
            match: {
                topic: 'synthetic.rtc.payload.received'
            },
            timeoutMs: 2_000
        }
    ]
};

/** Every seed's operator-facing metadata, keyed so the compiler proves the catalog is total. */
type SeedMetadataById = {
    [Id in DistributedRunSeedId]: DistributedRunSeedMetadata & Readonly<{ id: Id; }>;
};

const SEED_METADATA_BY_ID: SeedMetadataById = {
    'passed-clean': {
        id: 'passed-clean',
        label: 'Passed clean',
        description: 'Two synthetic agents complete the recipe with valid artifact evidence.'
    },
    'passed-warnings': {
        id: 'passed-warnings',
        label: 'Passed with evidence warning',
        description: 'The run passes, but includes a runtime warning diagnostic for review.'
    },
    'failed-command': {
        id: 'failed-command',
        label: 'Failed command',
        description: 'The receiver command fails after missing the expected RTC payload.'
    },
    'high-latency-rtc': {
        id: 'high-latency-rtc',
        label: 'High latency RTC',
        description: 'Three agents pass with high per-agent RTC timing variance.'
    },
    'artifact-missing': {
        id: 'artifact-missing',
        label: 'Artifact missing',
        description: 'The run passes, but no distributed artifact bundle is loaded.'
    }
};

/** The operator ordering of the seed picker: the declaration order of the table above. */
export const DISTRIBUTED_RUN_SEEDS: readonly DistributedRunSeedMetadata[] = Object.values(
    SEED_METADATA_BY_ID
);

export function resolveDistributedRunSeedId(
    value: string | null | undefined
): DistributedRunSeedId | undefined {
    return value !== null && value !== undefined &&
            Object.hasOwn(SEED_METADATA_BY_ID, value)
        ? value as DistributedRunSeedId
        : undefined;
}

/** Each seed's evidence shape; the metadata list above owns their operator ordering. */
const SEED_SHAPE_BY_ID: Readonly<Record<DistributedRunSeedId, SeedShape>> = {
    'passed-clean': {
        state: 'passed',
        ok: true,
        warningDiagnostic: false,
        omitArtifact: false,
        agents: [
            {
                agentId: 'seed-agent-a',
                principalId: 'alice',
                role: 'sender',
                stageDurationMs: 80,
                startDurationMs: 170,
                startOk: true,
                eventCount: 2
            },
            {
                agentId: 'seed-agent-b',
                principalId: 'bob',
                role: 'receiver',
                stageDurationMs: 90,
                startDurationMs: 190,
                startOk: true,
                eventCount: 2
            }
        ]
    },
    'passed-warnings': {
        state: 'passed',
        ok: true,
        warningDiagnostic: true,
        omitArtifact: false,
        agents: [
            {
                agentId: 'seed-agent-a',
                principalId: 'alice',
                role: 'sender',
                stageDurationMs: 80,
                startDurationMs: 170,
                startOk: true,
                eventCount: 2
            },
            {
                agentId: 'seed-agent-b',
                principalId: 'bob',
                role: 'receiver',
                stageDurationMs: 90,
                startDurationMs: 190,
                startOk: true,
                eventCount: 2
            }
        ]
    },
    'failed-command': {
        state: 'failed',
        ok: false,
        warningDiagnostic: false,
        omitArtifact: false,
        agents: [
            {
                agentId: 'seed-agent-a',
                principalId: 'alice',
                role: 'sender',
                stageDurationMs: 80,
                startDurationMs: 170,
                startOk: true,
                eventCount: 2
            },
            {
                agentId: 'seed-agent-b',
                principalId: 'bob',
                role: 'receiver',
                stageDurationMs: 90,
                startDurationMs: 520,
                startOk: false,
                eventCount: 0,
                failureMessage: 'Receiver did not observe the RTC payload.'
            }
        ]
    },
    'high-latency-rtc': {
        state: 'passed',
        ok: true,
        warningDiagnostic: false,
        omitArtifact: false,
        agents: [
            {
                agentId: 'seed-agent-a',
                principalId: 'alice',
                role: 'sender',
                stageDurationMs: 95,
                startDurationMs: 130,
                startOk: true,
                eventCount: 3
            },
            {
                agentId: 'seed-agent-b',
                principalId: 'bob',
                role: 'receiver',
                stageDurationMs: 980,
                startDurationMs: 1_040,
                startOk: true,
                eventCount: 3
            },
            {
                agentId: 'seed-agent-c',
                principalId: 'cara',
                role: 'observer',
                stageDurationMs: 1_120,
                startDurationMs: 1_260,
                startOk: true,
                eventCount: 3
            }
        ]
    },
    'artifact-missing': {
        state: 'passed',
        ok: true,
        warningDiagnostic: false,
        omitArtifact: true,
        agents: [
            {
                agentId: 'seed-agent-a',
                principalId: 'alice',
                role: 'sender',
                stageDurationMs: 80,
                startDurationMs: 170,
                startOk: true,
                eventCount: 2
            },
            {
                agentId: 'seed-agent-b',
                principalId: 'bob',
                role: 'receiver',
                stageDurationMs: 90,
                startDurationMs: 190,
                startOk: true,
                eventCount: 2
            }
        ]
    }
};

export function createSyntheticDistributedRunSeed(
    id: DistributedRunSeedId
): SyntheticDistributedRunSeed {
    return toSyntheticDistributedRunSeed({
        ...SEED_METADATA_BY_ID[id],
        ...SEED_SHAPE_BY_ID[id]
    });
}

function toSyntheticDistributedRunSeed(input: SeedBuildInput): SyntheticDistributedRunSeed {
    const distributedRunId = `seed-${input.id}`;
    const controlRunId = `seed-control-${input.id}`;
    const schedule = toSeedSchedule(input);
    const { createdAtEpochMs, stagedAtEpochMs, startedAtEpochMs, completedAtEpochMs, generatedAtEpochMs } = schedule;
    const evidence = { input, schedule, controlRunId, distributedRunId };
    const controlRun = toSeedControlRun(evidence);
    const manifest = toSeedManifest({
        distributedRunId,
        controlRunId,
        seedId: input.id,
        agents: input.agents
    });
    const commandLinks = input.agents.flatMap((agent) => [
        toSeedCommandLink({
            phase: 'stage',
            agent: agent,
            queuedAtEpochMs: stagedAtEpochMs + toSeedAgentOffset(agent),
            recipeId: SEED_RECIPE.recipeId
        }),
        toSeedCommandLink({
            phase: 'start',
            agent: agent,
            queuedAtEpochMs: startedAtEpochMs + toSeedAgentOffset(agent),
            recipeId: SEED_RECIPE.recipeId
        })
    ]);
    const distributedRun: ControlDistributedRunSnapshot = {
        distributedRunId,
        controlRunId,
        manifest,
        state: input.state,
        createdAtEpochMs,
        updatedAtEpochMs: generatedAtEpochMs,
        stagedAtEpochMs,
        startedAtEpochMs,
        completedAtEpochMs,
        targetAgentIds: input.agents.map((agent) => agent.agentId),
        commandLinks,
        rollup: toSeedRollup(input)
    };
    const artifactBundle = input.omitArtifact
        ? undefined
        : toSeedArtifactBundle({
            distributedRun,
            controlRun,
            generatedAtEpochMs
        });
    return {
        ...input,
        source: 'synthetic',
        generatedAtEpochMs,
        distributedRun,
        controlRun,
        artifactBundle
    };
}

function toSeedManifest(
    input: Readonly<{
        distributedRunId: string;
        controlRunId: string;
        seedId: DistributedRunSeedId;
        agents: readonly SeedAgentInput[];
    }>
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: `Synthetic ${input.seedId}`,
        description: 'Synthetic distributed run evidence for rallar-black-box UI and browser QA.',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'seed-room'
        },
        recipes: [{
            recipeId: SEED_RECIPE.recipeId,
            recipe: SEED_RECIPE,
            profile: 'synthetic',
            variables: {}
        }],
        targetPolicy: {
            mode: 'role-map',
            expectedParticipantCount: input.agents.length,
            roles: Object.fromEntries(
                input.agents.map((agent) => [agent.role, [agent.agentId]])
            )
        },
        variables: {},
        roleAssignments: input.agents.map((agent) => ({
            agentId: agent.agentId,
            role: agent.role,
            recipeIds: [],
            variables: {}
        })),
        ackTimeoutMs: 5_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: [],
        metadata: {
            synthetic: true,
            seedId: input.seedId
        }
    };
}

function toSeedCommandLink(
    input: {
        readonly phase: ControlDistributedRunCommandLink['phase'];
        readonly agent: SeedAgentInput;
        readonly queuedAtEpochMs: number;
        readonly recipeId: string;
    }
): ControlDistributedRunCommandLink {
    const { phase, agent, queuedAtEpochMs, recipeId } = input;
    return {
        phase,
        agentId: agent.agentId,
        commandId: toSeedCommandId(phase, agent),
        recipeId,
        role: agent.role,
        queuedAtEpochMs
    };
}

function toSeedQueuedCommand(
    input: Readonly<{
        runId: string;
        agent: SeedAgentInput;
        phase: 'stage' | 'start';
        queuedAtEpochMs: number;
        durationMs: number;
        command: ControlQueuedCommandSnapshot['envelope']['command'];
    }>
): ControlQueuedCommandSnapshot {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: input.runId,
            agentId: input.agent.agentId,
            commandId: toSeedCommandId(input.phase, input.agent),
            command: input.command
        },
        queuedAtEpochMs: input.queuedAtEpochMs,
        dispatchedAtEpochMs: input.queuedAtEpochMs + 20,
        completedAtEpochMs: input.queuedAtEpochMs + 20 + input.durationMs,
        dispatchCount: 1
    };
}

function toSeedResultEnvelope(
    input: Readonly<{
        runId: string;
        agent: SeedAgentInput;
        commandId: string;
        kind: RallarBlackBoxTestResult['kind'];
        startedAtEpochMs: number;
        durationMs: number;
        outcome: SeedCommandOutcome;
    }>
): ControlResultEnvelope {
    const { outcome } = input;
    const error = outcome.ok
        ? undefined
        : {
            code: 'SYNTHETIC_ASSERTION_FAILED',
            message: outcome.errorMessage
        };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: input.commandId,
        ok: outcome.ok,
        ...(error ? { error } : {}),
        result: {
            commandId: input.commandId,
            kind: input.kind,
            status: outcome.ok ? 'ok' : 'failed',
            ok: outcome.ok,
            startedAtEpochMs: input.startedAtEpochMs,
            endedAtEpochMs: input.startedAtEpochMs + input.durationMs,
            durationMs: input.durationMs,
            ...(error ? { error } : {})
        }
    };
}

function toSeedEventEnvelope(
    input: Readonly<{
        runId: string;
        distributedRunId: string;
        agent: SeedAgentInput;
        commandId: string;
        index: number;
        atEpochMs: number;
    }>
): ControlEventEnvelope {
    return {
        kind: 'event',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: input.commandId,
        eventId: `${input.commandId}-event-${input.index + 1}`,
        atEpochMs: input.atEpochMs,
        payload: {
            distributedRunId: input.distributedRunId,
            topic: 'synthetic.rtc.payload.received',
            message: `${input.agent.role} observed synthetic RTC payload ${input.index + 1}`,
            agentId: input.agent.agentId,
            commandId: input.commandId
        }
    };
}

function toSeedDiagnosticEnvelope(
    input: Readonly<{
        runId: string;
        distributedRunId: string;
        agent: SeedAgentInput;
        commandId: string;
        atEpochMs: number;
        severity: 'warning' | 'error';
        message: string;
    }>
): ControlEventEnvelope {
    const severity = input.severity;
    return {
        kind: 'diagnostic',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: input.commandId,
        eventId: `${input.commandId}-${severity}-diagnostic`,
        atEpochMs: input.atEpochMs,
        payload: toRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.browser.realtime.synthetic_seed',
            severity,
            transport: 'messages.rtc',
            message: input.message,
            commandId: input.commandId,
            roomId: 'seed-room',
            source: 'distributed-run-seed',
            payload: {
                distributedRunId: input.distributedRunId,
                agentId: input.agent.agentId
            }
        })
    };
}

function toSeedAgentSnapshot(
    input: Readonly<{
        runId: string;
        agent: SeedAgentInput;
        updatedAtEpochMs: number;
        completedCommandIds: readonly string[];
    }>
): ControlAgentSnapshot {
    return {
        runId: input.runId,
        agentId: input.agent.agentId,
        connected: true,
        registeredAtEpochMs: SEED_BASE_EPOCH_MS + 900,
        lastSeenAtEpochMs: input.updatedAtEpochMs,
        lastHeartbeatAtEpochMs: input.updatedAtEpochMs,
        status: input.agent.startOk ? 'completed' : 'failed',
        identity: {
            principalId: input.agent.principalId,
            username: input.agent.principalId,
            sessionId: `${input.agent.principalId}-session`,
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'seed-room',
            providerMode: 'browser-rallar',
            browserLabel: `${input.agent.role} synthetic browser`,
            sessionLabel: `${input.agent.principalId}:${input.agent.principalId}-session`,
            tags: ['synthetic', input.agent.role],
            capabilities: {
                crdt: {
                    supported: true,
                    transports: ['rtc', 'ws-then-rtc'],
                    runtimeSurface: 'browser-rallar',
                    apiBaseUrlConfigured: true
                },
                assertions: {
                    absence: true,
                    untilLoop: true,
                    operators: RALLAR_BLACK_BOX_ASSERT_OPERATORS
                },
                messaging: {
                    supported: true,
                    carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'],
                    faults: true,
                    storageCounters: true,
                    reload: true
                }
            },
            updatedAtEpochMs: input.updatedAtEpochMs
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: input.completedCommandIds.length,
        receivedEventCount: input.agent.eventCount,
        completedCommandIds: input.completedCommandIds,
        resumeCompletedCommandIds: input.completedCommandIds
    };
}

function toSeedRollup(input: SeedBuildInput): RallarBlackBoxDistributedRunRollup {
    const failedAgents = input.agents.filter((agent) => !agent.startOk);
    return {
        state: input.state,
        ok: input.ok,
        summary: {
            participants: input.agents.length,
            readyParticipants: input.agents.length,
            passedParticipants: input.agents.length - failedAgents.length,
            failedParticipants: failedAgents.length,
            recipes: 1,
            passedRecipes: input.ok ? 1 : 0,
            failedRecipes: input.ok ? 0 : 1,
            groupAssertions: 0,
            passedGroupAssertions: 0,
            failedGroupAssertions: 0,
            blockingFailures: failedAgents.length
        },
        failures: failedAgents.map((agent) => ({
            kind: 'recipe',
            key: SEED_RECIPE.recipeId,
            state: 'failed',
            error: {
                code: 'SYNTHETIC_RECIPE_FAILED',
                message: agent.failureMessage ?? 'Synthetic recipe failed.'
            }
        }))
    };
}

function toSeedArtifactBundle(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        controlRun: ControlRunSnapshot;
        generatedAtEpochMs: number;
    }>
): ControlDistributedRunArtifactBundle {
    return {
        artifactSchemaVersion: 2,
        distributedRunId: input.distributedRun.distributedRunId,
        generatedAtEpochMs: input.generatedAtEpochMs,
        files: {
            'distributed-run.json': JSON.stringify(input.distributedRun),
            'manifest.json': JSON.stringify(input.distributedRun.manifest),
            'control-run.json': JSON.stringify(input.controlRun),
            'report.json': JSON.stringify({
                synthetic: true,
                distributedRunId: input.distributedRun.distributedRunId,
                ok: input.distributedRun.rollup.ok
            }),
            'results.jsonl': input.controlRun.results
                .map((result) => JSON.stringify(result))
                .join('\n'),
            'events.jsonl': input.controlRun.events
                .map((event) => JSON.stringify(event))
                .join('\n'),
            'failures.json': JSON.stringify({ failures: input.distributedRun.rollup.failures }),
            'metadata.json': JSON.stringify({
                synthetic: true,
                generatedAtEpochMs: input.generatedAtEpochMs
            })
        }
    };
}

function toSeedCommandId(
    phase: 'stage' | 'start' | 'barrier' | 'cancel',
    agent: SeedAgentInput
): string {
    return `seed-${phase}-${agent.role}`;
}

function toSeedStartOutcome(agent: SeedAgentInput): SeedCommandOutcome {
    return agent.startOk
        ? { ok: true }
        : { ok: false, errorMessage: agent.failureMessage ?? SYNTHETIC_COMMAND_FAILURE_MESSAGE };
}

function toSeedAgentOffset(agent: SeedAgentInput): number {
    return agent.agentId.charCodeAt(agent.agentId.length - 1) * 5;
}

interface SeedSchedule {
    readonly createdAtEpochMs: number;
    readonly stagedAtEpochMs: number;
    readonly startedAtEpochMs: number;
    readonly completedAtEpochMs: number;
    readonly generatedAtEpochMs: number;
}

function toSeedSchedule(input: SeedBuildInput): SeedSchedule {
    const createdAtEpochMs = SEED_BASE_EPOCH_MS + 1_000;
    const stagedAtEpochMs = createdAtEpochMs + 100;
    const startedAtEpochMs = createdAtEpochMs + 500;
    const lastStartResultEpochMs = Math.max(
        ...input.agents.map((agent) => startedAtEpochMs + toSeedAgentOffset(agent) + 20 + agent.startDurationMs)
    );
    const completedAtEpochMs = lastStartResultEpochMs + 50;
    const generatedAtEpochMs = completedAtEpochMs + 300;
    return { createdAtEpochMs, stagedAtEpochMs, startedAtEpochMs, completedAtEpochMs, generatedAtEpochMs };
}

interface SeedEvidenceInput {
    readonly input: SeedBuildInput;
    readonly schedule: SeedSchedule;
    readonly controlRunId: string;
    readonly distributedRunId: string;
}

function toSeedCommands(evidence: SeedEvidenceInput): ControlRunSnapshot['commands'] {
    const { input, schedule, controlRunId, distributedRunId } = evidence;
    const { stagedAtEpochMs, startedAtEpochMs, generatedAtEpochMs, createdAtEpochMs } = schedule;
    const commands = input.agents.flatMap((agent) => [
        toSeedQueuedCommand({
            runId: controlRunId,
            agent,
            phase: 'stage',
            queuedAtEpochMs: stagedAtEpochMs + toSeedAgentOffset(agent),
            durationMs: agent.stageDurationMs,
            command: { kind: 'recipe.load', recipe: SEED_RECIPE }
        }),
        toSeedQueuedCommand({
            runId: controlRunId,
            agent,
            phase: 'start',
            queuedAtEpochMs: startedAtEpochMs + toSeedAgentOffset(agent),
            durationMs: agent.startDurationMs,
            command: { kind: 'recipe.run', recipe: SEED_RECIPE }
        })
    ]);
    return commands;
}

function toSeedResults(evidence: SeedEvidenceInput): ControlRunSnapshot['results'] {
    const { input, schedule, controlRunId, distributedRunId } = evidence;
    const { stagedAtEpochMs, startedAtEpochMs, generatedAtEpochMs, createdAtEpochMs } = schedule;
    const results = input.agents.flatMap((agent) => [
        toSeedResultEnvelope({
            runId: controlRunId,
            agent,
            commandId: toSeedCommandId('stage', agent),
            kind: 'recipe.load',
            startedAtEpochMs: stagedAtEpochMs + toSeedAgentOffset(agent) + 20,
            durationMs: agent.stageDurationMs,
            outcome: { ok: true }
        }),
        toSeedResultEnvelope({
            runId: controlRunId,
            agent,
            commandId: toSeedCommandId('start', agent),
            kind: 'recipe.run',
            startedAtEpochMs: startedAtEpochMs + toSeedAgentOffset(agent) + 20,
            durationMs: agent.startDurationMs,
            outcome: toSeedStartOutcome(agent)
        })
    ]);
    return results;
}

function toSeedEvents(evidence: SeedEvidenceInput): ControlRunSnapshot['events'] {
    const { input, schedule, controlRunId, distributedRunId } = evidence;
    const { stagedAtEpochMs, startedAtEpochMs, generatedAtEpochMs, createdAtEpochMs } = schedule;
    const events = [
        ...input.agents.flatMap((agent) =>
            Array.from({ length: agent.eventCount }, (_, index) =>
                toSeedEventEnvelope({
                    runId: controlRunId,
                    distributedRunId,
                    agent,
                    commandId: toSeedCommandId('start', agent),
                    index,
                    atEpochMs: startedAtEpochMs + toSeedAgentOffset(agent) + 80 + index * 35
                }))
        ),
        ...(input.warningDiagnostic
            ? [toSeedDiagnosticEnvelope({
                runId: controlRunId,
                distributedRunId,
                agent: input.agents[1] ?? input.agents[0],
                commandId: toSeedCommandId('start', input.agents[1] ?? input.agents[0]),
                atEpochMs: startedAtEpochMs + 240,
                severity: 'warning',
                message: SYNTHETIC_WARNING_DIAGNOSTIC_MESSAGE
            })]
            : []),
        ...input.agents
            .filter((agent) => !agent.startOk)
            .map((agent) =>
                toSeedDiagnosticEnvelope({
                    runId: controlRunId,
                    distributedRunId,
                    agent,
                    commandId: toSeedCommandId('start', agent),
                    atEpochMs: startedAtEpochMs + agent.startDurationMs,
                    severity: 'error',
                    message: agent.failureMessage ?? SYNTHETIC_COMMAND_FAILURE_MESSAGE
                })
            )
    ];
    return events;
}

function toSeedControlRun(evidence: SeedEvidenceInput): ControlRunSnapshot {
    const { input, schedule, controlRunId, distributedRunId } = evidence;
    const { stagedAtEpochMs, startedAtEpochMs, generatedAtEpochMs, createdAtEpochMs } = schedule;
    const controlRun: ControlRunSnapshot = {
        runId: controlRunId,
        createdAtEpochMs,
        updatedAtEpochMs: generatedAtEpochMs,
        agents: input.agents.map((agent) =>
            toSeedAgentSnapshot({
                runId: controlRunId,
                agent,
                updatedAtEpochMs: generatedAtEpochMs,
                completedCommandIds: [
                    toSeedCommandId('stage', agent),
                    toSeedCommandId('start', agent)
                ]
            })
        ),
        commands: toSeedCommands(evidence),
        results: toSeedResults(evidence),
        events: toSeedEvents(evidence),
        stats: [],
        reports: [],
        heartbeats: []
    };
    return controlRun;
}
