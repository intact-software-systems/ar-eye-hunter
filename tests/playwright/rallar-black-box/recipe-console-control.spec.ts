import {
    expect,
    type BrowserContext,
    type Page,
    type Route,
    test,
} from '@playwright/test';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const GROUP = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'bb-group',
} as const satisfies RallarBlackBoxDistributedGroupRef;
const RECIPE_CONSOLE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&applicationId=rallar-server&workspaceId=default&roomId=bb-group';

const TARGET_REASONS = {
    matched: 'Agent is connected and reports the selected global group.',
    stale: 'Agent matches the group but the last heartbeat is stale.',
    offline: 'Agent matches the group but is disconnected from the control server.',
    'different-group': 'Agent identity does not match the selected global group.',
    'missing-identity': 'Agent has not reported enough Rallar identity metadata.',
} as const;

type ControlMockStep =
    | Readonly<{ kind: 'snapshot'; snapshot: ControlServerSnapshot }>
    | Readonly<{ kind: 'http-error'; status: number; message: string }>
    | Readonly<{ kind: 'network-error' }>;

type ControlRouteMock = Readonly<{
    runRequestCount(): number;
}>;

function controlAgent(
    runId: string,
    agentId: string,
    options: Readonly<{
        connected?: boolean;
        heartbeatAgeMs?: number;
        identity?: false;
        groupId?: string;
    }> = {},
): ControlAgentSnapshot {
    const atEpochMs = Date.now() - (options.heartbeatAgeMs ?? 1_000);
    return {
        runId,
        agentId,
        connected: options.connected ?? true,
        registeredAtEpochMs: atEpochMs - 1_000,
        lastSeenAtEpochMs: atEpochMs,
        lastHeartbeatAtEpochMs: atEpochMs,
        status: options.connected === false ? 'offline' : 'connected',
        identity: options.identity === false
            ? undefined
            : {
                principalId: `${agentId}-principal`,
                username: agentId,
                sessionId: `${agentId}-session`,
                applicationId: GROUP.applicationId,
                workspaceId: GROUP.workspaceId,
                groupId: options.groupId ?? GROUP.groupId,
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

function controlRun(
    runId: string,
    agents: readonly ControlAgentSnapshot[],
): ControlRunSnapshot {
    const now = Date.now();
    return {
        runId,
        createdAtEpochMs: now - 60_000,
        updatedAtEpochMs: now - 1_000,
        agents,
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function activeDistributedRun(
    controlRunId: string,
    targetAgentIds: readonly string[],
): ControlDistributedRunSnapshot {
    const now = Date.now();
    return {
        distributedRunId: 'dist-live-canonical',
        controlRunId,
        manifest: {
            schemaVersion: 1,
            distributedRunId: 'dist-live-canonical',
            controlRunId,
            displayName: 'Canonical live run',
            group: GROUP,
            recipes: [{ recipeId: 'health-only', required: true }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: targetAgentIds,
                expectedParticipantCount: targetAgentIds.length,
            },
        },
        state: 'running',
        createdAtEpochMs: now - 10_000,
        updatedAtEpochMs: now - 1_000,
        startedAtEpochMs: now - 9_000,
        targetAgentIds,
        commandLinks: [],
        rollup: {
            state: 'running',
            ok: false,
            summary: {
                participants: targetAgentIds.length,
                requiredParticipants: targetAgentIds.length,
                readyParticipants: targetAgentIds.length,
                passedParticipants: 0,
                failedParticipants: 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 0,
                failedRecipes: 0,
                blockingFailures: 0,
            },
            failures: [],
        },
    };
}

function liveBoardSnapshot(): ControlServerSnapshot {
    const runId = 'control-canonical';
    const agents = [
        controlAgent(runId, 'agent-matched'),
        controlAgent(runId, 'agent-stale', { heartbeatAgeMs: 60_000 }),
        controlAgent(runId, 'agent-offline', { connected: false }),
        controlAgent(runId, 'agent-wrong-group', { groupId: 'other-group' }),
        controlAgent(runId, 'agent-missing-identity', { identity: false }),
    ];
    return {
        runs: [controlRun(runId, agents)],
        distributedRuns: [activeDistributedRun(runId, agents.map(agent => agent.agentId))],
    };
}

async function fulfillJson(
    route: Route,
    status: number,
    body: unknown,
): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
            'access-control-allow-origin': '*',
        },
        body: JSON.stringify(body),
    });
}

async function installControlRouteMock(
    context: BrowserContext,
    steps: readonly ControlMockStep[],
    options: Readonly<{
        distributedRunsFallback?: readonly ControlDistributedRunSnapshot[];
        distributedRunsStatus?: number;
    }> = {},
): Promise<ControlRouteMock> {
    let runRequestCount = 0;
    await context.route(CONTROL_ROUTE, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/runs') {
            const step = steps[Math.min(runRequestCount, steps.length - 1)];
            runRequestCount += 1;
            if (!step || step.kind === 'network-error') {
                await route.abort('connectionfailed');
                return;
            }
            if (step.kind === 'http-error') {
                await fulfillJson(route, step.status, { error: step.message });
                return;
            }
            await fulfillJson(route, 200, step.snapshot);
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            const status = options.distributedRunsStatus ?? 200;
            await fulfillJson(route, status, status === 200
                ? { distributedRuns: options.distributedRunsFallback ?? [] }
                : { error: 'Distributed-run context unavailable.' });
            return;
        }
        await fulfillJson(route, 404, {
            error: `Unhandled ${request.method()} ${url.pathname}`,
        });
    });
    return { runRequestCount: () => runRequestCount };
}

function commandContextItem(page: Page, label: string) {
    return page.locator('[data-command-bar]')
        .getByText(label, { exact: true })
        .locator('..');
}

function commandStatus(
    page: Page,
    status: 'passed' | 'failed' | 'partial' | 'stale' | 'warning',
    label: string,
) {
    return page.locator(`[data-command-bar] [data-status="${status}"]`)
        .filter({ hasText: label });
}

function controlBoard(page: Page) {
    return page.getByRole('region', { name: 'Control agent board' });
}

function agentRow(page: Page, agentId: string) {
    return controlBoard(page).locator(`[data-control-agent-row][data-agent-id="${agentId}"]`);
}

test('renders live command context and canonical repository-derived target reasons', async ({
    context,
    page,
}) => {
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: liveBoardSnapshot(),
    }]);

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=control-canonical`);

    const overview = page.getByRole('region', { name: 'Control overview' });
    await expect(overview).toBeVisible();
    await expect(commandStatus(page, 'passed', 'Live'))
        .toBeVisible();
    await expect(commandContextItem(page, 'Control server')).toContainText(
        'http://localhost:5180',
    );
    await expect(commandContextItem(page, 'Control run')).toContainText('control-canonical');
    await expect(commandContextItem(page, 'Group')).toContainText(
        'rallar-server/default/bb-group',
    );
    await expect(commandContextItem(page, 'Connected')).toContainText('4/5');
    await expect(commandContextItem(page, 'Safe targets')).toContainText('1');
    await expect(commandContextItem(page, 'Active run')).toContainText(
        'dist-live-canonical · running',
    );

    const board = controlBoard(page);
    await expect(board.locator('[data-control-agent-row]')).toHaveCount(5);
    for (const [agentId, status] of [
        ['agent-matched', 'matched'],
        ['agent-stale', 'stale'],
        ['agent-offline', 'offline'],
        ['agent-wrong-group', 'different-group'],
        ['agent-missing-identity', 'missing-identity'],
    ] as const) {
        const row = agentRow(page, agentId);
        await expect(row).toHaveAttribute('data-target-status', status);
        await expect(row.getByText(TARGET_REASONS[status], { exact: true }))
            .toBeVisible();
        await expect(row).toHaveAccessibleName(
            `Select agent ${agentId}. ${TARGET_REASONS[status]}`,
        );
    }
    await expect(board).not.toContainText('seed-agent-a');
    await expect(board).not.toContainText('seed-agent-b');
});

test('shows initial network failure as offline without seeded board fallback', async ({
    context,
    page,
}) => {
    await installControlRouteMock(context, [{ kind: 'network-error' }]);

    await page.goto(RECIPE_CONSOLE_ROUTE);

    await expect(commandStatus(page, 'failed', 'Offline'))
        .toBeVisible();
    const overview = page.getByRole('region', { name: 'Control overview' });
    await expect(overview.getByRole('heading', { name: 'Control server offline' }))
        .toBeVisible();
    await expect(overview.getByText(
        'No last-known control snapshot is available.',
        { exact: true },
    )).toBeVisible();
    await expect(controlBoard(page).locator('[data-control-agent-row]')).toHaveCount(0);
    await expect(controlBoard(page)).not.toContainText('seed-agent');
});

test('keeps usable rows in a partial snapshot and labels active-run context unknown', async ({
    context,
    page,
}) => {
    const runId = 'control-partial';
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: {
            runs: [controlRun(runId, [controlAgent(runId, 'agent-partial')])],
        },
    }], { distributedRunsStatus: 503 });

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=${runId}`);

    await expect(commandStatus(page, 'partial', 'Partial'))
        .toBeVisible();
    await expect(agentRow(page, 'agent-partial')).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(commandContextItem(page, 'Safe targets')).toContainText('1');
    await expect(commandContextItem(page, 'Active run')).toContainText('Unknown');
    await expect(page.getByRole('region', { name: 'Control overview' }).getByText(
        'Distributed-run context is unavailable; agent connectivity remains usable.',
        { exact: true },
    )).toBeVisible();
});

test('retains last-good rows after a failed manual refresh but reports zero current safe targets', async ({
    context,
    page,
}) => {
    const runId = 'control-last-good';
    const mock = await installControlRouteMock(context, [
        {
            kind: 'snapshot',
            snapshot: {
                runs: [controlRun(runId, [controlAgent(runId, 'agent-last-good')])],
                distributedRuns: [],
            },
        },
        { kind: 'network-error' },
    ]);
    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=${runId}`);
    await expect(agentRow(page, 'agent-last-good')).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(commandStatus(page, 'passed', 'Live')).toBeVisible();

    const requestsBeforeRefresh = mock.runRequestCount();
    await page.getByRole('button', { name: 'Refresh control data' }).click();

    await expect.poll(mock.runRequestCount).toBe(requestsBeforeRefresh + 1);
    await expect(commandStatus(page, 'stale', 'Stale'))
        .toBeVisible();
    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Stale · unreachable');
    await expect(agentRow(page, 'agent-last-good')).toBeVisible();
    await expect(commandContextItem(page, 'Safe targets')).toContainText(
        '0 current · 1 last known',
    );
    await expect(controlBoard(page).getByText(
        '0 safe now · 1 last known targetable',
        { exact: true },
    )).toBeVisible();
    await expect(controlBoard(page).getByText('Blocked now', { exact: true })
        .locator('..')).toContainText('1');
    await expect(page.getByRole('region', { name: 'Control overview' }).getByText(
        'Last-known agent evidence is retained, but no target is currently safe.',
        { exact: true },
    )).toBeVisible();
});

test('renders a truthful live-empty control state', async ({ context, page }) => {
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: { runs: [], distributedRuns: [] },
    }]);

    await page.goto(RECIPE_CONSOLE_ROUTE);

    await expect(commandStatus(page, 'passed', 'Live'))
        .toBeVisible();
    const overview = page.getByRole('region', { name: 'Control overview' });
    await expect(overview.getByRole('heading', { name: 'No control runs' })).toBeVisible();
    await expect(overview.getByText(
        'The control server is live and currently reports no runs.',
        { exact: true },
    )).toBeVisible();
    await expect(controlBoard(page).locator('[data-control-agent-row]')).toHaveCount(0);
});

test('distinguishes reachable authorization failure from offline', async ({ context, page }) => {
    await installControlRouteMock(context, [{
        kind: 'http-error',
        status: 401,
        message: 'Operator token required.',
    }]);

    await page.goto(RECIPE_CONSOLE_ROUTE);

    await expect(commandStatus(page, 'warning', 'Authorization required'))
        .toBeVisible();
    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Authorization required · reachable');
    const overview = page.getByRole('region', { name: 'Control overview' });
    await expect(overview.getByRole('heading', { name: 'Authorization required' }))
        .toBeVisible();
    await expect(overview.getByText(
        'Control server reachable · authorization required',
        { exact: true },
    )).toBeVisible();
    await expect(overview).not.toContainText('Control server offline');
});

test('announces recovery from offline to live and restores canonical rows', async ({
    context,
    page,
}) => {
    await installControlRouteMock(context, [
        { kind: 'network-error' },
        { kind: 'snapshot', snapshot: liveBoardSnapshot() },
    ]);

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=control-canonical`);

    const announcedStatus = page.locator('[data-command-bar]').getByRole('status');
    await expect(announcedStatus).toHaveText('Offline · unreachable');
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await expect(announcedStatus).toHaveText('Live · reachable');
    await expect(agentRow(page, 'agent-matched')).toHaveAttribute(
        'data-target-status',
        'matched',
    );
});

test('preserves unavailable URL selections without collection-index fallback', async ({
    context,
    page,
}) => {
    const snapshot = liveBoardSnapshot();
    await installControlRouteMock(context, [{ kind: 'snapshot', snapshot }]);
    await page.goto(
        `${RECIPE_CONSOLE_ROUTE}&controlRunId=control-unavailable` +
        '&distributedRunId=distributed-unavailable&agentId=agent-unavailable',
    );

    await expect(commandContextItem(page, 'Control run'))
        .toContainText('control-unavailable');
    await expect(page.getByRole('list', { name: 'Control selection notices' }))
        .toContainText(
            'Control run control-unavailable is not present in the latest snapshot.',
        );
    await expect(page.getByRole('combobox', { name: 'Control run' })).toHaveValue('');
    await expect(controlBoard(page).locator('[data-control-agent-row]')).toHaveCount(0);
    const url = new URL(page.url());
    expect(url.searchParams.get('controlRunId')).toBe('control-unavailable');
    expect(url.searchParams.get('distributedRunId')).toBe('distributed-unavailable');
    expect(url.searchParams.get('agentId')).toBe('agent-unavailable');
});

test('commits, reloads, copies, and restores run and keyboard agent selections', async ({
    baseURL,
    context,
    page,
}) => {
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: new URL(baseURL ?? page.url()).origin },
    );
    const west = controlRun('control-west', [
        controlAgent('control-west', 'agent-west'),
    ]);
    const east = controlRun('control-east', [
        controlAgent('control-east', 'agent-east'),
    ]);
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: { runs: [east, west], distributedRuns: [] },
    }]);

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=control-west`);
    const runSelect = page.getByRole('combobox', { name: 'Control run' });
    await expect(runSelect).toHaveValue('control-west');

    await runSelect.focus();
    await expect(runSelect).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page).toHaveURL(/(?:\?|&)controlRunId=control-east(?:&|$)/);
    await expect(page).not.toHaveURL(/(?:\?|&)agentId=/);
    await expect(agentRow(page, 'agent-east')).toBeVisible();

    const eastAgent = agentRow(page, 'agent-east');
    await eastAgent.focus();
    await expect(eastAgent).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(eastAgent).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/(?:\?|&)agentId=agent-east(?:&|$)/);

    await page.goBack();
    await expect(runSelect).toHaveValue('control-east');
    await expect(page).not.toHaveURL(/(?:\?|&)agentId=/);
    await page.goBack();
    await expect(runSelect).toHaveValue('control-west');
    await expect(agentRow(page, 'agent-west')).toBeVisible();

    await page.goForward();
    await expect(runSelect).toHaveValue('control-east');
    await page.goForward();
    await expect(agentRow(page, 'agent-east')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/(?:\?|&)agentId=agent-east(?:&|$)/);

    await page.reload();
    await expect(runSelect).toHaveValue('control-east');
    await expect(agentRow(page, 'agent-east')).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    const copiedHref = await page.evaluate(() => navigator.clipboard.readText());
    const copied = new URL(copiedHref);
    expect(copied.searchParams.get('controlRunId')).toBe('control-east');
    expect(copied.searchParams.get('agentId')).toBe('agent-east');
    expect(copied.searchParams.has('controlUrl')).toBe(false);
});

test('owns one poll timer across views and clears it when Recipe Console unmounts', async ({
    context,
    page,
}) => {
    await page.addInitScript(() => {
        const active = new Map<number, number>();
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        Object.defineProperty(window, 'setTimeout', {
            configurable: true,
            value: (handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
                let id = 0;
                const wrapped = (...callbackArgs: unknown[]): void => {
                    active.delete(id);
                    if (typeof handler === 'function') {
                        handler(...callbackArgs);
                    }
                };
                id = nativeSetTimeout(wrapped, timeout, ...args);
                active.set(id, timeout ?? 0);
                return id;
            },
            writable: true,
        });
        Object.defineProperty(window, 'clearTimeout', {
            configurable: true,
            value: (id?: number): void => {
                if (id !== undefined) {
                    active.delete(id);
                    nativeClearTimeout(id);
                }
            },
            writable: true,
        });
        Object.defineProperty(window, '__recipeConsoleTimeoutProbe', {
            value: {
                activePolls: (): number =>
                    [...active.values()].filter(timeout => timeout === 5_000).length,
            },
        });
    });
    const activePolls = (): Promise<number> => page.evaluate(() =>
        (window as Window & {
            __recipeConsoleTimeoutProbe: { activePolls(): number };
        }).__recipeConsoleTimeoutProbe.activePolls()
    );
    const mock = await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: liveBoardSnapshot(),
    }]);

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=control-canonical`);
    await expect.poll(activePolls).toBe(1);
    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'monitor');
    await expect.poll(activePolls).toBe(1);
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'analyze');
    await expect.poll(activePolls).toBe(1);

    await page.evaluate(() => {
        history.pushState(
            {},
            '',
            '/?provider=simulated&experience=legacy&workspace=black-box-runner&tab=recipes',
        );
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);
    await expect.poll(activePolls).toBe(0);
    const requestsAfterUnmount = mock.runRequestCount();
    await page.waitForTimeout(5_500);
    expect(mock.runRequestCount()).toBe(requestsAfterUnmount);
});

test('keeps the connected board usable at tablet and portrait touch sizes', async ({
    context,
    page,
}) => {
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: liveBoardSnapshot(),
    }]);

    for (const viewport of [
        { width: 900, height: 900 },
        { width: 430, height: 932 },
    ]) {
        await page.setViewportSize(viewport);
        await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=control-canonical`);
        const closeInspector = page.getByRole('button', { name: 'Close inspector' });
        if (await closeInspector.isVisible()) {
            await closeInspector.click();
        }

        const board = controlBoard(page);
        await expect(board).toBeVisible();
        const runSelect = page.getByRole('combobox', { name: 'Control run' });
        expect((await runSelect.boundingBox())?.height)
            .toBeGreaterThanOrEqual(44);
        const rows = board.locator('[data-control-agent-row]');
        await expect(rows).toHaveCount(5);
        for (const bounds of await rows.evaluateAll(elements =>
            elements.map(element => {
                const rect = element.getBoundingClientRect();
                return { height: rect.height, width: rect.width };
            })
        )) {
            expect(bounds.height).toBeGreaterThanOrEqual(44);
            expect(bounds.width).toBeGreaterThanOrEqual(44);
        }

        const lastRow = agentRow(page, 'agent-missing-identity');
        await lastRow.scrollIntoViewIfNeeded();
        const reachable = await lastRow.evaluate((element) => {
            const row = element.getBoundingClientRect();
            const work = element.closest('[data-work-surface]')?.getBoundingClientRect();
            return Boolean(work) && row.top >= work!.top && row.bottom <= work!.bottom;
        });
        expect(reachable).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth))
            .toBeLessThanOrEqual(viewport.width);
    }
});

test('keeps the complete Execute workflow scrollable in mobile landscape', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 932, height: 430 });
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: liveBoardSnapshot(),
    }]);

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=control-canonical`);

    const workspace = page.locator('[data-execute-workspace]');
    await expect(workspace).toBeVisible();
    const scrollState = await workspace.evaluate(element => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
    }));
    expect(scrollState.overflowY).toBe('auto');
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);

    const start = page.getByRole('button', { name: 'Start Preview', exact: true });
    await start.scrollIntoViewIfNeeded();
    const withinWorkspace = await start.evaluate((element) => {
        const button = element.getBoundingClientRect();
        const owner = element.closest('[data-execute-workspace]')?.getBoundingClientRect();
        return Boolean(owner) && button.top >= owner!.top && button.bottom <= owner!.bottom;
    });
    expect(withinWorkspace).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(932);
});
