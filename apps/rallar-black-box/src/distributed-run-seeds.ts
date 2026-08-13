import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRollup,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
} from '@shared-test/rallar-bb-test/types.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
} from './control-run-manager.ts';
import type {
    ControlEventEnvelope,
    ControlResultEnvelope,
} from '@shared-test/rallar-bb-test/control-protocol.ts';

export type DistributedRunSeedId =
    | 'passed-clean'
    | 'passed-warnings'
    | 'failed-command'
    | 'high-latency-rtc'
    | 'artifact-missing';

export type DistributedRunSeedMetadata = Readonly<{
    id: DistributedRunSeedId;
    label: string;
    description: string;
    artifactIntentionallyMissing?: boolean;
    evidenceDegraded?: boolean;
}>;

export type SyntheticDistributedRunSeed = DistributedRunSeedMetadata & Readonly<{
    source: 'synthetic';
    generatedAtEpochMs: number;
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
}>;

type SeedAgentInput = Readonly<{
    agentId: string;
    principalId: string;
    role: string;
    stageDurationMs: number;
    startDurationMs: number;
    startOk: boolean;
    eventCount: number;
    failureMessage?: string;
}>;

type SeedBuildInput = DistributedRunSeedMetadata & Readonly<{
    state: ControlDistributedRunSnapshot['state'];
    ok: boolean;
    agents: readonly SeedAgentInput[];
    warningDiagnostic?: boolean;
    omitArtifact?: boolean;
}>;

const SEED_BASE_EPOCH_MS = 1_900_000_000_000;

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
                    distributedRunSeed: true,
                },
                roomId: 'seed-room',
            },
        },
        {
            kind: 'wait',
            commandId: 'seed-receive',
            match: {
                topic: 'synthetic.rtc.payload.received',
            },
            timeoutMs: 2_000,
        },
    ],
};

export const DISTRIBUTED_RUN_SEEDS: readonly DistributedRunSeedMetadata[] = [
    {
        id: 'passed-clean',
        label: 'Passed clean',
        description: 'Two synthetic agents complete the recipe with valid artifact evidence.',
    },
    {
        id: 'passed-warnings',
        label: 'Passed with evidence warning',
        description: 'The run passes, but includes a runtime warning diagnostic for review.',
        evidenceDegraded: true,
    },
    {
        id: 'failed-command',
        label: 'Failed command',
        description: 'The receiver command fails after missing the expected RTC payload.',
    },
    {
        id: 'high-latency-rtc',
        label: 'High latency RTC',
        description: 'Three agents pass with high per-agent RTC timing variance.',
    },
    {
        id: 'artifact-missing',
        label: 'Artifact missing',
        description: 'The run passes, but no distributed artifact bundle is loaded.',
        artifactIntentionallyMissing: true,
        evidenceDegraded: true,
    },
];

const SEED_IDS = new Set(DISTRIBUTED_RUN_SEEDS.map(seed => seed.id));

export function distributedRunSeedIdFromValue(
    value: string | null | undefined,
): DistributedRunSeedId | undefined {
    return value && SEED_IDS.has(value as DistributedRunSeedId)
        ? value as DistributedRunSeedId
        : undefined;
}

export function createSyntheticDistributedRunSeed(
    id: DistributedRunSeedId,
): SyntheticDistributedRunSeed {
    const metadata = DISTRIBUTED_RUN_SEEDS.find(seed => seed.id === id);
    if (!metadata) {
        throw new Error(`Unknown distributed run seed: ${id}`);
    }

    switch (id) {
        case 'passed-clean':
            return buildSeed({
                ...metadata,
                state: 'passed',
                ok: true,
                agents: [
                    seedAgent('seed-agent-a', 'alice', 'sender', 80, 170, true, 2),
                    seedAgent('seed-agent-b', 'bob', 'receiver', 90, 190, true, 2),
                ],
            });
        case 'passed-warnings':
            return buildSeed({
                ...metadata,
                state: 'passed',
                ok: true,
                warningDiagnostic: true,
                agents: [
                    seedAgent('seed-agent-a', 'alice', 'sender', 80, 170, true, 2),
                    seedAgent('seed-agent-b', 'bob', 'receiver', 90, 190, true, 2),
                ],
            });
        case 'failed-command':
            return buildSeed({
                ...metadata,
                state: 'failed',
                ok: false,
                agents: [
                    seedAgent('seed-agent-a', 'alice', 'sender', 80, 170, true, 2),
                    seedAgent(
                        'seed-agent-b',
                        'bob',
                        'receiver',
                        90,
                        520,
                        false,
                        0,
                        'Receiver did not observe the RTC payload.',
                    ),
                ],
            });
        case 'high-latency-rtc':
            return buildSeed({
                ...metadata,
                state: 'passed',
                ok: true,
                agents: [
                    seedAgent('seed-agent-a', 'alice', 'sender', 95, 130, true, 3),
                    seedAgent('seed-agent-b', 'bob', 'receiver', 980, 1_040, true, 3),
                    seedAgent('seed-agent-c', 'cara', 'observer', 1_120, 1_260, true, 3),
                ],
            });
        case 'artifact-missing':
            return buildSeed({
                ...metadata,
                state: 'passed',
                ok: true,
                omitArtifact: true,
                agents: [
                    seedAgent('seed-agent-a', 'alice', 'sender', 80, 170, true, 2),
                    seedAgent('seed-agent-b', 'bob', 'receiver', 90, 190, true, 2),
                ],
            });
    }
}

function seedAgent(
    agentId: string,
    principalId: string,
    role: string,
    stageDurationMs: number,
    startDurationMs: number,
    startOk: boolean,
    eventCount: number,
    failureMessage?: string,
): SeedAgentInput {
    return {
        agentId,
        principalId,
        role,
        stageDurationMs,
        startDurationMs,
        startOk,
        eventCount,
        failureMessage,
    };
}

function buildSeed(input: SeedBuildInput): SyntheticDistributedRunSeed {
    const distributedRunId = `seed-${input.id}`;
    const controlRunId = `seed-control-${input.id}`;
    const createdAtEpochMs = SEED_BASE_EPOCH_MS + 1_000;
    const stagedAtEpochMs = createdAtEpochMs + 100;
    const startedAtEpochMs = createdAtEpochMs + 500;
    const lastStartResultEpochMs = Math.max(
        ...input.agents.map(agent =>
            startedAtEpochMs + agentOffset(agent) + 20 + agent.startDurationMs
        ),
    );
    const completedAtEpochMs = lastStartResultEpochMs + 50;
    const generatedAtEpochMs = completedAtEpochMs + 300;
    const manifest = seedManifest({
        distributedRunId,
        controlRunId,
        seedId: input.id,
        agents: input.agents,
    });
    const commandLinks = input.agents.flatMap(agent => [
        commandLink('stage', agent, stagedAtEpochMs + agentOffset(agent), manifest.recipes[0]?.recipeId),
        commandLink('start', agent, startedAtEpochMs + agentOffset(agent), manifest.recipes[0]?.recipeId),
    ]);
    const commands = input.agents.flatMap(agent => [
        queuedCommand({
            runId: controlRunId,
            agent,
            phase: 'stage',
            queuedAtEpochMs: stagedAtEpochMs + agentOffset(agent),
            durationMs: agent.stageDurationMs,
            command: { kind: 'recipe.load', recipe: SEED_RECIPE },
        }),
        queuedCommand({
            runId: controlRunId,
            agent,
            phase: 'start',
            queuedAtEpochMs: startedAtEpochMs + agentOffset(agent),
            durationMs: agent.startDurationMs,
            command: { kind: 'recipe.run', recipe: SEED_RECIPE },
        }),
    ]);
    const results = input.agents.flatMap(agent => [
        resultEnvelope({
            runId: controlRunId,
            agent,
            commandId: commandId('stage', agent),
            kind: 'recipe.load',
            startedAtEpochMs: stagedAtEpochMs + agentOffset(agent) + 20,
            durationMs: agent.stageDurationMs,
            ok: true,
        }),
        resultEnvelope({
            runId: controlRunId,
            agent,
            commandId: commandId('start', agent),
            kind: 'recipe.run',
            startedAtEpochMs: startedAtEpochMs + agentOffset(agent) + 20,
            durationMs: agent.startDurationMs,
            ok: agent.startOk,
            errorMessage: agent.failureMessage,
        }),
    ]);
    const events = [
        ...input.agents.flatMap(agent =>
            Array.from({ length: agent.eventCount }, (_, index) =>
                eventEnvelope({
                    runId: controlRunId,
                    distributedRunId,
                    agent,
                    commandId: commandId('start', agent),
                    index,
                    atEpochMs: startedAtEpochMs + agentOffset(agent) + 80 + index * 35,
                })
            )
        ),
        ...(input.warningDiagnostic
            ? [diagnosticEnvelope({
                runId: controlRunId,
                distributedRunId,
                agent: input.agents[1] ?? input.agents[0],
                commandId: commandId('start', input.agents[1] ?? input.agents[0]),
                atEpochMs: startedAtEpochMs + 240,
            })]
            : []),
        ...input.agents
            .filter(agent => !agent.startOk)
            .map(agent => diagnosticEnvelope({
                runId: controlRunId,
                distributedRunId,
                agent,
                commandId: commandId('start', agent),
                atEpochMs: startedAtEpochMs + agent.startDurationMs,
                severity: 'error',
                message: agent.failureMessage ?? 'Synthetic command failed.',
            })),
    ];
    const controlRun: ControlRunSnapshot = {
        runId: controlRunId,
        createdAtEpochMs,
        updatedAtEpochMs: generatedAtEpochMs,
        agents: input.agents.map(agent => agentSnapshot({
            runId: controlRunId,
            agent,
            updatedAtEpochMs: generatedAtEpochMs,
            completedCommandIds: [
                commandId('stage', agent),
                commandId('start', agent),
            ],
        })),
        commands,
        results,
        events,
        stats: [],
        reports: [],
        heartbeats: [],
    };
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
        targetAgentIds: input.agents.map(agent => agent.agentId),
        commandLinks,
        rollup: rollup(input),
    };
    const artifactBundle = input.omitArtifact
        ? undefined
        : distributedArtifactBundle({
            distributedRun,
            controlRun,
            generatedAtEpochMs,
        });

    return {
        ...input,
        source: 'synthetic',
        generatedAtEpochMs,
        distributedRun,
        controlRun,
        artifactBundle,
    };
}

function seedManifest(input: Readonly<{
    distributedRunId: string;
    controlRunId: string;
    seedId: DistributedRunSeedId;
    agents: readonly SeedAgentInput[];
}>): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: `Synthetic ${input.seedId}`,
        description: 'Synthetic distributed run evidence for rallar-black-box UI and browser QA.',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'seed-room',
        },
        recipes: [{
            recipeId: SEED_RECIPE.recipeId,
            recipe: SEED_RECIPE,
            profile: 'synthetic',
            required: true,
        }],
        targetPolicy: {
            mode: 'role-map',
            expectedParticipantCount: input.agents.length,
            roles: Object.fromEntries(
                input.agents.map(agent => [agent.role, [agent.agentId]]),
            ),
        },
        roleAssignments: input.agents.map(agent => ({
            agentId: agent.agentId,
            role: agent.role,
            required: true,
        })),
        ackTimeoutMs: 5_000,
        startMode: 'manual',
        metadata: {
            synthetic: true,
            seedId: input.seedId,
        },
    };
}

function commandLink(
    phase: ControlDistributedRunCommandLink['phase'],
    agent: SeedAgentInput,
    queuedAtEpochMs: number,
    recipeId?: string,
): ControlDistributedRunCommandLink {
    return {
        phase,
        agentId: agent.agentId,
        commandId: commandId(phase, agent),
        recipeId,
        role: agent.role,
        queuedAtEpochMs,
    };
}

function queuedCommand(input: Readonly<{
    runId: string;
    agent: SeedAgentInput;
    phase: 'stage' | 'start';
    queuedAtEpochMs: number;
    durationMs: number;
    command: ControlQueuedCommandSnapshot['envelope']['command'];
}>): ControlQueuedCommandSnapshot {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: input.runId,
            agentId: input.agent.agentId,
            commandId: commandId(input.phase, input.agent),
            command: input.command,
        },
        queuedAtEpochMs: input.queuedAtEpochMs,
        dispatchedAtEpochMs: input.queuedAtEpochMs + 20,
        completedAtEpochMs: input.queuedAtEpochMs + 20 + input.durationMs,
        dispatchCount: 1,
    };
}

function resultEnvelope(input: Readonly<{
    runId: string;
    agent: SeedAgentInput;
    commandId: string;
    kind: RallarBlackBoxTestResult['kind'];
    startedAtEpochMs: number;
    durationMs: number;
    ok: boolean;
    errorMessage?: string;
}>): ControlResultEnvelope {
    const error = input.ok
        ? undefined
        : {
            code: 'SYNTHETIC_ASSERTION_FAILED',
            message: input.errorMessage ?? 'Synthetic command failed.',
        };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: input.commandId,
        ok: input.ok,
        ...(error ? { error } : {}),
        result: {
            commandId: input.commandId,
            kind: input.kind,
            status: input.ok ? 'ok' : 'failed',
            ok: input.ok,
            startedAtEpochMs: input.startedAtEpochMs,
            endedAtEpochMs: input.startedAtEpochMs + input.durationMs,
            durationMs: input.durationMs,
            ...(error ? { error } : {}),
        },
    };
}

function eventEnvelope(input: Readonly<{
    runId: string;
    distributedRunId: string;
    agent: SeedAgentInput;
    commandId: string;
    index: number;
    atEpochMs: number;
}>): ControlEventEnvelope {
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
            commandId: input.commandId,
        },
    };
}

function diagnosticEnvelope(input: Readonly<{
    runId: string;
    distributedRunId: string;
    agent: SeedAgentInput;
    commandId: string;
    atEpochMs: number;
    severity?: 'warning' | 'error';
    message?: string;
}>): ControlEventEnvelope {
    const severity = input.severity ?? 'warning';
    return {
        kind: 'diagnostic',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: input.commandId,
        eventId: `${input.commandId}-${severity}-diagnostic`,
        atEpochMs: input.atEpochMs,
        payload: {
            distributedRunId: input.distributedRunId,
            topic: 'rallar.browser.realtime.synthetic_seed',
            diagnosticTypeId: 'synthetic-seed',
            severity,
            transport: 'messages.rtc',
            message: input.message ?? 'Synthetic RTC evidence includes a warning diagnostic.',
            commandId: input.commandId,
            agentId: input.agent.agentId,
            roomId: 'seed-room',
        },
    };
}

function agentSnapshot(input: Readonly<{
    runId: string;
    agent: SeedAgentInput;
    updatedAtEpochMs: number;
    completedCommandIds: readonly string[];
}>): ControlAgentSnapshot {
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
            tags: ['synthetic', input.agent.role],
            capabilities: {
                crdt: {
                    supported: true,
                    transports: ['rtc', 'ws-then-rtc'],
                    runtimeSurface: 'browser-rallar',
                    apiBaseUrlConfigured: true,
                },
            },
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: input.completedCommandIds.length,
        receivedEventCount: input.agent.eventCount,
        completedCommandIds: input.completedCommandIds,
        resumeCompletedCommandIds: input.completedCommandIds,
    };
}

function rollup(input: SeedBuildInput): RallarBlackBoxDistributedRunRollup {
    const failedAgents = input.agents.filter(agent => !agent.startOk);
    return {
        state: input.state,
        ok: input.ok,
        summary: {
            participants: input.agents.length,
            requiredParticipants: input.agents.length,
            readyParticipants: input.agents.length,
            passedParticipants: input.agents.length - failedAgents.length,
            failedParticipants: failedAgents.length,
            recipes: 1,
            requiredRecipes: 1,
            passedRecipes: input.ok ? 1 : 0,
            failedRecipes: input.ok ? 0 : 1,
            groupAssertions: 0,
            passedGroupAssertions: 0,
            failedGroupAssertions: 0,
            blockingFailures: failedAgents.length,
        },
        failures: failedAgents.map(agent => ({
            kind: 'recipe',
            key: SEED_RECIPE.recipeId,
            state: 'failed',
            required: true,
            error: {
                code: 'SYNTHETIC_RECIPE_FAILED',
                message: agent.failureMessage ?? 'Synthetic recipe failed.',
            },
        })),
    };
}

function distributedArtifactBundle(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
    generatedAtEpochMs: number;
}>): ControlDistributedRunArtifactBundle {
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
                ok: input.distributedRun.rollup.ok,
            }),
            'results.jsonl': input.controlRun.results
                .map(result => JSON.stringify(result))
                .join('\n'),
            'events.jsonl': input.controlRun.events
                .map(event => JSON.stringify(event))
                .join('\n'),
            'failures.json': JSON.stringify(input.distributedRun.rollup.failures),
            'metadata.json': JSON.stringify({
                synthetic: true,
                generatedAtEpochMs: input.generatedAtEpochMs,
            }),
        },
    };
}

function commandId(
    phase: 'stage' | 'start' | 'barrier' | 'cancel',
    agent: SeedAgentInput,
): string {
    return `seed-${phase}-${agent.role}`;
}

function agentOffset(agent: SeedAgentInput): number {
    return agent.agentId.charCodeAt(agent.agentId.length - 1) * 5;
}
