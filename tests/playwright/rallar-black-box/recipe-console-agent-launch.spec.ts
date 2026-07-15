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
    await expect(page.getByRole('button', { name: 'Copy 3 launch links' }))
        .toBeEnabled();
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
    options: Readonly<{ registerOnToken?: boolean }> = {},
) {
    const agents = new Map<string, ControlAgentSnapshot>();
    const tokenRequests: Array<{ runId: string; agentId: string }> = [];
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
    return { tokenRequests };
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
