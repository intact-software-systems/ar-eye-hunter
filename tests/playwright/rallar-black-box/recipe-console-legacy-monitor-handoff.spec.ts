import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const REQUESTED_CONTROL_RUN_ID = 'legacy-monitor-control-requested';
const REQUESTED_DISTRIBUTED_RUN_ID = 'legacy-monitor-distributed-requested';
const NEWER_CONTROL_RUN_ID = 'legacy-monitor-control-newer';
const NEWER_DISTRIBUTED_RUN_ID = 'legacy-monitor-distributed-newer';

test('opens the selected legacy Runs context from a two-run Monitor link', async ({ context, page }) => {
    await installTwoRunControlFixture(context);

    await page.goto(
        '/?provider=simulated&v=1&experience=recipe-console&view=monitor' +
            `&controlRunId=${REQUESTED_CONTROL_RUN_ID}` +
            `&distributedRunId=${REQUESTED_DISTRIBUTED_RUN_ID}`
    );

    const inspector = page.locator('[data-monitor-inspector]');
    await expect(inspector).toBeVisible();
    await inspector.getByRole('link', {
        name: 'Open this run in legacy Runs'
    }).click();
    await expect(page).toHaveURL(/experience=legacy/);
    await expect(page).toHaveURL(/tab=runs/);

    const runs = page.locator('#panel-runs');
    await expect(runs).toBeVisible();
    await expect(runs.getByRole('combobox', { name: 'Distributed Run' })).toHaveValue(
        REQUESTED_DISTRIBUTED_RUN_ID
    );
    await expect(runs.locator('.runner-distributed-freshness')).toContainText(
        REQUESTED_CONTROL_RUN_ID
    );
    await expect(runs.locator('.distributed-run-summary')).toContainText(
        'running'
    );
});

async function installTwoRunControlFixture(
    context: BrowserContext
): Promise<void> {
    const requested = distributedRun({
        controlRunId: REQUESTED_CONTROL_RUN_ID,
        distributedRunId: REQUESTED_DISTRIBUTED_RUN_ID,
        updatedAtEpochMs: 1_000
    });
    const newer = distributedRun({
        controlRunId: NEWER_CONTROL_RUN_ID,
        distributedRunId: NEWER_DISTRIBUTED_RUN_ID,
        updatedAtEpochMs: 2_000
    });
    const controlRuns = new Map([
        [REQUESTED_CONTROL_RUN_ID, controlRun(REQUESTED_CONTROL_RUN_ID, 1_000)],
        [NEWER_CONTROL_RUN_ID, controlRun(NEWER_CONTROL_RUN_ID, 2_000)]
    ]);
    const distributedRuns = new Map([
        [REQUESTED_DISTRIBUTED_RUN_ID, requested],
        [NEWER_DISTRIBUTED_RUN_ID, newer]
    ]);

    await context.route(CONTROL_ROUTE, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders() });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            await fulfillJson(route, { distributedRuns: [newer, requested] });
            return;
        }
        if (request.method() === 'GET' && url.pathname.startsWith('/distributed-runs/')) {
            const id = decodeURIComponent(url.pathname.slice('/distributed-runs/'.length));
            const run = distributedRuns.get(id);
            await fulfillJson(route, run ?? { error: 'distributed run not found' }, run ? 200 : 404);
            return;
        }
        if (request.method() === 'GET' && url.pathname.startsWith('/runs/')) {
            const id = decodeURIComponent(url.pathname.slice('/runs/'.length));
            const run = controlRuns.get(id);
            await fulfillJson(route, run ?? { error: 'control run not found' }, run ? 200 : 404);
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            await fulfillJson(route, { runs: [...controlRuns.values()] });
            return;
        }
        await fulfillJson(route, { error: `Unhandled ${request.method()} ${url.pathname}` }, 404);
    });
}

function distributedRun(
    input: Readonly<{
        controlRunId: string;
        distributedRunId: string;
        updatedAtEpochMs: number;
    }>
): ControlDistributedRunSnapshot {
    return {
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'running',
        createdAtEpochMs: input.updatedAtEpochMs - 100,
        updatedAtEpochMs: input.updatedAtEpochMs,
        startedAtEpochMs: input.updatedAtEpochMs - 50,
        targetAgentIds: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId: input.distributedRunId,
            controlRunId: input.controlRunId,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'legacy-monitor-handoff'
            },
            recipes: [{
                recipeId: 'legacy-monitor-health',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'legacy-monitor-health',
                    name: 'Legacy Monitor handoff health',
                    commands: [{ kind: 'health', commandId: 'legacy-monitor-health' }]
                },
                required: true
            }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: [],
                expectedParticipantCount: 0
            }
        },
        commandLinks: [],
        rollup: {
            state: 'running',
            ok: false,
            summary: {
                participants: 0,
                requiredParticipants: 0,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 0,
                failedRecipes: 0,
                blockingFailures: 0
            },
            failures: []
        }
    };
}

function controlRun(runId: string, updatedAtEpochMs: number): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: updatedAtEpochMs - 100,
        updatedAtEpochMs,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify(body)
    });
}

function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type'
    };
}
