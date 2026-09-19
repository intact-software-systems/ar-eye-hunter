import type { ControlDistributedRunArtifactBundle, ControlDistributedRunSnapshot, ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    type DistributedRecipeCatalogItem
} from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '../../../shared-test/rallar-bb-test/assert/assert-value-operators.ts';
import type {
    RallarBlackBoxControlAgentCapabilities,
    RallarBlackBoxControlAgentIdentity
} from '../../../shared-test/rallar-bb-test/distributed-run.ts';

export const FULL_MESSAGING_CAPABILITY: RallarBlackBoxControlAgentCapabilities['messaging'] = {
    supported: true,
    carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'],
    faults: true,
    storageCounters: true,
    reload: true
};

export const FULL_ASSERTIONS_CAPABILITY: RallarBlackBoxControlAgentCapabilities['assertions'] = {
    absence: true,
    untilLoop: true,
    operators: RALLAR_BLACK_BOX_ASSERT_OPERATORS
};

export const AGENT_A_IDENTITY: RallarBlackBoxControlAgentIdentity = {
    principalId: 'alice',
    sessionId: 'session-a',
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'bb-group',
    sessionLabel: 'alice:session-a',
    updatedAtEpochMs: 1_000
};

export const runSnapshot: ControlRunSnapshot = {
    runId: 'run-1',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
    agents: [
        {
            runId: 'run-1',
            agentId: 'agent-a',
            connected: true,
            lastHeartbeatAtEpochMs: 2_000,
            identity: AGENT_A_IDENTITY,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: []
        },
        {
            runId: 'run-1',
            agentId: 'agent-b',
            connected: false,
            lastHeartbeatAtEpochMs: 1_900,
            identity: {
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
                sessionLabel: 'bob:session-b',
                updatedAtEpochMs: 1_000
            },
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: []
        },
        {
            runId: 'run-1',
            agentId: 'agent-c',
            connected: true,
            lastHeartbeatAtEpochMs: 2_000,
            identity: {
                principalId: 'carol',
                sessionId: 'session-c',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'other-group',
                sessionLabel: 'carol:session-c',
                updatedAtEpochMs: 1_000
            },
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: []
        }
    ],
    commands: [],
    results: [],
    events: [],
    stats: [],
    reports: [],
    heartbeats: []
};

export const recipe: DistributedRecipeCatalogItem = {
    itemId: 'health',
    title: 'Health',
    description: 'Health smoke.',
    providerMode: 'browser-rallar',
    profiles: ['smoke'],
    prerequisites: ['connected agents'],
    live: false,
    source: 'app-local',
    recipe: {
        schemaVersion: 1,
        recipeId: 'health-only',
        commands: [{ kind: 'health' }]
    }
};

export const distributedRun: ControlDistributedRunSnapshot = {
    distributedRunId: 'dist-1',
    controlRunId: 'run-1',
    state: 'failed',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_200,
    stagedAtEpochMs: 1_100,
    startedAtEpochMs: 1_500,
    completedAtEpochMs: 2_200,
    targetAgentIds: ['agent-a', 'agent-b'],
    manifest: {
        schemaVersion: 1,
        distributedRunId: 'dist-1',
        controlRunId: 'run-1',
        displayName: 'Health distributed',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [{
            recipeId: 'health-only',
            recipe: recipe.recipe,
            profile: 'smoke',
            variables: {}
        }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-a', 'agent-b'],
            expectedParticipantCount: 2
        },
        roleAssignments: [
            { agentId: 'agent-a', role: 'sender', variables: {}, recipeIds: [] },
            { agentId: 'agent-b', role: 'receiver', variables: {}, recipeIds: [] }
        ],
        metadata: {
            createdBy: 'alice'
        },
        variables: {},
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: []
    },
    commandLinks: [
        { phase: 'stage', agentId: 'agent-a', commandId: 'stage-a', recipeId: 'health-only', queuedAtEpochMs: 1_110 },
        { phase: 'stage', agentId: 'agent-b', commandId: 'stage-b', recipeId: 'health-only', queuedAtEpochMs: 1_120 },
        { phase: 'start', agentId: 'agent-a', commandId: 'start-a', recipeId: 'health-only', queuedAtEpochMs: 1_510 },
        { phase: 'start', agentId: 'agent-b', commandId: 'start-b', recipeId: 'health-only', queuedAtEpochMs: 1_520 }
    ],
    rollup: {
        state: 'failed',
        ok: false,
        summary: {
            participants: 2,
            readyParticipants: 2,
            passedParticipants: 1,
            failedParticipants: 1,
            recipes: 1,
            passedRecipes: 0,
            failedRecipes: 1,
            groupAssertions: 0,
            passedGroupAssertions: 0,
            failedGroupAssertions: 0,
            blockingFailures: 1
        },
        failures: [{
            kind: 'recipe',
            key: 'health-only',
            state: 'failed',
            error: {
                code: 'RECIPE_FAILED',
                message: 'Receiver did not observe payload.'
            }
        }]
    }
};

export const distributedControlRun: ControlRunSnapshot = {
    ...runSnapshot,
    commands: [
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'stage-a',
                command: { kind: 'recipe.load', recipe: recipe.recipe }
            },
            queuedAtEpochMs: 1_110,
            dispatchedAtEpochMs: 1_130,
            completedAtEpochMs: 1_210,
            dispatchCount: 1
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-b',
                commandId: 'stage-b',
                command: { kind: 'recipe.load', recipe: recipe.recipe }
            },
            queuedAtEpochMs: 1_120,
            dispatchedAtEpochMs: 1_140,
            completedAtEpochMs: 1_230,
            dispatchCount: 1
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'start-a',
                command: { kind: 'recipe.run', recipe: recipe.recipe }
            },
            queuedAtEpochMs: 1_510,
            dispatchedAtEpochMs: 1_530,
            completedAtEpochMs: 1_900,
            dispatchCount: 1
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-b',
                commandId: 'start-b',
                command: { kind: 'recipe.run', recipe: recipe.recipe }
            },
            queuedAtEpochMs: 1_520,
            dispatchedAtEpochMs: 1_540,
            completedAtEpochMs: 2_000,
            dispatchCount: 1
        }
    ],
    results: [
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-a',
            commandId: 'stage-a',
            ok: true,
            result: {
                commandId: 'stage-a',
                kind: 'recipe.load',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_130,
                endedAtEpochMs: 1_210,
                durationMs: 80
            }
        },
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-b',
            commandId: 'stage-b',
            ok: true,
            result: {
                commandId: 'stage-b',
                kind: 'recipe.load',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_140,
                endedAtEpochMs: 1_230,
                durationMs: 90
            }
        },
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-a',
            commandId: 'start-a',
            ok: true,
            result: {
                commandId: 'start-a',
                kind: 'recipe.run',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_530,
                endedAtEpochMs: 1_900,
                durationMs: 370
            }
        },
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-b',
            commandId: 'start-b',
            ok: false,
            error: {
                code: 'ASSERTION_FAILED',
                message: 'No received payload.'
            },
            result: {
                commandId: 'start-b',
                kind: 'recipe.run',
                status: 'failed',
                ok: false,
                startedAtEpochMs: 1_540,
                endedAtEpochMs: 2_000,
                durationMs: 460,
                error: {
                    code: 'ASSERTION_FAILED',
                    message: 'No received payload.'
                }
            }
        }
    ],
    events: [{
        kind: 'event',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-a',
        commandId: 'start-a',
        eventId: 'message-a',
        atEpochMs: 1_700,
        payload: {
            distributedRunId: 'dist-1',
            topic: 'message.received',
            message: 'payload received'
        }
    }]
};

export const distributedArtifactBundle: ControlDistributedRunArtifactBundle = {
    artifactSchemaVersion: 1,
    distributedRunId: 'dist-1',
    generatedAtEpochMs: 2_500,
    files: {
        'distributed-run.json': JSON.stringify(distributedRun),
        'manifest.json': JSON.stringify(distributedRun.manifest),
        'control-run.json': JSON.stringify(distributedControlRun)
    }
};
