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
    | Readonly<{ kind: 'raw-snapshot'; snapshot: unknown }>
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
        distributedRunsPayload?: unknown;
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
                ? options.distributedRunsPayload ?? {
                    distributedRuns: options.distributedRunsFallback ?? [],
                }
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

function executeTargets(page: Page) {
    return page.locator('[data-execute-targets]');
}

function targetRow(page: Page, agentId: string) {
    return executeTargets(page).locator('[data-execute-target]').filter({
        has: page.getByText(agentId, { exact: true }),
    });
}

function executeActionBand(page: Page) {
    return page.locator('[data-execute-action-band]');
}

function targetEmptyState(page: Page) {
    return executeTargets(page).getByRole('status').filter({
        hasText: 'No current target evidence',
    });
}

function actionRequirement(page: Page, action: string) {
    return executeActionBand(page)
        .locator('[aria-label="Action requirements"]')
        .locator('p')
        .filter({ hasText: new RegExp(`^${action}:`) });
}

function controlRunPicker(page: Page) {
    const group = executeTargets(page).getByRole('group', { name: 'Control run' });
    return {
        group,
        search: group.getByRole('combobox', { name: 'Search Control run' }),
        trigger: group.getByRole('button', { name: /^Control run(?:\s|$)/u }),
    };
}

async function chooseControlRun(page: Page, runId: string): Promise<void> {
    const picker = controlRunPicker(page);
    await picker.trigger.focus();
    await expect(picker.trigger).toBeFocused();
    await picker.trigger.press('Enter');
    await expect(picker.search).toBeFocused();
    await picker.search.fill(runId);
    const option = picker.group.getByRole('option').filter({ hasText: runId });
    await expect(option).toHaveCount(1);
    await picker.search.press('Enter');
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

    const targets = executeTargets(page);
    await expect(targets).toBeVisible();
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

    await expect(controlRunPicker(page).trigger).toContainText('control-canonical');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(5);
    for (const [agentId, status] of [
        ['agent-matched', 'matched'],
        ['agent-stale', 'stale'],
        ['agent-offline', 'offline'],
        ['agent-wrong-group', 'different-group'],
        ['agent-missing-identity', 'missing-identity'],
    ] as const) {
        const row = targetRow(page, agentId);
        await expect(row).toHaveAttribute('data-target-status', status);
        await expect(row.getByText(TARGET_REASONS[status], { exact: true }))
            .toBeVisible();
        await expect(row.getByText(agentId, { exact: true })).toBeVisible();
        if (status === 'matched') {
            await expect(row.getByRole('checkbox', { name: `Select ${agentId}` }))
                .toBeChecked();
        } else {
            await expect(row.getByRole('checkbox')).toHaveCount(0);
            await expect(row.getByLabel('Not selectable')).toBeVisible();
        }
    }
    await expect(targets).not.toContainText('seed-agent-a');
    await expect(targets).not.toContainText('seed-agent-b');
});

test('shows initial network failure as offline without seeded board fallback', async ({
    context,
    page,
}) => {
    await installControlRouteMock(context, [{ kind: 'network-error' }]);

    await page.goto(RECIPE_CONSOLE_ROUTE);

    await expect(commandStatus(page, 'failed', 'Offline'))
        .toBeVisible();
    await expect(commandContextItem(page, 'Connected')).toContainText('Unknown');
    await expect(commandContextItem(page, 'Active run')).toContainText('Unknown');
    const targets = executeTargets(page);
    const empty = targetEmptyState(page);
    await expect(empty.getByText('No current target evidence', { exact: true }))
        .toBeVisible();
    await expect(empty.getByText(
        'Control is offline. Refresh to retry.',
        { exact: true },
    )).toBeVisible();
    const runPicker = controlRunPicker(page).trigger;
    await expect(runPicker).toContainText('Control runs unavailable');
    await expect(runPicker).not.toContainText('No control runs');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(0);
    await expect(targets).not.toContainText('seed-agent');
    await expect(executeActionBand(page).getByRole('button', { name: 'Refresh' }))
        .toBeEnabled();
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeDisabled();
    await expect(actionRequirement(page, 'Resolve targets'))
        .toHaveText('Resolve targets: Live or partial control truth is required.');
    await expect(actionRequirement(page, 'Create draft'))
        .toHaveText('Create draft: Complete live control truth is required.');
});

test('keeps malformed successful control responses reachable', async ({
    context,
    page,
}) => {
    await installControlRouteMock(context, [{
        kind: 'raw-snapshot',
        snapshot: { runs: null, distributedRuns: [] },
    }]);

    await page.goto(RECIPE_CONSOLE_ROUTE);

    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Control error · reachable');
    await expect(commandContextItem(page, 'Connected')).toContainText('Unknown');
    const targets = executeTargets(page);
    const empty = targetEmptyState(page);
    await expect(empty.getByText('No current target evidence', { exact: true }))
        .toBeVisible();
    await expect(empty.getByText(
        'Control is reachable but returned invalid data. Refresh to retry.',
        { exact: true },
    )).toBeVisible();
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeDisabled();
    await expect(actionRequirement(page, 'Resolve targets'))
        .toHaveText('Resolve targets: Live or partial control truth is required.');
});

test('contains nested malformed control snapshots before repository derivation', async ({
    context,
    page,
}) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await installControlRouteMock(context, [{
        kind: 'raw-snapshot',
        snapshot: {
            runs: [{ runId: 'run-malformed', agents: null }],
            distributedRuns: [],
        },
    }]);

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=run-malformed`);

    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Control error · reachable');
    await expect(targetEmptyState(page).getByText(
        'Control is reachable but returned invalid data. Refresh to retry.',
        { exact: true },
    )).toBeVisible();
    await expect(executeTargets(page).locator('[data-execute-target]')).toHaveCount(0);
    await expect(actionRequirement(page, 'Resolve targets'))
        .toHaveText('Resolve targets: Live or partial control truth is required.');
    expect(pageErrors).toEqual([]);
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
    const row = targetRow(page, 'agent-partial');
    await expect(row).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(row.getByRole('checkbox', { name: 'Select agent-partial' }))
        .toBeEnabled();
    await expect(commandContextItem(page, 'Safe targets')).toContainText('1');
    await expect(commandContextItem(page, 'Active run')).toContainText('Unknown');
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeEnabled();
    await expect(executeActionBand(page).getByRole('button', { name: 'Create draft' }))
        .toBeDisabled();
    await expect(actionRequirement(page, 'Create draft'))
        .toHaveText('Create draft: Complete live control truth is required.');
});

test('keeps usable rows when optional distributed context is malformed', async ({
    context,
    page,
}) => {
    const runId = 'control-partial-protocol';
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: {
            runs: [controlRun(runId, [controlAgent(runId, 'agent-partial-protocol')])],
        },
    }], {
        distributedRunsPayload: { distributedRuns: { invalid: true } },
    });

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=${runId}`);

    await expect(commandStatus(page, 'partial', 'Partial')).toBeVisible();
    const row = targetRow(page, 'agent-partial-protocol');
    await expect(row).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(row.getByRole('checkbox', { name: 'Select agent-partial-protocol' }))
        .toBeEnabled();
    await expect(commandContextItem(page, 'Active run')).toContainText('Unknown');
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeEnabled();
    await expect(actionRequirement(page, 'Create draft'))
        .toHaveText('Create draft: Complete live control truth is required.');
});

test('keeps agent rows usable while announcing distributed-context authorization', async ({
    context,
    page,
}) => {
    const runId = 'control-partial-auth';
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: {
            runs: [controlRun(runId, [controlAgent(runId, 'agent-partial-auth')])],
        },
    }], { distributedRunsStatus: 401 });

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=${runId}`);

    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Authorization required · reachable · partial');
    const row = targetRow(page, 'agent-partial-auth');
    await expect(row).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(row.getByRole('checkbox', { name: 'Select agent-partial-auth' }))
        .toBeEnabled();
    await expect(commandContextItem(page, 'Safe targets')).toContainText('1');
    await expect(commandContextItem(page, 'Active run')).toContainText('Unknown');
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeEnabled();
    await expect(actionRequirement(page, 'Create draft'))
        .toHaveText('Create draft: Complete live control truth is required.');
});

test('retains partial authorization when the configured token broker is unavailable', async ({
    context,
    page,
}) => {
    const runId = 'control-partial-broker-error';
    const brokerAuthorizations: string[] = [];
    await context.addInitScript(() => {
        localStorage.setItem('auth.session', JSON.stringify({
            clientId: 'configured-client',
            sessionId: 'configured-session',
            username: 'configured-user',
            accessToken: 'configured-session-token',
            expiresAtEpochMs: 4_000_000_000_000,
        }));
    });
    await context.route('https://api.example.invalid/**', async (route) => {
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'access-control-allow-origin': '*',
                    'access-control-allow-methods': 'POST, OPTIONS',
                    'access-control-allow-headers': 'authorization, x-client-id, content-type',
                },
            });
            return;
        }
        brokerAuthorizations.push(route.request().headers().authorization ?? 'missing');
        await fulfillJson(route, 503, { error: 'Configured token broker unavailable.' });
    });
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: {
            runs: [controlRun(runId, [
                controlAgent(runId, 'agent-partial-broker-error'),
            ])],
        },
    }], { distributedRunsStatus: 401 });

    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=${runId}`);

    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Authorization required · reachable · partial');
    const row = targetRow(page, 'agent-partial-broker-error');
    await expect(row).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(row.getByRole('checkbox', { name: 'Select agent-partial-broker-error' }))
        .toBeEnabled();
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeEnabled();
    await expect(actionRequirement(page, 'Create draft'))
        .toHaveText('Create draft: Complete live control truth is required.');
    expect(brokerAuthorizations).toEqual(['Bearer configured-session-token']);
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
                distributedRuns: [activeDistributedRun(runId, ['agent-last-good'])],
            },
        },
        { kind: 'network-error' },
    ]);
    await page.goto(`${RECIPE_CONSOLE_ROUTE}&controlRunId=${runId}`);
    await expect(targetRow(page, 'agent-last-good')).toHaveAttribute(
        'data-target-status',
        'matched',
    );
    await expect(commandStatus(page, 'passed', 'Live')).toBeVisible();
    await expect(commandContextItem(page, 'Active run')).toContainText(
        'dist-live-canonical · running',
    );

    const requestsBeforeRefresh = mock.runRequestCount();
    await page.getByRole('button', { name: 'Refresh control data' }).click();

    await expect.poll(mock.runRequestCount).toBe(requestsBeforeRefresh + 1);
    await expect(commandStatus(page, 'stale', 'Stale'))
        .toBeVisible();
    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Stale · unreachable');
    const lastKnownRow = targetRow(page, 'agent-last-good');
    await expect(lastKnownRow).toBeVisible();
    await expect(lastKnownRow.getByRole('checkbox')).toHaveCount(0);
    await expect(lastKnownRow.getByLabel('Not selectable')).toBeVisible();
    await expect(commandContextItem(page, 'Safe targets')).toContainText(
        '0 current · 1 last-known recipe-safe',
    );
    await expect(commandContextItem(page, 'Active run')).toContainText(
        'dist-live-canonical · running · last known',
    );
    await expect(executeTargets(page).getByText(
        'Last-known evidence · Stale',
        { exact: true },
    )).toBeVisible();
    await expect(executeTargets(page).getByText(
        'Target evidence is retained for diagnosis. Selection is disabled until current control truth returns.',
        { exact: true },
    )).toBeVisible();
    await expect(executeActionBand(page).getByRole('button', { name: 'Resolve targets' }))
        .toBeDisabled();
    await expect(actionRequirement(page, 'Resolve targets'))
        .toHaveText('Resolve targets: Live or partial control truth is required.');
});

test('renders a truthful live-empty control state', async ({ context, page }) => {
    await installControlRouteMock(context, [{
        kind: 'snapshot',
        snapshot: { runs: [], distributedRuns: [] },
    }]);

    await page.goto(RECIPE_CONSOLE_ROUTE);

    await expect(commandStatus(page, 'passed', 'Live'))
        .toBeVisible();
    const targets = executeTargets(page);
    const empty = targetEmptyState(page);
    await expect(empty.getByText('No current target evidence', { exact: true }))
        .toBeVisible();
    await expect(empty.getByText(
        'The selected live control run contains no target agents.',
        { exact: true },
    )).toBeVisible();
    await expect(controlRunPicker(page).trigger)
        .toContainText('Control runs unavailable');
    await expect(commandContextItem(page, 'Connected')).toContainText('0/0');
    await expect(commandContextItem(page, 'Active run')).toContainText('None');
    await expect(commandContextItem(page, 'Safe targets'))
        .toContainText('0 selected · 0 recipe-safe');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(0);
    await expect(actionRequirement(page, 'Resolve targets'))
        .toHaveText('Resolve targets: Select at least one current-safe target.');
});

for (const unresolvedCase of [
    {
        name: 'multiple unselected runs',
        routeSuffix: '',
    },
    {
        name: 'an unavailable explicit run',
        routeSuffix: '&controlRunId=missing-control-run',
    },
] as const) {
    test(`keeps ${unresolvedCase.name} non-authoritative`, async ({ context, page }) => {
        await installControlRouteMock(context, [{
            kind: 'snapshot',
            snapshot: {
                runs: [
                    controlRun('control-a', [controlAgent('control-a', 'agent-a')]),
                    controlRun('control-b', [controlAgent('control-b', 'agent-b')]),
                ],
                distributedRuns: [],
            },
        }]);

        await page.goto(`${RECIPE_CONSOLE_ROUTE}${unresolvedCase.routeSuffix}`);

        await expect(commandContextItem(page, 'Connected')).toContainText('Unknown');
        await expect(commandContextItem(page, 'Active run')).toContainText('Unknown');
        await expect(commandContextItem(page, 'Safe targets'))
            .toContainText('0 selected · 0 recipe-safe');
        const targets = executeTargets(page);
        const runPicker = controlRunPicker(page).trigger;
        if (unresolvedCase.routeSuffix) {
            await expect(runPicker).toContainText('Unavailable selection');
            await expect(runPicker).toContainText('missing-control-run');
        } else {
            await expect(runPicker).toContainText('Select a control run');
        }
        const empty = targetEmptyState(page);
        await expect(empty.getByText('No current target evidence', { exact: true }))
            .toBeVisible();
        await expect(empty.getByText(
            'The selected live control run contains no target agents.',
            { exact: true },
        )).toBeVisible();
        await expect(targets.locator('[data-execute-target]')).toHaveCount(0);
        await expect(targets).not.toContainText('agent-a');
        await expect(targets).not.toContainText('agent-b');
        if (unresolvedCase.routeSuffix) {
            await expect(targets.getByRole('alert')).toHaveText(
                'Control run missing-control-run is not present in the latest snapshot.',
            );
        }
        await expect(actionRequirement(page, 'Resolve targets'))
            .toHaveText('Resolve targets: Select at least one current-safe target.');
    });
}

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
    const targets = executeTargets(page);
    const empty = targetEmptyState(page);
    await expect(empty.getByText('No current target evidence', { exact: true }))
        .toBeVisible();
    await expect(empty.getByText(
        'Control authorization is required.',
        { exact: true },
    )).toBeVisible();
    await expect(targets).not.toContainText('Control is offline');
    await expect(actionRequirement(page, 'Resolve targets'))
        .toHaveText('Resolve targets: Live or partial control truth is required.');
});

test('keeps stored credentials away from URL-selected control and API origins', async ({
    context,
    page,
}) => {
    const controlAuthorizations: Array<string | null> = [];
    const brokerAuthorizations: Array<string | null> = [];
    await context.addInitScript(() => {
        localStorage.setItem('auth.session', JSON.stringify({
            clientId: 'victim-client',
            sessionId: 'victim-session',
            username: 'victim',
            accessToken: 'victim-primary-session-token',
            expiresAtEpochMs: 4_000_000_000_000,
        }));
    });
    await context.route('https://untrusted-control.test/**', async (route) => {
        const auth = route.request().headers().authorization ?? null;
        controlAuthorizations.push(auth);
        if (auth) {
            await fulfillJson(route, 200, { runs: [], distributedRuns: [] });
            return;
        }
        await fulfillJson(route, 401, { error: 'Operator token required.' });
    });
    await context.route('https://untrusted-api.test/**', async (route) => {
        brokerAuthorizations.push(route.request().headers().authorization ?? null);
        await fulfillJson(route, 200, {
            tokenType: 'Bearer',
            token: 'brokered-operator-secret',
            issuedAtEpochMs: Date.now(),
            expiresAtEpochMs: Date.now() + 3_600_000,
            ttlMs: 3_600_000,
        });
    });

    await page.goto(
        `${RECIPE_CONSOLE_ROUTE}` +
        '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol' +
        '&apiBaseUrl=https%3A%2F%2Funtrusted-api.test',
    );

    await expect(commandStatus(page, 'warning', 'Authorization required'))
        .toBeVisible();
    await expect(targetEmptyState(page).getByText(
        'Automatic credentials were withheld for this URL-selected control endpoint.',
        { exact: true },
    )).toBeVisible();
    await expect(actionRequirement(page, 'Create draft'))
        .toHaveText('Create draft: Complete live control truth is required.');
    expect(controlAuthorizations).toEqual([null]);
    expect(brokerAuthorizations).toEqual([]);
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
    await expect(targetRow(page, 'agent-matched')).toHaveAttribute(
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
    const targets = executeTargets(page);
    await expect(targets.getByRole('alert')).toHaveText(
        'Control run control-unavailable is not present in the latest snapshot.',
    );
    const runPicker = controlRunPicker(page).trigger;
    await expect(runPicker).toContainText('Unavailable selection');
    await expect(runPicker).toContainText('control-unavailable');
    await expect(runPicker).toHaveAttribute('aria-invalid', 'true');
    await expect(runPicker).toHaveAttribute(
        'aria-describedby',
        'execute-control-run-issue',
    );
    await expect(targets.locator('[data-execute-target]')).toHaveCount(0);
    const url = new URL(page.url());
    expect(url.searchParams.get('controlRunId')).toBe('control-unavailable');
    expect(url.searchParams.get('distributedRunId')).toBe('distributed-unavailable');
    expect(url.searchParams.get('agentId')).toBe('agent-unavailable');
});

test('commits, reloads, copies, and restores run selection while target checks stay bounded', async ({
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
    const runSelect = controlRunPicker(page).trigger;
    await expect(runSelect).toContainText('control-west');

    await chooseControlRun(page, 'control-east');
    await expect(page).toHaveURL(/(?:\?|&)controlRunId=control-east(?:&|$)/);
    await expect(page).not.toHaveURL(/(?:\?|&)agentId=/);
    const eastRow = targetRow(page, 'agent-east');
    await expect(eastRow).toBeVisible();
    const eastTarget = eastRow.getByRole('checkbox', { name: 'Select agent-east' });
    await expect(eastTarget).toBeChecked();
    await eastTarget.focus();
    await expect(eastTarget).toBeFocused();
    await page.keyboard.press('Space');
    await expect(eastTarget).not.toBeChecked();
    await expect(page).not.toHaveURL(/(?:\?|&)agentId=/);

    // Target selection is bounded draft state: it must not create a history entry.
    await page.goBack();
    await expect(runSelect).toContainText('control-west');
    await expect(targetRow(page, 'agent-west')).toBeVisible();

    await page.goForward();
    await expect(runSelect).toContainText('control-east');
    await expect(targetRow(page, 'agent-east')
        .getByRole('checkbox', { name: 'Select agent-east' }))
        .toBeChecked();
    await expect(page).not.toHaveURL(/(?:\?|&)agentId=/);

    await page.reload();
    await expect(runSelect).toContainText('control-east');
    await expect(targetRow(page, 'agent-east')
        .getByRole('checkbox', { name: 'Select agent-east' }))
        .toBeChecked();
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    const copiedHref = await page.evaluate(() => navigator.clipboard.readText());
    const copied = new URL(copiedHref);
    expect(copied.searchParams.get('controlRunId')).toBe('control-east');
    expect(copied.searchParams.has('agentId')).toBe(false);
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

        const targets = executeTargets(page);
        await expect(targets).toBeVisible();
        const runSelect = controlRunPicker(page).trigger;
        expect((await runSelect.boundingBox())?.height)
            .toBeGreaterThanOrEqual(44);
        const rows = targets.locator('[data-execute-target]');
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

        const lastRow = targetRow(page, 'agent-missing-identity');
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

    const actionBand = executeActionBand(page);
    await expect(actionBand).toBeVisible();
    const resolve = actionBand.getByRole('button', { name: 'Resolve targets' });
    await expect(resolve).toBeEnabled();
    await resolve.scrollIntoViewIfNeeded();
    const withinWorkspace = await resolve.evaluate((element) => {
        const button = element.getBoundingClientRect();
        const owner = element.closest('[data-execute-workspace]')?.getBoundingClientRect();
        return Boolean(owner) && button.top >= owner!.top && button.bottom <= owner!.bottom;
    });
    expect(withinWorkspace).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(932);
});
