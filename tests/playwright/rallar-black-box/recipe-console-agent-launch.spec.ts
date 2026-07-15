import {
    expect,
    test,
    type BrowserContext,
    type Page,
    type Route,
} from '@playwright/test';
import type {
    ControlAgentSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const EXECUTE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&applicationId=rallar-server&workspaceId=default&roomId=execute-live-group';

test('opens three browser agents and selects the exact registered cohort from current UI controls', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context);
    await page.goto(EXECUTE_ROUTE);

    await page.getByLabel('Control run ID for new agents').fill('human-flow-run');
    await page.getByLabel('Agent ID prefix').fill('human-agent');
    await page.getByLabel('Agent count').fill('3');
    const childPages: Page[] = [];
    context.on('page', child => {
        if (child !== page) childPages.push(child);
    });
    await page.getByRole('button', { name: 'Open 3 browser agents' }).click();
    await expect.poll(() => childPages.length).toBe(3);

    await expect(page.getByText(
        '3 launched browser agents are ready and selected as targets.',
        { exact: true },
    )).toBeVisible();
    await expect(page.locator('[data-execute-targets]')).toContainText('3 selected');
    expect(control.tokenRequests).toHaveLength(3);
    expect(new Set(control.tokenRequests.map(value => value.agentId)).size).toBe(3);
    expect(control.tokenRequests.every(value => value.runId === 'human-flow-run'))
        .toBe(true);
    for (const child of childPages) await child.close();
});

test('lets an operator replace an already selected control run ID', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(EXECUTE_ROUTE);

    const runId = page.getByLabel('Control run ID for new agents');
    await runId.fill('selected-run');
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();
    await expect(page).toHaveURL(/controlRunId=selected-run/);
    await expect(runId).toHaveValue('selected-run');

    await runId.fill('replacement-run');
    await expect(runId).toHaveValue('replacement-run');
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();

    await expect.poll(() => control.tokenRequests.slice(-3)).toEqual([
        expect.objectContaining({ runId: 'replacement-run' }),
        expect.objectContaining({ runId: 'replacement-run' }),
        expect.objectContaining({ runId: 'replacement-run' }),
    ]);
});

test('holds lifecycle actions while a new cohort registers beside existing agents', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context, {
        registerOnToken: false,
        initialAgents: [{ runId: 'cohort-run', agentId: 'existing-agent' }],
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=cohort-run`);

    await page.getByRole('button', { name: 'Add browser agents' }).click();
    await page.getByLabel('Agent ID prefix').fill('new-cohort');
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();

    const runway = page.locator('[data-execute-action-runway]');
    await expect(runway.getByRole('heading', {
        name: '0 of 3 browser agents ready',
    })).toBeVisible();
    await expect(runway.getByRole('button', { name: /Resolve/ })).toHaveCount(0);
    await expect(runway.getByRole('status')).toContainText(
        '0 of 3 browser agents ready',
    );
    expect(control.tokenRequests).toHaveLength(3);

    control.registerAgent('cohort-run', control.tokenRequests[0].agentId);
    await runway.getByRole('button', { name: 'Refresh' }).click();
    await expect(runway.getByRole('status')).toContainText(
        '1 of 3 browser agents ready',
    );
});

test('blocks lifecycle actions while launch authority is prepared and recovers after a run switch', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context, {
        holdTokenResponses: true,
        initialAgents: [
            { runId: 'pending-run', agentId: 'pending-existing' },
            { runId: 'other-run', agentId: 'other-existing' },
        ],
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=pending-run`);
    await page.getByRole('button', { name: 'Add browser agents' }).click();
    await page.getByLabel('Agent ID prefix').fill('pending-cohort');
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();
    await expect.poll(() => control.tokenRequests.length).toBe(3);

    const runway = page.locator('[data-execute-action-runway]');
    await expect(runway.getByRole('button', { name: /Resolve|Create draft/ }))
        .toHaveCount(0);
    await expect(runway.getByRole('status')).toContainText(
        '0 of 3 browser agents ready',
    );

    await chooseControlRun(page, 'other-run');
    control.releaseTokenResponses();
    await expect(page).toHaveURL(/controlRunId=other-run/);
    await expect(page.getByRole('button', { name: 'Copy 3 launch links' }))
        .toBeEnabled();
    await expect(runway.getByRole('button', { name: 'Resolve 1 target' }))
        .toBeVisible();
});

test('clears completed cohort gating when the selected control run changes', async ({
    context,
    page,
}) => {
    await installAgentLaunchControl(context, {
        registerOnToken: false,
        initialAgents: [
            { runId: 'first-run', agentId: 'first-existing' },
            { runId: 'second-run', agentId: 'second-existing' },
        ],
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=first-run`);
    await page.getByRole('button', { name: 'Add browser agents' }).click();
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();
    await expect(page.locator('[data-execute-action-runway]').getByRole('status'))
        .toContainText('0 of 3 browser agents ready');

    await chooseControlRun(page, 'second-run');
    await expect(page.locator('[data-execute-action-runway]')
        .getByRole('button', { name: 'Resolve 1 target' })).toBeVisible();
});

test('allows manual target adjustment after the launched cohort is selected', async ({
    context,
    page,
}) => {
    await installAgentLaunchControl(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(EXECUTE_ROUTE);
    await page.getByLabel('Control run ID for new agents').fill('adjust-run');
    await page.getByLabel('Agent ID prefix').fill('adjust-agent');
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();
    await expect(page.locator('[data-execute-targets]')).toContainText('3 selected');

    const firstTarget = page.locator('[data-execute-target]').first();
    await firstTarget.getByRole('checkbox').uncheck();
    await expect(page.locator('[data-execute-targets]')).toContainText('2 selected');
    await expect(page.locator('[data-execute-action-runway]')
        .getByRole('button', { name: 'Resolve 2 targets' })).toBeVisible();
});

test('explains popup blocking without minting and keeps copy-link fallback usable', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context, {
        registerOnToken: false,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
        Object.defineProperty(window, 'open', {
            configurable: true,
            value: () => null,
        });
    });
    await page.goto(EXECUTE_ROUTE);

    await page.getByLabel('Control run ID for new agents').fill('blocked-run');
    await page.getByLabel('Agent ID prefix').fill('blocked-agent');
    await page.getByLabel('Agent count').fill('3');
    await page.getByRole('button', { name: 'Open 3 browser agents' }).click();

    await expect(
        page.locator('[data-execute-agent-setup]').getByRole('status'),
    ).toContainText(
        'Your browser blocked all 3 agent tabs. Copy the launch links instead.',
    );
    const copyLinks = page.getByRole('button', { name: 'Copy 3 launch links' });
    await expect(copyLinks).toBeEnabled();
    await expect(copyLinks).toBeFocused();
    expect(control.tokenRequests).toHaveLength(0);
    const individualLinks = page
        .getByRole('group', { name: 'Individual browser-agent launch links' })
        .getByRole('button', { name: /^Copy link for blocked-agent-/ });
    await expect(individualLinks).toHaveCount(3);
    await individualLinks.first().click();
    await expect(
        page.locator('[data-execute-agent-setup]').getByRole('status'),
    ).toContainText('Copied 1 fresh, short-lived launch link.');
    expect(control.tokenRequests).toHaveLength(1);
    await page.getByRole('button', { name: 'Copy 3 launch links' }).click();
    await expect(
        page.locator('[data-execute-agent-setup]').getByRole('status'),
    ).toContainText('Copied 3 fresh, short-lived launch links.');
    expect(control.tokenRequests).toHaveLength(4);
});

test('replaces an unopened copied cohort when the whole batch is copied again', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context, {
        registerOnToken: false,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(EXECUTE_ROUTE);
    await page.getByLabel('Control run ID for new agents').fill('recopy-run');
    await page.getByLabel('Agent ID prefix').fill('recopy-agent');

    const copyLinks = page.getByRole('button', { name: 'Copy 3 launch links' });
    await copyLinks.click();
    await expect.poll(() => control.tokenRequests.length).toBe(3);
    const firstAgentIds = control.tokenRequests.map(request => request.agentId);

    await copyLinks.click();
    await expect.poll(() => control.tokenRequests.length).toBe(6);
    const replacementAgentIds = control.tokenRequests.slice(3)
        .map(request => request.agentId);
    expect(replacementAgentIds).not.toEqual(firstAgentIds);

    for (const agentId of replacementAgentIds) {
        control.registerAgent('recopy-run', agentId);
    }
    await page.locator('[data-execute-action-runway]')
        .getByRole('button', { name: 'Refresh' }).click();

    await expect(page.locator('[data-execute-targets]')).toContainText('3 selected');
    await expect(page.locator('[data-execute-action-runway]')
        .getByRole('button', { name: 'Resolve 3 targets' })).toBeVisible();
    await expect(page.locator('[data-execute-action-runway]'))
        .not.toContainText('3 of 6 browser agents ready');
});

test('mints only reserved tabs and keeps each partially blocked identity copyable', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
        const nativeOpen = window.open.bind(window);
        let callCount = 0;
        Object.defineProperty(window, 'open', {
            configurable: true,
            value: (...args: Parameters<typeof window.open>) => {
                callCount += 1;
                return callCount === 2 ? null : nativeOpen(...args);
            },
        });
    });
    await page.goto(EXECUTE_ROUTE);
    await page.getByLabel('Control run ID for new agents').fill('partial-run');
    await page.getByLabel('Agent ID prefix').fill('partial-agent');
    await page.getByLabel('Agent count').fill('3');

    const childPages: Page[] = [];
    context.on('page', child => {
        if (child !== page) childPages.push(child);
    });
    await page.getByRole('button', { name: 'Open 3 browser agents' }).click();
    await expect.poll(() => childPages.length).toBe(2);
    await expect(
        page.locator('[data-execute-agent-setup]').getByRole('status'),
    ).toContainText('2 launched browser agents are ready and selected as targets.');
    expect(control.tokenRequests).toHaveLength(2);

    const blockedFallback = page.getByRole('group', {
        name: 'Popup-blocked browser-agent launch links',
    });
    const copyBlocked = blockedFallback.getByRole('button', {
        name: /^Copy link for partial-agent-/,
    });
    await expect(copyBlocked).toHaveCount(1);
    await copyBlocked.click();
    expect(control.tokenRequests).toHaveLength(3);
    await expect(
        page.locator('[data-execute-agent-setup]').getByRole('status'),
    ).toContainText('3 launched browser agents are ready and selected as targets.');
    for (const child of childPages) await child.close();
});

test('gates missing launch identity and browser-rallar authentication in the visible setup', async ({
    context,
    page,
}) => {
    const control = await installAgentLaunchControl(context);
    await page.goto(EXECUTE_ROUTE);

    const setup = page.locator('[data-execute-agent-setup]');
    await page.getByLabel('Control run ID for new agents').fill('');
    await expect(setup.getByRole('alert')).toHaveText(
        'Enter a control run ID before launching agents.',
    );
    await expect(setup.getByRole('button', { name: 'Open 3 browser agents' }))
        .toBeDisabled();

    await page.getByLabel('Control run ID for new agents').fill('gated-run');
    await page.getByLabel('Agent ID prefix').fill('');
    await expect(setup.getByRole('alert')).toHaveText(
        'Enter an agent ID prefix before launching agents.',
    );

    await page.goto(EXECUTE_ROUTE.replace('provider=simulated', 'provider=browser-rallar'));
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(control.tokenRequests).toHaveLength(0);
});

async function installAgentLaunchControl(
    context: BrowserContext,
    options: Readonly<{
        registerOnToken?: boolean;
        holdTokenResponses?: boolean;
        initialAgents?: readonly Readonly<{ runId: string; agentId: string }>[];
    }> = {},
) {
    const agents = new Map<string, ControlAgentSnapshot>();
    for (const agent of options.initialAgents ?? []) {
        agents.set(agent.agentId, connectedAgent(agent.runId, agent.agentId));
    }
    const tokenRequests: Array<{ runId: string; agentId: string }> = [];
    let releaseTokenResponses = () => undefined;
    const tokenResponseGate = options.holdTokenResponses
        ? new Promise<void>(resolve => {
            releaseTokenResponses = resolve;
        })
        : undefined;
    await context.route(CONTROL_ROUTE, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const tokenMatch = url.pathname.match(
            /^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/,
        );
        if (request.method() === 'POST' && tokenMatch) {
            const runId = decodeURIComponent(tokenMatch[1]);
            const agentId = decodeURIComponent(tokenMatch[2]);
            tokenRequests.push({ runId, agentId });
            await tokenResponseGate;
            if (options.registerOnToken !== false) {
                agents.set(agentId, connectedAgent(runId, agentId));
            }
            await fulfillJson(route, {
                runId,
                agentId,
                token: `secret-${agentId}`,
                issuedAtEpochMs: Date.now(),
                expiresAtEpochMs: Date.now() + 60_000,
            }, 201);
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            const byRun = new Map<string, ControlAgentSnapshot[]>();
            for (const agent of agents.values()) {
                const rows = byRun.get(agent.runId) ?? [];
                rows.push(agent);
                byRun.set(agent.runId, rows);
            }
            const now = Date.now();
            const runs: ControlRunSnapshot[] = [...byRun].map(([runId, rows]) => ({
                runId,
                createdAtEpochMs: now - 1_000,
                updatedAtEpochMs: now,
                agents: rows,
                commands: [], results: [], events: [], stats: [], reports: [], heartbeats: [],
            }));
            await fulfillJson(route, { runs, distributedRuns: [] });
            return;
        }
        await fulfillJson(route, { error: 'Not found.' }, 404);
    });
    return {
        tokenRequests,
        registerAgent: (runId: string, agentId: string) => {
            agents.set(agentId, connectedAgent(runId, agentId));
        },
        releaseTokenResponses,
    };
}

async function chooseControlRun(page: Page, runId: string): Promise<void> {
    const group = page.locator('[data-execute-targets]')
        .getByRole('group', { name: 'Control run' });
    const trigger = group.getByRole('button', { name: /^Control run(?:\s|$)/u });
    await trigger.click();
    const search = group.getByRole('combobox', { name: 'Search Control run' });
    await search.fill(runId);
    await search.press('Enter');
}

function connectedAgent(runId: string, agentId: string): ControlAgentSnapshot {
    const now = Date.now();
    return {
        runId,
        agentId,
        connected: true,
        registeredAtEpochMs: now,
        lastSeenAtEpochMs: now,
        lastHeartbeatAtEpochMs: now,
        status: 'connected',
        identity: {
            principalId: agentId,
            sessionId: `${agentId}-session`,
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'execute-live-group',
            providerMode: 'simulated',
            browserName: 'chromium',
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
    });
}
