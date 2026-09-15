import type {
    ControlEventEnvelope,
    ControlResultEnvelope
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

export const TUNE_BASE_EPOCH_MS = 2_200_000_000_000;
export const TUNE_LEFT_CONTROL_RUN_ID = 'tune-control-baseline';
export const TUNE_RIGHT_CONTROL_RUN_ID = 'tune-control-candidate';
export const TUNE_LEFT_RUN_ID = 'tune-distributed-baseline';
export const TUNE_RIGHT_RUN_ID = 'tune-distributed-candidate';
export const TUNE_STREAM_RECIPE_ID = 'tune-rtc-stream';
export const TUNE_STREAM_COMMAND_ID = 'tune-stream-frames';
export const TUNE_SHARED_AGENT_ID = 'tune-agent-shared';
export const TUNE_LEFT_AGENT_ID = 'tune-agent-baseline';
export const TUNE_SLOW_AGENT_ID = 'tune-agent-slow';
export const TUNE_ROUTE = '/?provider=simulated&v=1&experience=recipe-console&view=tune';
export const TUNE_ANALYZE_ROUTE = '/?provider=simulated&v=1&experience=recipe-console&view=analyze';
export const TUNE_COMPARE_ROUTE = `${TUNE_ROUTE}` +
    `&controlRunId=${TUNE_RIGHT_CONTROL_RUN_ID}` +
    `&distributedRunId=${TUNE_RIGHT_RUN_ID}` +
    `&compareLeft=${TUNE_LEFT_RUN_ID}` +
    `&compareRight=${TUNE_RIGHT_RUN_ID}` +
    '&timingMetric=stream-send-duration';

export function createTuneManifest(
    side: 'left' | 'right'
): RallarBlackBoxDistributedRunManifest {
    const right = side === 'right';
    const controlRunId = right
        ? TUNE_RIGHT_CONTROL_RUN_ID
        : TUNE_LEFT_CONTROL_RUN_ID;
    const distributedRunId = right ? TUNE_RIGHT_RUN_ID : TUNE_LEFT_RUN_ID;
    return {
        schemaVersion: 1,
        distributedRunId,
        controlRunId,
        displayName: right ? 'RTC stream candidate' : 'RTC stream baseline',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-ci'
        },
        recipes: [{
            recipeId: TUNE_STREAM_RECIPE_ID,
            profile: right ? 'candidate' : 'baseline',
            recipe: {
                schemaVersion: 1,
                recipeId: TUNE_STREAM_RECIPE_ID,
                name: 'Tune RTC stream',
                commands: [{
                    kind: 'rtc.stream',
                    commandId: TUNE_STREAM_COMMAND_ID,
                    send: { type: 'tune.frame', payload: { sequence: 1 } },
                    durationMs: 1_000,
                    rateHz: right ? 30 : 20,
                    maxInFlight: 2,
                    thresholds: {
                        minSendSuccessRatio: 0.98,
                        maxDroppedFrames: 0,
                        maxBackpressureCount: 0,
                        maxP95SendDurationMs: 40,
                        maxP99SendDurationMs: 50,
                        maxAverageStartDriftMs: 8,
                        maxStartDriftMs: 16,
                        maxJitterMs: 8
                    }
                }]
            },
            required: true
        }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: right
                ? [TUNE_SHARED_AGENT_ID, TUNE_SLOW_AGENT_ID]
                : [TUNE_SHARED_AGENT_ID, TUNE_LEFT_AGENT_ID],
            expectedParticipantCount: 2
        },
        ackTimeoutMs: right ? 12_000 : 8_000,
        barrier: { enabled: true, timeoutMs: right ? 16_000 : 10_000 },
        startMode: 'manual'
    };
}

export function createTuneDistributedRun(
    side: 'left' | 'right'
): ControlDistributedRunSnapshot {
    const right = side === 'right';
    const manifest = createTuneManifest(side);
    const controlRunId = right
        ? TUNE_RIGHT_CONTROL_RUN_ID
        : TUNE_LEFT_CONTROL_RUN_ID;
    const distributedRunId = right ? TUNE_RIGHT_RUN_ID : TUNE_LEFT_RUN_ID;
    const targetAgentIds = right
        ? [TUNE_SHARED_AGENT_ID, TUNE_SLOW_AGENT_ID]
        : [TUNE_SHARED_AGENT_ID, TUNE_LEFT_AGENT_ID];
    return {
        distributedRunId,
        controlRunId,
        manifest,
        state: right ? 'failed' : 'passed',
        createdAtEpochMs: TUNE_BASE_EPOCH_MS,
        updatedAtEpochMs: TUNE_BASE_EPOCH_MS + (right ? 4_800 : 6_000),
        startedAtEpochMs: TUNE_BASE_EPOCH_MS + 500,
        completedAtEpochMs: TUNE_BASE_EPOCH_MS + (right ? 4_800 : 6_000),
        targetAgentIds,
        targetResolution: {
            group: manifest.group,
            resolvedAtEpochMs: TUNE_BASE_EPOCH_MS + 200,
            staleAfterMs: 30_000,
            targetPolicyMode: 'selected-agents',
            targetAgentIds,
            roleAssignments: [],
            blockers: [],
            summary: {
                agents: 2,
                targetable: 2,
                selected: 2,
                expectedParticipantCount: 2,
                missingExpectedParticipants: 0,
                staleAgents: 0,
                offlineAgents: 0,
                wrongGroupAgents: 0,
                agentsWithoutIdentity: 0,
                roleCounts: {},
                regions: {},
                providers: {}
            }
        },
        commandLinks: targetAgentIds.map((agentId, index) => ({
            phase: 'start' as const,
            agentId,
            commandId: `${TUNE_STREAM_COMMAND_ID}-${index + 1}`,
            recipeId: TUNE_STREAM_RECIPE_ID,
            queuedAtEpochMs: TUNE_BASE_EPOCH_MS + 600 + index * 10
        })),
        rollup: {
            state: right ? 'failed' : 'passed',
            ok: !right,
            summary: {
                participants: 2,
                requiredParticipants: 2,
                readyParticipants: 2,
                passedParticipants: right ? 1 : 2,
                failedParticipants: right ? 1 : 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: right ? 0 : 1,
                failedRecipes: right ? 1 : 0,
                blockingFailures: right ? 1 : 0
            },
            failures: right
                ? [{
                    kind: 'recipe',
                    key: `${TUNE_STREAM_RECIPE_ID}:${TUNE_SLOW_AGENT_ID}`,
                    state: 'failed',
                    required: true,
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                        message: 'RTC stream exceeded pacing and backlog thresholds.'
                    }
                }]
                : []
        }
    };
}

export function createTuneControlRun(
    side: 'left' | 'right',
    detailedResult?: ControlResultEnvelope
): ControlRunSnapshot {
    const right = side === 'right';
    const runId = right ? TUNE_RIGHT_CONTROL_RUN_ID : TUNE_LEFT_CONTROL_RUN_ID;
    const agentIds = right
        ? [TUNE_SHARED_AGENT_ID, TUNE_SLOW_AGENT_ID]
        : [TUNE_SHARED_AGENT_ID, TUNE_LEFT_AGENT_ID];
    const commandIds = agentIds.map((_, index) => `${TUNE_STREAM_COMMAND_ID}-${index + 1}`);
    return {
        runId,
        createdAtEpochMs: TUNE_BASE_EPOCH_MS,
        updatedAtEpochMs: TUNE_BASE_EPOCH_MS + (right ? 4_800 : 6_000),
        agents: agentIds.map((agentId) => ({
            runId,
            agentId,
            connected: true,
            lastSeenAtEpochMs: TUNE_BASE_EPOCH_MS + 4_500,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 1,
            receivedEventCount: right ? 2 : 1,
            completedCommandIds: commandIds,
            resumeCompletedCommandIds: []
        })),
        commands: commandIds.map((commandId, index) => ({
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId,
                agentId: agentIds[index],
                commandId,
                command: {
                    kind: 'rtc.stream',
                    commandId,
                    send: { type: 'tune.frame' },
                    count: 3,
                    rateHz: 30
                }
            },
            queuedAtEpochMs: TUNE_BASE_EPOCH_MS + 600,
            dispatchedAtEpochMs: TUNE_BASE_EPOCH_MS + 700,
            completedAtEpochMs: TUNE_BASE_EPOCH_MS + (right
                ? index === 1 ? 1_900 : 1_100
                : index === 1
                ? 1_300
                : 1_000),
            dispatchCount: 1
        })),
        results: right && detailedResult ? [detailedResult] : [],
        events: right
            ? [
                messageEvent(runId, TUNE_SHARED_AGENT_ID, 'candidate message one'),
                messageEvent(runId, TUNE_SLOW_AGENT_ID, 'candidate message two')
            ]
            : [messageEvent(runId, TUNE_SHARED_AGENT_ID, 'baseline message')],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function messageEvent(
    runId: string,
    agentId: string,
    message: string
): ControlEventEnvelope {
    const commandIndex = agentId === TUNE_SHARED_AGENT_ID ? 1 : 2;
    return {
        kind: 'event',
        protocolVersion: 1,
        runId,
        agentId,
        commandId: `${TUNE_STREAM_COMMAND_ID}-${commandIndex}`,
        eventId: `${agentId}-${message.replaceAll(' ', '-')}`,
        atEpochMs: TUNE_BASE_EPOCH_MS + 2_000,
        payload: { topic: 'message.received', message, payload: { ok: true } }
    };
}
