import type { BrowserContext, Route } from '@playwright/test';
import type {
    ControlAgentSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const BASE_EPOCH_MS = 2_300_000_000_000;
const EXECUTE_RUN_COUNT = 250;
const EXECUTE_TARGET_COUNT = 240;

export const EXECUTE_SCALE_SELECTED_RUN_ID = 'execute-pressure-0249';
export const EXECUTE_SCALE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&applicationId=rallar-server&workspaceId=default&roomId=execute-live-group' +
    `&controlRunId=${EXECUTE_SCALE_SELECTED_RUN_ID}`;

export type RecipeConsoleScaleControlFixture = Readonly<{
    mutationRequests(): readonly Readonly<{ method: string; pathname: string }>[];
    snapshotReads(): number;
}>;

export async function installRecipeConsoleScaleControlFixture(
    context: BrowserContext,
    snapshot: ControlServerSnapshot,
): Promise<RecipeConsoleScaleControlFixture> {
    const mutations: Array<Readonly<{ method: string; pathname: string }>> = [];
    let reads = 0;
    const runs = JSON.stringify({ runs: snapshot.runs });
    const distributedRuns = JSON.stringify({
        distributedRuns: snapshot.distributedRuns ?? [],
    });

    await context.route(CONTROL_ROUTE, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders(), body: '' });
            return;
        }
        if (request.method() !== 'GET') {
            mutations.push({ method: request.method(), pathname: url.pathname });
            await fulfillJson(route, {
                error: 'The canonical scale fixture is read-only.',
            }, 405);
            return;
        }
        if (url.pathname === '/runs') {
            reads += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: corsHeaders(),
                body: runs,
            });
            return;
        }
        if (url.pathname === '/distributed-runs') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: corsHeaders(),
                body: distributedRuns,
            });
            return;
        }
        await fulfillJson(route, {
            error: `Unhandled GET ${url.pathname}`,
        }, 404);
    });

    return {
        mutationRequests: () => mutations.map(request => ({ ...request })),
        snapshotReads: () => reads,
    };
}

export function createExecuteScaleSnapshot(): ControlServerSnapshot {
    const runs = Array.from(
        { length: EXECUTE_RUN_COUNT },
        (_, runOrdinal): ControlRunSnapshot => {
            const runId = executeRunId(runOrdinal);
            const agentCount = runOrdinal === EXECUTE_RUN_COUNT - 1
                ? EXECUTE_TARGET_COUNT
                : 1;
            const updatedAtEpochMs = BASE_EPOCH_MS -
                (EXECUTE_RUN_COUNT - runOrdinal) * 1_000;
            return {
                runId,
                createdAtEpochMs: updatedAtEpochMs - 10_000,
                updatedAtEpochMs,
                agents: Array.from({ length: agentCount }, (_, agentOrdinal) =>
                    executeAgent(runId, agentOrdinal, updatedAtEpochMs)
                ),
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            };
        },
    );
    return { runs, distributedRuns: [] };
}

function executeAgent(
    runId: string,
    agentOrdinal: number,
    updatedAtEpochMs: number,
): ControlAgentSnapshot {
    const agentId = `pressure-agent-${String(agentOrdinal).padStart(4, '0')}`;
    return {
        runId,
        agentId,
        connected: true,
        registeredAtEpochMs: updatedAtEpochMs - 5_000,
        lastSeenAtEpochMs: updatedAtEpochMs,
        lastHeartbeatAtEpochMs: updatedAtEpochMs,
        status: 'connected',
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'execute-live-group',
            providerMode: 'browser-rallar',
            browserName: 'chromium',
            region: 'eu-north',
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    };
}

function executeRunId(ordinal: number): string {
    return `execute-pressure-${String(ordinal).padStart(4, '0')}`;
}

function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
}

async function fulfillJson(
    route: Route,
    body: unknown,
    status = 200,
): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify(body),
    });
}
