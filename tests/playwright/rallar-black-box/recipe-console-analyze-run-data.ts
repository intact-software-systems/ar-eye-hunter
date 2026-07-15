import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

export const ANALYZE_CONTROL_RUN_ID = 'analyze-control-ci';
export const ANALYZE_DISTRIBUTED_RUN_ID = 'analyze-distributed-ci';
export const ANALYZE_AGENT_ID = 'analyze-agent-eu-1';
export const ANALYZE_RECIPE_ID = 'analyze-rtc-relay';
export const ANALYZE_COMMAND_ID = 'analyze-send-relay';
export const ANALYZE_FAILURE_MESSAGE = 'TURN relay allocation failed for receiver.';
export const ANALYZE_DIAGNOSTIC_MESSAGE = 'Relay allocation missing in eu-north.';
export const ANALYZE_RESULT_FAILURE_CODE = 'RALLAR_BLACK_BOX_COMMAND_FAILED';
export const ANALYZE_RESULT_FAILURE_NAME = 'RALLAR_BLACK_BOX_TIMEOUT';
export const ANALYZE_RESULT_FAILURE_MESSAGE =
    'Rallar black-box command timeout reached.';
export const ANALYZE_RESULT_FAILURE_STACK = [
    `${ANALYZE_RESULT_FAILURE_NAME}: ${ANALYZE_RESULT_FAILURE_MESSAGE}`,
    ' at _t (https://blackbox.rallar.intactss.com/headless/assets/index-DG6wNwRv.js:1:50131)',
    ' at https://blackbox.rallar.intactss.com/headless/assets/index-DG6wNwRv.js:1:62093',
].join('\n');
export const ANALYZE_BASE_EPOCH_MS = 2_100_000_000_000;
export const ANALYZE_GENERATED_AT_EPOCH_MS = 2_100_000_001_000;
export const ANALYZE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=analyze' +
    '&applicationId=rallar-server&workspaceId=default&roomId=analyze-ci';
export const ANALYZE_CONTROL_ROUTE =
    `${ANALYZE_ROUTE}&controlRunId=${ANALYZE_CONTROL_RUN_ID}` +
    `&distributedRunId=${ANALYZE_DISTRIBUTED_RUN_ID}`;

export function createAnalyzeManifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: ANALYZE_DISTRIBUTED_RUN_ID,
        controlRunId: ANALYZE_CONTROL_RUN_ID,
        displayName: 'Analyze CI relay failure',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'analyze-ci',
        },
        recipes: [{
            recipeId: ANALYZE_RECIPE_ID,
            recipe: {
                schemaVersion: 1,
                recipeId: ANALYZE_RECIPE_ID,
                name: 'Analyze RTC relay',
                commands: [{ kind: 'health', commandId: ANALYZE_COMMAND_ID }],
            },
            required: true,
        }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: [ANALYZE_AGENT_ID],
            expectedParticipantCount: 1,
        },
        roleAssignments: [{
            agentId: ANALYZE_AGENT_ID,
            role: 'receiver',
            recipeIds: [ANALYZE_RECIPE_ID],
            required: true,
        }],
        startMode: 'manual',
    };
}

export function createAnalyzeDistributedRun(): ControlDistributedRunSnapshot {
    const manifest = createAnalyzeManifest();
    return {
        distributedRunId: ANALYZE_DISTRIBUTED_RUN_ID,
        controlRunId: ANALYZE_CONTROL_RUN_ID,
        manifest,
        state: 'failed',
        createdAtEpochMs: ANALYZE_BASE_EPOCH_MS,
        updatedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 1_600,
        startedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 250,
        completedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 1_600,
        targetAgentIds: [ANALYZE_AGENT_ID],
        commandLinks: [{
            phase: 'start',
            agentId: ANALYZE_AGENT_ID,
            commandId: ANALYZE_COMMAND_ID,
            recipeId: ANALYZE_RECIPE_ID,
            role: 'receiver',
            queuedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 280,
        }],
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: 1,
                passedParticipants: 0,
                failedParticipants: 1,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 0,
                failedRecipes: 1,
                blockingFailures: 1,
            },
            failures: [{
                kind: 'command',
                key: `command:${ANALYZE_COMMAND_ID}`,
                state: 'failed',
                agentId: ANALYZE_AGENT_ID,
                recipeId: ANALYZE_RECIPE_ID,
                commandId: ANALYZE_COMMAND_ID,
                error: {
                    code: 'RTC_NO_RELAY',
                    message: ANALYZE_FAILURE_MESSAGE,
                },
                atEpochMs: ANALYZE_BASE_EPOCH_MS + 1_500,
            }],
        },
    };
}

export function createAnalyzeControlRun(): ControlRunSnapshot {
    return {
        runId: ANALYZE_CONTROL_RUN_ID,
        createdAtEpochMs: ANALYZE_BASE_EPOCH_MS,
        updatedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 1_600,
        agents: [{
            runId: ANALYZE_CONTROL_RUN_ID,
            agentId: ANALYZE_AGENT_ID,
            connected: true,
            registeredAtEpochMs: ANALYZE_BASE_EPOCH_MS,
            lastSeenAtEpochMs: ANALYZE_BASE_EPOCH_MS + 1_500,
            status: 'connected',
            identity: {
                principalId: 'analyze-principal',
                sessionId: 'analyze-session',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'analyze-ci',
                region: 'eu-north',
                providerMode: 'browser-rallar',
            },
            connectionSequence: 3,
            reconnectCount: 2,
            receivedResultCount: 1,
            receivedEventCount: 3,
            completedCommandIds: [ANALYZE_COMMAND_ID],
            resumeCompletedCommandIds: [],
        }],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}
