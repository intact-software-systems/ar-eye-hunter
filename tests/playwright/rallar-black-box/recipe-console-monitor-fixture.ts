import type { BrowserContext, Route } from '@playwright/test';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    ControlEventEnvelope,
    ControlResultEnvelope,
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxDistributedRunState } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/types.ts';

export const MONITOR_CONTROL_RUN_ID = 'monitor-control-live';
export const MONITOR_DISTRIBUTED_RUN_ID = 'monitor-distributed-live';
export const MONITOR_FAILURE_AGENT_ID = 'monitor-agent-receiver';
export const MONITOR_FAILURE_RECIPE_ID = 'monitor-later-failure';
export const MONITOR_FAILURE_COMMAND_ID = 'monitor-start-receiver';
export const MONITOR_FAILURE_CODE = 'MONITOR_EXPECTED_PAYLOAD_MISSING';
export const MONITOR_FAILURE_MESSAGE =
    'Receiver missed the expected payload after the sender completed.';
export const MONITOR_DIAGNOSTIC_ID = 'monitor-diagnostic-receiver';
export const MONITOR_EVENT_ID = 'monitor-event-receiver';
export const MONITOR_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=monitor' +
    `&controlRunId=${MONITOR_CONTROL_RUN_ID}` +
    `&distributedRunId=${MONITOR_DISTRIBUTED_RUN_ID}` +
    '&applicationId=rallar-server&workspaceId=default&roomId=monitor-group';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const BASE_EPOCH_MS = 2_000_000_000_000;
const SENDER_ID = 'monitor-agent-sender';
const GROUP = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'monitor-group',
} as const;
const RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: MONITOR_FAILURE_RECIPE_ID,
    name: 'Later receiver failure',
    commands: [
        { kind: 'health', commandId: 'monitor-health' },
        {
            kind: 'wait',
            commandId: 'monitor-await-payload',
            match: { topic: 'monitor.payload.received' },
            timeoutMs: 1_200,
        },
    ],
};

type MonitorOperationalState = Extract<
    RallarBlackBoxDistributedRunState,
    'running' | 'passed' | 'failed' | 'timed-out' | 'cancelled'
>;

export type RecipeConsoleMonitorFixture = Readonly<{
    snapshot: ControlServerSnapshot;
    artifact: ControlDistributedRunArtifactBundle;
    failNextRunRead(): void;
    recoverRunReads(): void;
    failDistributedRunReads(): void;
    recoverDistributedRunReads(): void;
    deleteOnNextRunRead(): void;
    setRunState(state: MonitorOperationalState): void;
    setSingleAgentFailure(enabled?: boolean): void;
    setFailureAgentConnected(connected: boolean): void;
    setAdditionalEventCount(count: number): void;
    runRequestCount(): number;
    distributedRunRequestCount(): number;
    artifactRequestCount(): number;
    cancelRequestCount(): number;
}>;

export async function installRecipeConsoleMonitorFixture(
    context: BrowserContext,
): Promise<RecipeConsoleMonitorFixture> {
    const controlRun = createControlRun('failed', false, true, 0, 0);
    const distributedRun = createDistributedRun('failed', false, 0);
    const snapshot = { runs: [controlRun], distributedRuns: [distributedRun] };
    const artifact = createArtifact(distributedRun, controlRun);
    let runReads = 0;
    let distributedRunReads = 0;
    let artifactReads = 0;
    let cancelWrites = 0;
    let runReadsOffline = false;
    let distributedRunReadsOffline = false;
    let distributedRunDeleted = false;
    let operationalState: MonitorOperationalState = 'failed';
    let singleAgentFailure = false;
    let failureAgentConnected = true;
    let reconnectCount = 0;
    let additionalEventCount = 0;
    let revision = 0;

    await context.route(CONTROL_ROUTE, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders() });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            runReads += 1;
            if (runReadsOffline) {
                await route.abort('connectionfailed');
                return;
            }
            await fulfillJson(route, {
                runs: [createControlRun(
                    operationalState,
                    singleAgentFailure,
                    failureAgentConnected,
                    reconnectCount,
                    revision,
                    additionalEventCount,
                )],
            });
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/runs/${MONITOR_CONTROL_RUN_ID}`
        ) {
            if (runReadsOffline) {
                await route.abort('connectionfailed');
                return;
            }
            await fulfillJson(route, createControlRun(
                operationalState,
                singleAgentFailure,
                failureAgentConnected,
                reconnectCount,
                revision,
                additionalEventCount,
            ));
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            distributedRunReads += 1;
            if (distributedRunReadsOffline) {
                await route.abort('connectionfailed');
                return;
            }
            const distributedRuns = distributedRunDeleted ? [] : [
                createDistributedRun(operationalState, singleAgentFailure, revision),
            ];
            await fulfillJson(route, { distributedRuns });
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/distributed-runs/${MONITOR_DISTRIBUTED_RUN_ID}/artifacts`
        ) {
            artifactReads += 1;
            await fulfillJson(route, artifact);
            return;
        }
        if (
            request.method() === 'POST' &&
            url.pathname === `/distributed-runs/${MONITOR_DISTRIBUTED_RUN_ID}/cancel`
        ) {
            cancelWrites += 1;
            operationalState = 'cancelled';
            revision += 1;
            await fulfillJson(route, createDistributedRun(
                operationalState,
                singleAgentFailure,
                revision,
            ));
            return;
        }
        await fulfillJson(route, {
            error: `Unhandled ${request.method()} ${url.pathname}`,
        }, 404);
    });

    return {
        snapshot,
        artifact,
        failNextRunRead: () => { runReadsOffline = true; },
        recoverRunReads: () => { runReadsOffline = false; },
        failDistributedRunReads: () => { distributedRunReadsOffline = true; },
        recoverDistributedRunReads: () => { distributedRunReadsOffline = false; },
        deleteOnNextRunRead: () => { distributedRunDeleted = true; },
        setRunState: (state) => {
            operationalState = state;
            revision += 1;
        },
        setSingleAgentFailure: (enabled = true) => {
            singleAgentFailure = enabled;
            revision += 1;
        },
        setFailureAgentConnected: (connected) => {
            if (connected && !failureAgentConnected) reconnectCount += 1;
            failureAgentConnected = connected;
            revision += 1;
        },
        setAdditionalEventCount: (count) => {
            additionalEventCount = Math.max(0, Math.floor(count));
            revision += 1;
        },
        runRequestCount: () => runReads,
        distributedRunRequestCount: () => distributedRunReads,
        artifactRequestCount: () => artifactReads,
        cancelRequestCount: () => cancelWrites,
    };
}

function createControlRun(
    state: MonitorOperationalState,
    singleAgentFailure: boolean,
    failureAgentConnected: boolean,
    reconnectCount: number,
    revision: number,
    additionalEventCount = 0,
): ControlRunSnapshot {
    const agentIds = monitorAgentIds(singleAgentFailure);
    const specs = [
        ...agentIds.map((agentId, index) => (
            [agentId, 'stage', true, 100 + index * 20, 60 + index * 10] as const
        )),
        ...agentIds.map((agentId, index) => (
            [
                agentId,
                'start',
                state === 'passed' || agentId !== MONITOR_FAILURE_AGENT_ID,
                500 + index * 20,
                agentId === MONITOR_FAILURE_AGENT_ID ? 300 : 110,
            ] as const
        )),
    ];
    const completesStart = state === 'passed' || state === 'failed' || state === 'timed-out';
    const commands = specs.map(([agentId, phase, , offset, duration]) =>
        queuedCommand(agentId, phase, offset, duration, phase === 'stage' || completesStart)
    );
    const results = specs
        .filter(([, phase]) => phase === 'stage' || completesStart)
        .map(([agentId, phase, ok, offset, duration]) =>
            resultEnvelope(agentId, phase, ok, offset + 20, duration, state)
        );
    const events = monitorEvents(state, reconnectCount, additionalEventCount);
    return {
        runId: MONITOR_CONTROL_RUN_ID,
        createdAtEpochMs: BASE_EPOCH_MS,
        updatedAtEpochMs: BASE_EPOCH_MS + 900 + revision,
        agents: agentIds.map(agentId => agent(
            agentId,
            agentId === SENDER_ID ? 'sender' : 'receiver',
            state,
            agentId === MONITOR_FAILURE_AGENT_ID ? failureAgentConnected : true,
            agentId === MONITOR_FAILURE_AGENT_ID ? reconnectCount : 0,
            agentId === MONITOR_FAILURE_AGENT_ID ? additionalEventCount : 0,
        )),
        commands,
        results,
        events,
        stats: [], reports: [], heartbeats: [],
    };
}

function createDistributedRun(
    state: MonitorOperationalState,
    singleAgentFailure: boolean,
    revision: number,
): ControlDistributedRunSnapshot {
    const agentIds = monitorAgentIds(singleAgentFailure);
    const commandLinks = [
        ...agentIds.map((agentId, index) => (
            ['stage', agentId, 100 + index * 20] as const
        )),
        ...agentIds.map((agentId, index) => (
            ['start', agentId, 500 + index * 20] as const
        )),
    ];
    const terminal = state !== 'running';
    const terminalFailure = state === 'failed' || state === 'timed-out';
    const participantCount = agentIds.length;
    return {
        distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
        controlRunId: MONITOR_CONTROL_RUN_ID,
        state,
        createdAtEpochMs: BASE_EPOCH_MS,
        updatedAtEpochMs: BASE_EPOCH_MS + 900 + revision,
        stagedAtEpochMs: BASE_EPOCH_MS + 100,
        startedAtEpochMs: BASE_EPOCH_MS + 500,
        ...(terminal ? { completedAtEpochMs: BASE_EPOCH_MS + 900 + revision } : {}),
        ...(state === 'cancelled'
            ? { cancelledAtEpochMs: BASE_EPOCH_MS + 900 + revision }
            : {}),
        targetAgentIds: agentIds,
        manifest: {
            schemaVersion: 1,
            distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
            controlRunId: MONITOR_CONTROL_RUN_ID,
            displayName: 'Monitor deterministic later failure',
            group: GROUP,
            recipes: [{ recipeId: MONITOR_FAILURE_RECIPE_ID, recipe: RECIPE, required: true }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds,
                expectedParticipantCount: participantCount,
            },
            roleAssignments: agentIds.map(agentId => ({
                agentId,
                role: agentId === SENDER_ID ? 'sender' : 'receiver',
                recipeIds: [MONITOR_FAILURE_RECIPE_ID],
                required: true,
            })),
        },
        commandLinks: commandLinks.map(([phase, agentId, offset]) => ({
            phase,
            agentId,
            commandId: commandId(phase, agentId),
            recipeId: MONITOR_FAILURE_RECIPE_ID,
            role: agentId === SENDER_ID ? 'sender' : 'receiver',
            queuedAtEpochMs: BASE_EPOCH_MS + offset,
        })),
        rollup: {
            state, ok: state === 'passed',
            summary: {
                participants: participantCount,
                requiredParticipants: participantCount,
                readyParticipants: participantCount,
                passedParticipants: state === 'passed'
                    ? participantCount
                    : terminalFailure
                    ? Math.max(0, participantCount - 1)
                    : 0,
                failedParticipants: terminalFailure ? 1 : 0,
                recipes: 1, requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: terminalFailure ? 1 : 0,
                blockingFailures: terminalFailure ? 1 : 0,
            },
            failures: [],
        },
        ...(state === 'timed-out' ? {
            error: {
                code: 'MONITOR_DISTRIBUTED_RUN_TIMEOUT',
                message: 'The distributed run exceeded its execution deadline.',
            },
        } : {}),
    };
}

function agent(
    agentId: string,
    role: string,
    state: MonitorOperationalState,
    connected: boolean,
    reconnectCount: number,
    additionalEventCount: number,
): ControlAgentSnapshot {
    const completedCommandIds = state === 'running' || state === 'cancelled'
        ? [commandId('stage', agentId)]
        : [commandId('stage', agentId), commandId('start', agentId)];
    const failed = (state === 'failed' || state === 'timed-out') &&
        agentId === MONITOR_FAILURE_AGENT_ID;
    return {
        runId: MONITOR_CONTROL_RUN_ID, agentId, connected,
        registeredAtEpochMs: BASE_EPOCH_MS - 1_000,
        lastSeenAtEpochMs: BASE_EPOCH_MS + 900,
        lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 900,
        status: failed
            ? 'failed'
            : state === 'running'
            ? 'running'
            : state === 'cancelled'
            ? 'cancelled'
            : 'completed',
        identity: {
            principalId: `${agentId}-principal`, sessionId: `${agentId}-session`,
            ...GROUP, providerMode: 'browser-rallar', browserName: 'chromium',
            region: 'eu-north', tags: [role],
        },
        connectionSequence: reconnectCount + 1, reconnectCount,
        receivedResultCount: completedCommandIds.length,
        receivedEventCount: agentId === MONITOR_FAILURE_AGENT_ID
            ? (failed ? 2 : 0) + (reconnectCount > 0 ? 1 : 0)
                + additionalEventCount
            : 0,
        completedCommandIds, resumeCompletedCommandIds: completedCommandIds,
    };
}

function queuedCommand(
    agentId: string,
    phase: 'stage' | 'start',
    offset: number,
    duration: number,
    completed: boolean,
): ControlQueuedCommandSnapshot {
    return {
        envelope: {
            kind: 'command', protocolVersion: 1,
            runId: MONITOR_CONTROL_RUN_ID, agentId,
            commandId: commandId(phase, agentId),
            command: phase === 'stage'
                ? { kind: 'recipe.load', recipe: RECIPE }
                : { kind: 'recipe.run', recipe: RECIPE },
        },
        queuedAtEpochMs: BASE_EPOCH_MS + offset,
        dispatchedAtEpochMs: BASE_EPOCH_MS + offset + 20,
        ...(completed
            ? { completedAtEpochMs: BASE_EPOCH_MS + offset + 20 + duration }
            : {}),
        dispatchCount: 1,
    };
}

function resultEnvelope(
    agentId: string,
    phase: 'stage' | 'start',
    ok: boolean,
    startOffset: number,
    duration: number,
    state: MonitorOperationalState,
): ControlResultEnvelope {
    const failure = !ok ? state === 'timed-out'
        ? {
            code: 'MONITOR_DISTRIBUTED_RUN_TIMEOUT',
            message: 'The receiver exceeded the distributed run execution deadline.',
        }
        : { code: MONITOR_FAILURE_CODE, message: MONITOR_FAILURE_MESSAGE }
        : undefined;
    const id = commandId(phase, agentId);
    return {
        kind: 'result', protocolVersion: 1, runId: MONITOR_CONTROL_RUN_ID,
        agentId, commandId: id, ok, ...(failure ? { error: failure } : {}),
        result: {
            commandId: id, kind: phase === 'stage' ? 'recipe.load' : 'recipe.run',
            status: ok ? 'ok' : 'failed', ok,
            startedAtEpochMs: BASE_EPOCH_MS + startOffset,
            endedAtEpochMs: BASE_EPOCH_MS + startOffset + duration,
            durationMs: duration, ...(failure ? { error: failure } : {}),
        },
    };
}

function monitorEvents(
    state: MonitorOperationalState,
    reconnectCount: number,
    additionalEventCount: number,
): readonly ControlEventEnvelope[] {
    const shared = {
        protocolVersion: 1 as const, runId: MONITOR_CONTROL_RUN_ID,
        agentId: MONITOR_FAILURE_AGENT_ID,
        commandId: MONITOR_FAILURE_COMMAND_ID,
    };
    const failed = state === 'failed' || state === 'timed-out';
    const failureMessage = state === 'timed-out'
        ? 'The receiver exceeded the distributed run execution deadline.'
        : MONITOR_FAILURE_MESSAGE;
    const failureEvents: readonly ControlEventEnvelope[] = failed ? [{
        ...shared, kind: 'event', eventId: MONITOR_EVENT_ID,
        atEpochMs: BASE_EPOCH_MS + 780,
        payload: {
            distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
            topic: 'monitor.payload.missing', message: 'Receiver reported missing payload evidence.',
        },
    }, {
        ...shared, kind: 'diagnostic', eventId: MONITOR_DIAGNOSTIC_ID,
        atEpochMs: BASE_EPOCH_MS + 790,
        payload: {
            diagnosticSchemaVersion: 1,
            distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
            diagnosticTypeId: 'rallar.browser.rtc.expected_payload_missing',
            topic: 'rallar.browser.rtc.expected_payload_missing',
            severity: 'error', transport: 'messages.rtc',
            message: failureMessage,
            commandId: MONITOR_FAILURE_COMMAND_ID,
            agentId: MONITOR_FAILURE_AGENT_ID, roomId: GROUP.groupId,
        },
    }] : [];
    const reconnectEvents: readonly ControlEventEnvelope[] = reconnectCount > 0 ? [{
        ...shared,
        kind: 'event',
        eventId: 'monitor-agent-reconnected',
        atEpochMs: BASE_EPOCH_MS + 795,
        payload: {
            distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
            topic: 'control.agent.reconnected',
            message: 'Agent reconnected after a transient control disconnect.',
            reconnectCount,
        },
    }] : [];
    const additionalEvents: readonly ControlEventEnvelope[] = Array.from(
        { length: additionalEventCount },
        (_, index) => ({
            ...shared,
            kind: 'event',
            eventId: `monitor-bounded-event-${index + 1}`,
            atEpochMs: BASE_EPOCH_MS + 1_000 + index,
            payload: {
                distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
                topic: 'monitor.bounded.evidence',
                message: `Bounded Monitor event ${index + 1}.`,
            },
        }),
    );
    return [...failureEvents, ...reconnectEvents, ...additionalEvents];
}

function createArtifact(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
): ControlDistributedRunArtifactBundle {
    return {
        artifactSchemaVersion: 2,
        distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
        generatedAtEpochMs: BASE_EPOCH_MS + 1_000,
        files: {
            'distributed-run.json': JSON.stringify(distributedRun),
            'manifest.json': JSON.stringify(distributedRun.manifest),
            'control-run.json': JSON.stringify(controlRun),
            'report.json': JSON.stringify({
                distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
                ok: false,
                summary: 'Deterministic later receiver failure.',
            }),
            'failures.json': JSON.stringify([{
                commandId: MONITOR_FAILURE_COMMAND_ID,
                code: MONITOR_FAILURE_CODE,
                message: MONITOR_FAILURE_MESSAGE,
            }]),
            'metadata.json': JSON.stringify({
                generatedBy: 'recipe-console-monitor-fixture',
                generatedAtEpochMs: BASE_EPOCH_MS + 1_000,
            }),
        },
    };
}

function monitorAgentIds(singleAgentFailure: boolean): readonly string[] {
    return singleAgentFailure
        ? [MONITOR_FAILURE_AGENT_ID]
        : [SENDER_ID, MONITOR_FAILURE_AGENT_ID];
}

function commandId(phase: 'stage' | 'start', agentId: string): string {
    if (phase === 'start' && agentId === MONITOR_FAILURE_AGENT_ID) {
        return MONITOR_FAILURE_COMMAND_ID;
    }
    return `monitor-${phase}-${agentId === SENDER_ID ? 'sender' : 'receiver'}`;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
        status, contentType: 'application/json', headers: corsHeaders(),
        body: JSON.stringify(body),
    });
}

function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-client-id',
    };
}
