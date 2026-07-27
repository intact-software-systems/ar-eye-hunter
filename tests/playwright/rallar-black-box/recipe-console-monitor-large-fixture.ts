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
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
} from '../../../packages/shared-test/rallar-bb-test/types.ts';

const LARGE_MONITOR_CONTROL_RUN_ID = 'monitor-large-control-live';
const LARGE_MONITOR_DISTRIBUTED_RUN_ID = 'monitor-large-distributed-live';
const LARGE_MONITOR_COMMON_RECIPE_ID = 'monitor-large-shared-recipe';
const LARGE_MONITOR_FAILURE_AGENT_ID = 'monitor-large-agent-000';
const LARGE_MONITOR_AGENT_COUNT = 126;
const LARGE_MONITOR_ROLE_CHOICE_COUNT = 66;
const LARGE_MONITOR_UNIQUE_RECIPE_COUNT = 6;
const LARGE_MONITOR_FAILURE_COUNT = 70;
const LARGE_MONITOR_DIAGNOSTIC_COUNT = 55;
const LARGE_MONITOR_EVENT_COUNT = 55;
const LARGE_MONITOR_COMPOSITE_COUNT = 45;

export const LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID =
    'monitor-large-failure-command-069';
export const LARGE_MONITOR_LAST_FAILURE_COMMAND_ID =
    'monitor-large-failure-command-000';
export const LARGE_MONITOR_LONG_AGENT_ID =
    `zz-monitor-agent-late-\u202e-مرحبا-משתתף-${'exact-segment-'.repeat(12)}tail`;
export const LARGE_MONITOR_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=monitor' +
    `&controlRunId=${LARGE_MONITOR_CONTROL_RUN_ID}` +
    `&distributedRunId=${LARGE_MONITOR_DISTRIBUTED_RUN_ID}` +
    '&applicationId=rallar-server&workspaceId=default&roomId=monitor-group';

// The control document stays inside the requested 120 command/result and 160
// event bounds. Timeline = 4 lifecycle + 471 link transitions + 115 results +
// 70 failures + 110 events + 55 diagnostic projections. The selected failure
// reaches 283 unique destinations; its command view reaches 336 linked items.
export const LARGE_MONITOR_COUNTS = {
    failures: LARGE_MONITOR_FAILURE_COUNT,
    agents: LARGE_MONITOR_AGENT_COUNT,
    recipes: LARGE_MONITOR_ROLE_CHOICE_COUNT + LARGE_MONITOR_UNIQUE_RECIPE_COUNT,
    readiness: LARGE_MONITOR_AGENT_COUNT,
    diagnostics: LARGE_MONITOR_DIAGNOSTIC_COUNT,
    timeline: 825,
    events: LARGE_MONITOR_DIAGNOSTIC_COUNT + LARGE_MONITOR_EVENT_COUNT,
    composites: LARGE_MONITOR_COMPOSITE_COUNT,
    failureDestinations: 283,
    commandEvidence: 336,
    diagnosticFailureLinks: LARGE_MONITOR_FAILURE_COUNT,
    roleChoices: LARGE_MONITOR_ROLE_CHOICE_COUNT,
} as const;

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const BASE_EPOCH_MS = 2_000_000_000_000;
const GROUP = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'monitor-group',
} as const;

export type RecipeConsoleLargeMonitorFixture = Readonly<{
    artifact: ControlDistributedRunArtifactBundle;
    snapshot: ControlServerSnapshot;
    failDistributedRunReads(): void;
    recoverDistributedRunReads(): void;
    setAgentCount(count: number): void;
    runRequestCount(): number;
    distributedRunRequestCount(): number;
    mutationRequestCount(): number;
}>;

export async function installRecipeConsoleLargeMonitorFixture(
    context: BrowserContext,
): Promise<RecipeConsoleLargeMonitorFixture> {
    let agentCount = LARGE_MONITOR_AGENT_COUNT;
    let revision = 0;
    let runReads = 0;
    let distributedRunReads = 0;
    let distributedRunReadsOffline = false;
    let mutationWrites = 0;
    const initialControlRun = createLargeControlRun(agentCount, revision);
    const initialDistributedRun = createLargeDistributedRun(agentCount, revision);
    const snapshot: ControlServerSnapshot = {
        runs: [initialControlRun],
        distributedRuns: [initialDistributedRun],
    };
    const artifact = createLargeArtifact(initialDistributedRun, initialControlRun);

    await context.route(CONTROL_ROUTE, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders() });
            return;
        }
        if (request.method() !== 'GET') mutationWrites += 1;
        if (request.method() === 'GET' && url.pathname === '/runs') {
            runReads += 1;
            await fulfillJson(route, {
                runs: [createLargeControlRun(agentCount, revision)],
            });
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/runs/${LARGE_MONITOR_CONTROL_RUN_ID}`
        ) {
            await fulfillJson(
                route,
                createLargeControlRun(agentCount, revision),
            );
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            distributedRunReads += 1;
            if (distributedRunReadsOffline) {
                await route.abort('connectionfailed');
                return;
            }
            await fulfillJson(route, {
                distributedRuns: [createLargeDistributedRun(agentCount, revision)],
            });
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname ===
                `/distributed-runs/${LARGE_MONITOR_DISTRIBUTED_RUN_ID}/artifacts`
        ) {
            const controlRun = createLargeControlRun(agentCount, revision);
            const distributedRun = createLargeDistributedRun(agentCount, revision);
            await fulfillJson(route, createLargeArtifact(distributedRun, controlRun));
            return;
        }
        await fulfillJson(route, {
            error: `Unhandled ${request.method()} ${url.pathname}`,
        }, 404);
    });

    return {
        artifact,
        snapshot,
        failDistributedRunReads: () => { distributedRunReadsOffline = true; },
        recoverDistributedRunReads: () => { distributedRunReadsOffline = false; },
        setAgentCount: (count) => {
            agentCount = Math.max(1, Math.min(
                LARGE_MONITOR_AGENT_COUNT,
                Math.floor(count),
            ));
            revision += 1;
        },
        runRequestCount: () => runReads,
        distributedRunRequestCount: () => distributedRunReads,
        mutationRequestCount: () => mutationWrites,
    };
}

const LARGE_MONITOR_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: LARGE_MONITOR_COMMON_RECIPE_ID,
    name: 'Large Monitor shared recipe',
    commands: [{ kind: 'health', commandId: 'monitor-large-health' }],
};

function createLargeControlRun(
    agentCount: number,
    revision: number,
): ControlRunSnapshot {
    const agentIds = largeMonitorAgentIds(agentCount);
    const failureCommands = Array.from(
        { length: LARGE_MONITOR_FAILURE_COUNT },
        (_, index) => largeFailureCommand(index),
    );
    const compositeCount = Math.min(
        LARGE_MONITOR_COMPOSITE_COUNT,
        Math.max(0, agentIds.length - 1),
    );
    const compositeCommands = Array.from(
        { length: compositeCount },
        (_, index) => largeCompositeCommand(index, agentIds[index + 1]!),
    );
    const commands = [...failureCommands, ...compositeCommands];
    const results = [
        ...failureCommands.map((command, index) =>
            largeFailureResult(command.envelope.commandId, index)
        ),
        ...compositeCommands.map((command, index) =>
            largeCompositeResult(
                command.envelope.commandId,
                command.envelope.agentId!,
                index,
            )
        ),
    ];
    const events = largeMonitorEvents();
    return {
        runId: LARGE_MONITOR_CONTROL_RUN_ID,
        createdAtEpochMs: BASE_EPOCH_MS,
        updatedAtEpochMs: BASE_EPOCH_MS + 8_000 + revision,
        agents: agentIds.map((agentId, index) => {
            const failureIds = index === 0
                ? failureCommands.map(command => command.envelope.commandId)
                : [];
            const compositeId = index > 0 && index <= compositeCount
                ? [compositeCommands[index - 1]!.envelope.commandId]
                : [];
            const completedCommandIds = [
                largeStageCommandId(index),
                ...failureIds,
                ...compositeId,
            ];
            return {
                runId: LARGE_MONITOR_CONTROL_RUN_ID,
                agentId,
                connected: true,
                registeredAtEpochMs: BASE_EPOCH_MS - 1_000,
                lastSeenAtEpochMs: BASE_EPOCH_MS + 8_000,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 8_000,
                status: index === 0 ? 'failed' : 'completed',
                identity: {
                    principalId: `${agentId}-principal`,
                    sessionId: `${agentId}-session`,
                    ...GROUP,
                    providerMode: 'browser-rallar',
                    browserName: 'chromium',
                    region: 'eu-north',
                    tags: [largeMonitorRole(index)],
                },
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: failureIds.length + compositeId.length,
                receivedEventCount: index === 0 ? events.length : 0,
                completedCommandIds,
                resumeCompletedCommandIds: completedCommandIds,
            } satisfies ControlAgentSnapshot;
        }),
        commands,
        results,
        events,
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function createLargeDistributedRun(
    agentCount: number,
    revision: number,
): ControlDistributedRunSnapshot {
    const agentIds = largeMonitorAgentIds(agentCount);
    const compositeCount = Math.min(
        LARGE_MONITOR_COMPOSITE_COUNT,
        Math.max(0, agentIds.length - 1),
    );
    const stageLinks = agentIds.map((agentId, index) => ({
        phase: 'stage' as const,
        agentId,
        commandId: largeStageCommandId(index),
        recipeId: LARGE_MONITOR_COMMON_RECIPE_ID,
        role: largeMonitorRole(index),
        queuedAtEpochMs: BASE_EPOCH_MS + 100 + index,
    }));
    const failureLinks = Array.from(
        { length: LARGE_MONITOR_FAILURE_COUNT },
        (_, index) => ({
            phase: 'start' as const,
            agentId: agentIds[0]!,
            commandId: largeFailureCommandId(index),
            recipeId: LARGE_MONITOR_COMMON_RECIPE_ID,
            role: largeMonitorRole(0),
            queuedAtEpochMs: BASE_EPOCH_MS + 1_000 + index,
        }),
    );
    const compositeLinks = Array.from(
        { length: compositeCount },
        (_, index) => ({
            phase: 'start' as const,
            agentId: agentIds[index + 1]!,
            commandId: largeCompositeCommandId(index),
            recipeId: LARGE_MONITOR_COMMON_RECIPE_ID,
            role: largeMonitorRole(index + 1),
            queuedAtEpochMs: BASE_EPOCH_MS + 2_000 + index,
        }),
    );
    return {
        distributedRunId: LARGE_MONITOR_DISTRIBUTED_RUN_ID,
        controlRunId: LARGE_MONITOR_CONTROL_RUN_ID,
        state: 'failed',
        createdAtEpochMs: BASE_EPOCH_MS,
        updatedAtEpochMs: BASE_EPOCH_MS + 8_000 + revision,
        stagedAtEpochMs: BASE_EPOCH_MS + 100,
        startedAtEpochMs: BASE_EPOCH_MS + 1_000,
        completedAtEpochMs: BASE_EPOCH_MS + 8_000 + revision,
        targetAgentIds: agentIds,
        manifest: {
            schemaVersion: 1,
            distributedRunId: LARGE_MONITOR_DISTRIBUTED_RUN_ID,
            controlRunId: LARGE_MONITOR_CONTROL_RUN_ID,
            displayName: 'Large deterministic Monitor pressure run',
            group: GROUP,
            recipes: largeMonitorRecipeSelections(),
            targetPolicy: {
                mode: 'selected-agents',
                agentIds,
                expectedParticipantCount: agentIds.length,
            },
            roleAssignments: agentIds.map((agentId, index) => ({
                agentId,
                role: largeMonitorRole(index),
                recipeIds: [LARGE_MONITOR_COMMON_RECIPE_ID],
                required: true,
            })),
        },
        commandLinks: [...stageLinks, ...failureLinks, ...compositeLinks],
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: agentIds.length,
                requiredParticipants: agentIds.length,
                readyParticipants: agentIds.length,
                passedParticipants: Math.max(0, agentIds.length - 1),
                failedParticipants: 1,
                recipes: LARGE_MONITOR_COUNTS.recipes,
                requiredRecipes: LARGE_MONITOR_COUNTS.recipes,
                passedRecipes: LARGE_MONITOR_COUNTS.recipes - 1,
                failedRecipes: 1,
                blockingFailures: LARGE_MONITOR_FAILURE_COUNT,
            },
            failures: [],
        },
    };
}

function largeMonitorRecipeSelections() {
    const shared = Array.from(
        { length: LARGE_MONITOR_ROLE_CHOICE_COUNT },
        (_, index) => ({
            recipeId: LARGE_MONITOR_COMMON_RECIPE_ID,
            recipe: LARGE_MONITOR_RECIPE,
            role: largeMonitorRole(index),
            profile: `large-profile-${String(index).padStart(3, '0')}`,
            required: true,
        }),
    );
    const unique = Array.from(
        { length: LARGE_MONITOR_UNIQUE_RECIPE_COUNT },
        (_, index) => {
            const recipeId = index === LARGE_MONITOR_UNIQUE_RECIPE_COUNT - 1
                ? `monitor-recipe-\u202e-מתכון-وصفة-${'exact-'.repeat(18)}tail`
                : `monitor-large-unique-recipe-${String(index).padStart(3, '0')}`;
            return {
                recipeId,
                recipe: {
                    schemaVersion: 1 as const,
                    recipeId,
                    name: `Large unique recipe ${index + 1}`,
                    commands: [{ kind: 'health' as const }],
                },
                required: true,
            };
        },
    );
    return [...shared, ...unique];
}

function largeFailureCommand(index: number): ControlQueuedCommandSnapshot {
    const commandId = largeFailureCommandId(index);
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: LARGE_MONITOR_CONTROL_RUN_ID,
            agentId: LARGE_MONITOR_FAILURE_AGENT_ID,
            commandId,
            command: { kind: 'recipe.run', recipe: LARGE_MONITOR_RECIPE },
        },
        queuedAtEpochMs: BASE_EPOCH_MS + 1_000 + index,
        dispatchedAtEpochMs: BASE_EPOCH_MS + 1_100 + index,
        completedAtEpochMs: BASE_EPOCH_MS + 6_000 + index,
        dispatchCount: 1,
    };
}

function largeCompositeCommand(
    index: number,
    agentId: string,
): ControlQueuedCommandSnapshot {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: LARGE_MONITOR_CONTROL_RUN_ID,
            agentId,
            commandId: largeCompositeCommandId(index),
            command: { kind: 'recipe.run', recipe: LARGE_MONITOR_RECIPE },
        },
        queuedAtEpochMs: BASE_EPOCH_MS + 2_000 + index,
        dispatchedAtEpochMs: BASE_EPOCH_MS + 2_100 + index,
        completedAtEpochMs: BASE_EPOCH_MS + 4_000 + index,
        dispatchCount: 1,
    };
}

function largeFailureResult(
    commandId: string,
    index: number,
): ControlResultEnvelope {
    const error = {
        code: `MONITOR_LARGE_FAILURE_${String(index).padStart(3, '0')}`,
        message: `Large Monitor failure ${String(index + 1).padStart(3, '0')}.`,
    };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: LARGE_MONITOR_CONTROL_RUN_ID,
        agentId: LARGE_MONITOR_FAILURE_AGENT_ID,
        commandId,
        ok: false,
        error,
        result: {
            commandId,
            kind: 'recipe.run',
            status: 'failed',
            ok: false,
            startedAtEpochMs: BASE_EPOCH_MS + 1_100 + index,
            endedAtEpochMs: BASE_EPOCH_MS + 6_000 + index,
            durationMs: 4_900,
            error,
        },
    };
}

function largeCompositeResult(
    commandId: string,
    agentId: string,
    index: number,
): ControlResultEnvelope {
    const child: RallarBlackBoxTestResult = {
        commandId: `${commandId}:assert-ready`,
        kind: 'assert',
        status: 'ok',
        ok: true,
        startedAtEpochMs: BASE_EPOCH_MS + 2_200 + index,
        endedAtEpochMs: BASE_EPOCH_MS + 3_900 + index,
        durationMs: 1_700,
        value: {
            commandId: `${commandId}:assert-ready`,
            source: 'context.ready',
            operator: 'exists',
            actual: true,
            exists: true,
            passed: true,
        },
    };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: LARGE_MONITOR_CONTROL_RUN_ID,
        agentId,
        commandId,
        ok: true,
        result: {
            commandId,
            kind: 'recipe.run',
            status: 'ok',
            ok: true,
            startedAtEpochMs: BASE_EPOCH_MS + 2_100 + index,
            endedAtEpochMs: BASE_EPOCH_MS + 4_000 + index,
            durationMs: 1_900,
            value: {
                recipeId: LARGE_MONITOR_COMMON_RECIPE_ID,
                results: [child],
            },
        },
    };
}

function largeMonitorEvents(): readonly ControlEventEnvelope[] {
    const agentId = LARGE_MONITOR_FAILURE_AGENT_ID;
    const diagnostics = Array.from(
        { length: LARGE_MONITOR_DIAGNOSTIC_COUNT },
        (_, index) => ({
            kind: 'diagnostic' as const,
            protocolVersion: 1 as const,
            runId: LARGE_MONITOR_CONTROL_RUN_ID,
            agentId,
            commandId: LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
            eventId: `monitor-large-diagnostic-${String(index).padStart(3, '0')}`,
            atEpochMs: BASE_EPOCH_MS + 7_000 + index,
            payload: {
                distributedRunId: LARGE_MONITOR_DISTRIBUTED_RUN_ID,
                diagnosticSchemaVersion: 1,
                diagnosticTypeId: `monitor.large.diagnostic.${String(index).padStart(3, '0')}`,
                topic: 'rallar.browser.rtc.large_monitor_signal',
                severity: 'error',
                transport: 'messages.rtc',
                message: `Large Monitor diagnostic ${index + 1}.`,
                commandId: LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
                agentId,
                roomId: GROUP.groupId,
            },
        }),
    );
    const events = Array.from(
        { length: LARGE_MONITOR_EVENT_COUNT },
        (_, index) => ({
            kind: 'event' as const,
            protocolVersion: 1 as const,
            runId: LARGE_MONITOR_CONTROL_RUN_ID,
            agentId,
            commandId: LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
            eventId: `monitor-large-event-${String(index).padStart(3, '0')}`,
            atEpochMs: BASE_EPOCH_MS + 7_100 + index,
            payload: {
                distributedRunId: LARGE_MONITOR_DISTRIBUTED_RUN_ID,
                topic: 'monitor.large.evidence',
                message: `Large Monitor event ${index + 1}.`,
            },
        }),
    );
    return [...diagnostics, ...events];
}

function createLargeArtifact(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
): ControlDistributedRunArtifactBundle {
    return {
        artifactSchemaVersion: 2,
        distributedRunId: LARGE_MONITOR_DISTRIBUTED_RUN_ID,
        generatedAtEpochMs: BASE_EPOCH_MS + 9_000,
        files: {
            'distributed-run.json': JSON.stringify(distributedRun),
            'manifest.json': JSON.stringify(distributedRun.manifest),
            'control-run.json': JSON.stringify(controlRun),
            'metadata.json': JSON.stringify({
                generatedBy: 'recipe-console-large-monitor-fixture',
            }),
        },
    };
}

function largeMonitorAgentIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) =>
        index === LARGE_MONITOR_AGENT_COUNT - 1
            ? LARGE_MONITOR_LONG_AGENT_ID
            : `monitor-large-agent-${String(index).padStart(3, '0')}`
    );
}

function largeMonitorRole(index: number): string {
    return `large-role-${String(index % LARGE_MONITOR_ROLE_CHOICE_COUNT).padStart(3, '0')}`;
}

function largeStageCommandId(index: number): string {
    return `monitor-large-stage-command-${String(index).padStart(3, '0')}`;
}

function largeFailureCommandId(index: number): string {
    return `monitor-large-failure-command-${String(index).padStart(3, '0')}`;
}

function largeCompositeCommandId(index: number): string {
    return `monitor-large-composite-command-${String(index).padStart(3, '0')}`;
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
