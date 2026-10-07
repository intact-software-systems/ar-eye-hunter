import {
    expect,
    test,
    type BrowserContext,
    type Page
} from '@playwright/test';

import type { ControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { DISTRIBUTED_RECIPE_CATALOG } from '../../../packages/shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedRunManifest
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

import {
    createExecuteAgent,
    createExecuteLiveSnapshot,
    createExecutePressureSnapshot,
    createExecuteRunSnapshot,
    EXECUTE_API_ROUTE,
    EXECUTE_CONTROL_GROUP,
    EXECUTE_CONTROL_ROUTE,
    fulfillExecuteJsonResponse,
    installExecuteControlFixture
} from './recipe-console-execute-control-fixture.ts';

const EXECUTE_ROUTE = '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&applicationId=rallar-server&workspaceId=default&roomId=execute-live-group';

interface ExecuteFetchGate {
    pathname: string;
    started: boolean;
    release(): void;
}

interface ExecuteFetchWindow extends Window {
    readonly __executeFetchGate?: ExecuteFetchGate;
}

async function installAbortIgnoringFetchGate(
    context: BrowserContext,
    pathname: string
): Promise<void> {
    await context.addInitScript((deferredPathname) => {
        const originalFetch = window.fetch.bind(window);
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const state = {
            pathname: deferredPathname,
            started: false,
            release
        };
        Object.defineProperty(window, '__executeFetchGate', {
            configurable: true,
            value: state
        });
        window.fetch = async (input, init) => {
            const url = new URL(
                typeof input === 'string' ? input : input instanceof URL
                    ? input.href
                    : input.url,
                location.href
            );
            if (url.pathname !== state.pathname) {
                return originalFetch(input, init);
            }
            state.started = true;
            await gate;
            const withoutSignal = init ? { ...init, signal: undefined } : init;
            return originalFetch(input, withoutSignal);
        };
    }, pathname);
}

async function waitForAbortIgnoringFetch(page: Page): Promise<void> {
    await page.waitForFunction(() =>
        Boolean(
            (window as ExecuteFetchWindow).__executeFetchGate?.started
        )
    );
}

async function releaseAbortIgnoringFetch(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as ExecuteFetchWindow).__executeFetchGate?.release();
    });
}

async function changeExecuteRecipeFromHistory(
    page: Page,
    recipeId = 'expected-failure-recipe'
): Promise<void> {
    await page.evaluate((nextRecipeId) => {
        const url = new URL(location.href);
        url.searchParams.set('recipeId', nextRecipeId);
        url.searchParams.delete('distributedRunId');
        history.pushState(null, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
    }, recipeId);
}

async function visibleExecuteManifest(
    page: Page
): Promise<RallarBlackBoxDistributedRunManifest> {
    const manifest = page.getByLabel('Generated distributed run manifest');
    if (await manifest.count() === 0) {
        await page.locator('[data-execute-manifest] summary').click();
        await expect(manifest).toHaveCount(1);
    }
    const raw = await manifest.textContent();
    if (!raw) {
        throw new Error('Generated Execute manifest is unavailable.');
    }
    return JSON.parse(raw) as RallarBlackBoxDistributedRunManifest;
}

async function openCompositeExecuteSelection(page: Page): Promise<void> {
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    const selectedRecipe = page.locator(
        '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]'
    );
    await selectedRecipe.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await selectedRecipe.focus();
    await page.keyboard.press('Enter');
}

async function createDraftThroughVisibleControls(page: Page): Promise<void> {
    await openCompositeExecuteSelection(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
}

for (
    const mode of [
        { label: 'Inherit', value: '', expected: undefined },
        { label: 'Off', value: 'off', expected: 'off' },
        { label: 'Signaling', value: 'signaling', expected: 'signaling' },
        { label: 'Full native', value: 'native', expected: 'native' }
    ] as const
) {
    test(`offers a separate capture choice for a new Console run without rewriting its recipe (${mode.label})`, async ({ context, page }) => {
        const control = await installExecuteControlFixture(context, { operatorSession: true });
        await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
        const selectedRecipe = page.locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]'
        );
        await selectedRecipe.click();
        await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-execute-targets]').getByRole('checkbox')).toHaveCount(2);
        const original = await visibleExecuteManifest(page);
        expect(original.recipes[0]?.recipe?.recipeId).toBe('composite-evidence-recipe');
        expect(original.rtcCaptureMode).toBeUndefined();

        const capture = page.locator('[data-execute-workspace]').getByRole('combobox', { name: /RTC capture/i });
        await expect(capture).toBeVisible();
        await expect(capture.locator('option')).toHaveText(['Inherit', 'Off', 'Signaling', 'Full native']);
        await expect(capture).toHaveValue('');
        await capture.selectOption(mode.value);
        expect((await visibleExecuteManifest(page)).recipes).toEqual(original.recipes);
        const actions = page.locator('[data-execute-action-runway]');
        await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
        await expect(actions.getByRole('button', { name: 'Create draft', exact: true })).toBeEnabled();
        const resolution = control.successfulWrites.find((request) =>
            request.path === '/distributed-runs/resolve-targets'
        );
        expect(resolution?.manifest?.rtcCaptureMode).toBe(mode.expected);
        expect(resolution?.manifest?.recipes).toEqual(original.recipes);
        expect(Object.hasOwn(resolution?.manifest ?? {}, 'rtcCaptureMode')).toBe(mode.expected !== undefined);
        await capture.selectOption(mode.value === 'signaling' ? 'off' : 'signaling');
        await expect(actions.getByRole('button', { name: 'Create draft', exact: true })).toHaveCount(0);
        await capture.selectOption(mode.value);
        await expect(actions.getByRole('button', { name: 'Create draft', exact: true })).toBeEnabled();

        await actions.getByRole('button', { name: 'Create draft', exact: true }).click();
        await expect(page.locator('[data-execute-run-status]')).toHaveAttribute('data-run-state', 'draft');
        const create = control.successfulWrites.find((request) => request.path === '/distributed-runs');
        expect(create?.manifest?.rtcCaptureMode).toBe(mode.expected);
        expect(create?.manifest?.recipes).toEqual(original.recipes);
        expect(Object.hasOwn(create?.manifest ?? {}, 'rtcCaptureMode')).toBe(mode.expected !== undefined);
        await expect(capture).toBeDisabled();
        await expect(capture).toHaveValue(mode.value);
        await actions.getByRole('button', { name: /Stage \d+ agents/ }).click();
        await expect(page.locator('[data-execute-run-status]')).toHaveAttribute('data-run-state', 'ready');
        await actions.getByRole('button', { name: 'Review and start', exact: true }).click();
        await page.getByRole('dialog', { name: 'Start distributed run?' })
            .getByRole('button', { name: 'Start distributed run', exact: true }).click();
        await expect(page.locator('[data-execute-run-status]')).toHaveAttribute('data-run-state', 'running');
        expect((await visibleExecuteManifest(page)).rtcCaptureMode).toBe(mode.expected);
        expect((await visibleExecuteManifest(page)).recipes).toEqual(original.recipes);
    });
}

test('launches agents and runs a simulated distributed ACK recipe through visible controls', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, {
        operatorSession: true,
        snapshot: { runs: [], distributedRuns: [] },
        enableAgentLaunch: true
    });
    await page.goto(EXECUTE_ROUTE);
    await page.getByRole('option', { name: /Composite Evidence/ }).click();
    await page.getByLabel('Control run ID for new agents').fill('execute-control-a');
    await page.getByLabel('Agent ID prefix').fill('execute-agent');
    await page.getByLabel('Agent count').fill('3');
    const childPages: Page[] = [];
    context.on('page', (child) => {
        if (child !== page) {
            childPages.push(child);
        }
    });
    await page.getByRole('button', { name: 'Open 3 browser agents' }).click();
    await expect.poll(() => childPages.length).toBe(3);
    await expect(page.getByText(
        '3 launched browser agents are ready and selected as targets.',
        { exact: true }
    )).toBeVisible();

    const actions = page.locator('[data-execute-action-runway]');
    await expect(
        actions.getByRole('button', { name: 'Resolve 3 targets' })
    ).toBeEnabled();
    await expect(actions.getByRole('button', { name: 'Create draft' }))
        .toHaveCount(0);
    await actions.getByRole('button', { name: 'Resolve 3 targets' }).click();
    await expect(
        actions.getByRole('button', { name: 'Create draft', exact: true })
    ).toBeEnabled();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();

    const status = page.locator('[data-execute-run-status]');
    await expect(status).toHaveAttribute('data-run-state', 'draft');
    await expect(page).toHaveURL(/(?:\?|&)distributedRunId=dist-/);
    await expect(
        page.getByText(
            'Targets are locked to the authoritative created run manifest.',
            { exact: true }
        )
    ).toBeVisible();
    await actions
        .getByRole('button', { name: 'Stage 3 agents', exact: true })
        .click();
    await expect(status).toHaveAttribute('data-run-state', 'waiting-for-ack');
    await expect(status).toHaveAttribute('data-run-state', 'ready');

    await actions
        .getByRole('button', { name: 'Review and start', exact: true })
        .click();
    const startDialog = page.getByRole('dialog', {
        name: 'Start distributed run?'
    });
    await expect(startDialog).toBeVisible();
    await startDialog.getByRole('button', { name: 'Start distributed run' })
        .click();
    await expect(status).toHaveAttribute('data-run-state', 'running');
    await actions.getByRole('button', { name: 'Monitor run' }).click();
    await expect(page).toHaveURL(/(?:\?|&)view=monitor(?:&|$)/);
    await expect(page).toHaveURL(/(?:\?|&)controlRunId=execute-control-a(?:&|$)/);
    await expect(page).toHaveURL(/(?:\?|&)distributedRunId=dist-/);

    const create = mock.successfulWrites.find(
        (request) => request.path === '/distributed-runs'
    );
    expect(create?.manifest).toMatchObject({
        controlRunId: 'execute-control-a',
        recipes: [{ recipeId: 'composite-evidence-recipe' }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: expect.arrayContaining(mock.tokenRequests.map((value) => value.agentId)),
            expectedParticipantCount: 3
        },
        metadata: { rolePattern: 'all-agents' },
        ackTimeoutMs: 15_000,
        startMode: 'manual'
    });
    expect(mock.successfulWrites.map((request) => request.path)).toEqual([
        '/distributed-runs/resolve-targets',
        '/distributed-runs/resolve-targets',
        '/distributed-runs',
        '/distributed-runs/resolve-targets',
        expect.stringMatching(/\/stage$/),
        expect.stringMatching(/\/start$/)
    ]);
    expect(
        mock.successfulWrites.every(
            (request) =>
                request.authorization ===
                    'Bearer execute-brokered-operator-token'
        )
    ).toBe(true);
    expect(mock.brokerAuthorizations).toEqual([
        'Bearer execute-primary-session-token'
    ]);
    expect(mock.tokenRequests).toHaveLength(3);
    expect(new Set(mock.tokenRequests.map((value) => value.agentId)).size).toBe(3);
    expect(mock.tokenRequests.every((value) => value.runId === 'execute-control-a'))
        .toBe(true);
    await expect(page.locator('textarea')).toHaveCount(0);

    const passedUrl = new URL(page.url());
    const passedDistributedRunId = passedUrl.searchParams.get('distributedRunId');
    expect(passedUrl.searchParams.get('controlRunId')).toBe('execute-control-a');
    expect(passedDistributedRunId).toMatch(/^dist-/);
    const monitorUrl = new URL(page.url());
    expect(monitorUrl.searchParams.get('controlRunId')).toBe('execute-control-a');
    expect(monitorUrl.searchParams.get('distributedRunId')).toBe(
        passedDistributedRunId
    );
    const monitorVerdict = page.locator('[data-monitor-section="verdict"]');
    await expect(monitorVerdict).toHaveAttribute('data-run-state', 'passed');
    await expect(monitorVerdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(monitorVerdict.locator('[data-status="passed"]')).toContainText('Passed');
    for (const child of childPages) {
        await child.close();
    }
});

test('generates a fresh run ID when the same recipe starts another run', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, { operatorSession: true });
    await createDraftThroughVisibleControls(page);
    const firstRunId = new URL(page.url()).searchParams.get('distributedRunId');
    expect(firstRunId).toMatch(/^dist-/);

    const selectedRecipe = page.locator(
        '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]'
    );
    await selectedRecipe.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await selectedRecipe.focus();
    await page.keyboard.press('Enter');
    await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
    const secondManifest = await visibleExecuteManifest(page);
    expect(secondManifest.distributedRunId).not.toBe(firstRunId);

    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();

    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
    await expect(page).toHaveURL(
        new RegExp(`(?:\\?|&)distributedRunId=${secondManifest.distributedRunId}(?:&|$)`)
    );
    expect(
        mock.successfulWrites.filter(
            (request) => request.path === '/distributed-runs'
        )
    ).toHaveLength(2);
});

test('advances after Resolve while root reconciliation waits for an earlier read', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, { operatorSession: true });
    await openCompositeExecuteSelection(page);
    const actions = page.locator('[data-execute-action-runway]');

    mock.deferNextRunRead();
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await mock.waitForDeferredRunRead();
    const readsBeforeResolve = mock.runRequestCount();

    try {
        await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
        await expect(
            actions.getByRole('button', { name: 'Create draft', exact: true })
        ).toBeEnabled({ timeout: 1_000 });
        expect(mock.successfulWrites.map((request) => request.path)).toEqual([
            '/distributed-runs/resolve-targets'
        ]);
        expect(mock.runRequestCount()).toBe(readsBeforeResolve);
    }
    finally {
        mock.releaseDeferredRunRead();
    }

    await expect.poll(() => mock.runRequestCount())
        .toBeGreaterThan(readsBeforeResolve);
});

test('queues a post-mutation read behind a preexisting control refresh', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, { operatorSession: true });
    await openCompositeExecuteSelection(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();

    mock.deferNextRunRead();
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await mock.waitForDeferredRunRead();
    const readsWithPreMutationRequestPending = mock.runRequestCount();

    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect.poll(() =>
        mock.successfulWrites.filter(
            (request) => request.path === '/distributed-runs'
        ).length
    ).toBe(1);
    mock.releaseDeferredRunRead();

    await expect.poll(
        () => mock.runRequestCount(),
        { timeout: 1_500 }
    ).toBeGreaterThan(readsWithPreMutationRequestPending);
    await expect(actions).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
});

test('diagnoses non-targetable agents before staging', async ({ context, page }) => {
    const controlRunId = 'execute-control-blocked';
    const now = Date.now();
    const run: ControlRunSnapshot = {
        runId: controlRunId,
        createdAtEpochMs: now - 10_000,
        updatedAtEpochMs: now,
        agents: [
            createExecuteAgent(controlRunId, 'agent-safe'),
            createExecuteAgent(controlRunId, 'agent-offline', { connected: false }),
            createExecuteAgent(controlRunId, 'agent-other-group', {
                groupId: 'other-group'
            })
        ],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
    await installExecuteControlFixture(context, { snapshot: { runs: [run], distributedRuns: [] } });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=${controlRunId}`);

    const targets = page.locator('[data-execute-targets]');
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        1
    );
    await expect(targets.locator('[data-target-status="offline"]')).toHaveCount(
        1
    );
    await expect(
        targets.locator('[data-target-status="different-group"]')
    ).toHaveCount(1);
    await expect(targets.getByRole('checkbox')).toHaveCount(1);
    await expect(targets).toContainText('disconnected from the control server');
    await expect(targets).toContainText(
        'does not match the selected global group'
    );
    await expect(
        page
            .locator('[data-execute-action-runway]')
            .getByRole('button', { name: /Stage \d+ agents/ })
    ).toHaveCount(0);
    await expect(
        page
            .locator('[data-execute-action-runway]')
            .getByRole('button', { name: /Resolve \d+ targets/ })
    ).toBeEnabled();
});

test('restores an existing Execute run from a copied v1 URL', async ({ context, page }) => {
    const control = createExecuteLiveSnapshot();
    const catalogItem = DISTRIBUTED_RECIPE_CATALOG.find(
        (item) => item.itemId === 'composite-evidence'
    );
    if (!catalogItem) {
        throw new Error('Composite Evidence catalog item is missing.');
    }
    const manifest: RallarBlackBoxDistributedRunManifest = {
        schemaVersion: 1,
        distributedRunId: 'dist-restored-composite',
        controlRunId: control.runs[0].runId,
        displayName: 'Restored Composite Evidence',
        group: EXECUTE_CONTROL_GROUP,
        recipes: [
            {
                recipeId: catalogItem.recipe.recipeId,
                recipe: catalogItem.recipe,
                variables: {}
            }
        ],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['execute-agent-a', 'execute-agent-b'],
            expectedParticipantCount: 2
        },
        ackTimeoutMs: 15_000,
        startMode: 'manual',
        variables: {},
        roleAssignments: [],
        barrier: { enabled: false },
        groupAssertions: [],
        metadata: {}
    };
    const restored = createExecuteRunSnapshot({ manifest: manifest, state: 'ready', updatedAtEpochMs: Date.now() });
    await installExecuteControlFixture(context, {
        snapshot: {
            ...control,
            distributedRuns: [restored]
        }
    });
    await page.goto(
        `${EXECUTE_ROUTE}&controlRunId=${control.runs[0].runId}` +
            `&distributedRunId=${restored.distributedRunId}`
    );

    await expect(page).toHaveURL(
        /(?:\?|&)recipeId=composite-evidence-recipe(?:&|$)/
    );
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]'
        )
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'ready'
    );
    await expect(
        page.locator('[data-execute-targets]').getByRole('checkbox')
    ).toHaveCount(2);
    await expect(
        page.getByRole('button', { name: 'Review and start' })
    ).toBeVisible();
});

test('refuses Stage when fresh target resolution drifts', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, {
        operatorSession: true,
        resolutionTargetIds(call) {
            return call === 3 ? ['execute-agent-a'] : ['execute-agent-a', 'execute-agent-b'];
        }
    });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    const readsBeforeFailure = mock.runRequestCount();

    await actions
        .getByRole('button', { name: /Stage \d+ agents/ })
        .click();

    const error = page.locator('[data-execute-run-status] [data-error-kind]');
    await expect(error).toContainText(
        'Server-resolved target IDs no longer exactly match the selected safe IDs.'
    );
    expect(
        mock.successfulWrites.some((request) => request.path.endsWith('/stage'))
    ).toBe(false);
    expect(mock.runRequestCount()).toBeGreaterThan(readsBeforeFailure);
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await expect(actions.getByRole('button', { name: /Stage \d+ agents/ }))
        .toBeEnabled();
});

test('keeps structured control provenance after a failed mutation refresh', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, {
        operatorSession: true,
        failure: {
            path: '/distributed-runs/resolve-targets',
            status: 409,
            message: 'Resolution conflict from control truth.'
        }
    });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    const actions = page.locator('[data-execute-action-runway]');
    const readsBeforeFailure = mock.runRequestCount();
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();

    const error = page.locator(
        '[data-execute-run-status] [data-error-kind="http"]'
    );
    await expect(error).toContainText(
        'Resolution conflict from control truth.'
    );
    await expect(error).toContainText('HTTP 409');
    expect(mock.runRequestCount()).toBeGreaterThan(readsBeforeFailure);
    await expect(
        actions.getByRole('button', { name: /Resolve \d+ targets/ })
    ).toBeEnabled();
});

test('renders credential-trust truth when a URL-selected control rejects Resolve', async ({ context, page }) => {
    const brokerRequests: string[] = [];
    await context.addInitScript(() => {
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'ambient-client',
                sessionId: 'ambient-session',
                username: 'ambient-operator',
                accessToken: 'ambient-session-secret',
                expiresAtEpochMs: 4_000_000_000_000
            })
        );
    });
    await context.route(EXECUTE_API_ROUTE, async (route) => {
        brokerRequests.push(route.request().url());
        await fulfillExecuteJsonResponse(route, { error: 'Broker must not be called.' }, 500);
    });
    const control = await installExecuteControlFixture(context, {
        controlRoute: 'https://untrusted-control.test/**',
        snapshot: createExecuteLiveSnapshot()
    });

    await page.goto(
        `${EXECUTE_ROUTE}&controlRunId=execute-control-a` +
            '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol'
    );
    await page
        .locator('[data-execute-action-runway]')
        .getByRole('button', { name: /Resolve \d+ targets/ })
        .click();

    const error = page.locator(
        '[data-execute-run-status] [data-error-kind="credential-trust"]'
    );
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText('Credential trust');
    await expect(error).toContainText(
        'Automatic stored credentials are blocked for a URL-configured control endpoint.'
    );
    expect(control.controlAuthorizations.length).toBeGreaterThanOrEqual(2);
    expect(control.controlAuthorizations.every((authorization) => authorization === null))
        .toBe(true);
    expect(brokerRequests).toEqual([]);
});

test('clears a completed operation error when Execute context changes', async ({ context, page }) => {
    await installExecuteControlFixture(context, {
        operatorSession: true,
        failure: {
            path: '/distributed-runs/resolve-targets',
            status: 409,
            message: 'Recipe A resolution conflict.'
        }
    });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    const error = page.locator(
        '[data-execute-run-status] [data-error-kind="http"]'
    );
    await page
        .locator('[data-execute-action-runway]')
        .getByRole('button', { name: /Resolve \d+ targets/ })
        .click();
    await expect(error).toContainText('Recipe A resolution conflict.');

    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]'
        )
        .click();
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]'
        )
    ).toHaveAttribute('aria-selected', 'true');
    await expect(error).toHaveCount(0);
});

test('rejects a mutation response for a different run identity', async ({ context, page }) => {
    await installExecuteControlFixture(context, {
        operatorSession: true,
        createResponseDistributedRunId: 'dist-wrong-response'
    });
    await openCompositeExecuteSelection(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();

    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]')
    ).toContainText(
        'Control response identity does not match the requested distributed run.'
    );
    await expect(actions.getByRole('button', {
        name: 'Create draft',
        exact: true
    })).toBeFocused();
    await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
});

test('aborts an in-flight action when Execute configuration changes', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, {
        operatorSession: true,
        deferResolution: true
    });
    await openCompositeExecuteSelection(page);
    const actions = page.locator('[data-execute-action-runway]');
    const targets = page.locator('[data-execute-targets]');
    const runTrigger = targets.locator('[data-searchable-listbox-trigger]');
    await runTrigger.click();
    await expect(targets.getByRole('combobox', { name: 'Search Control run' }))
        .toBeFocused();
    await actions.getByRole('button', { name: /Resolve \d+ targets/ })
        .evaluate((button: HTMLButtonElement) => button.click());
    await mock.waitForDeferredResolution();
    await expect(runTrigger).toBeDisabled();
    await expect(targets.locator('[data-searchable-listbox-popup]')).toHaveCount(0);
    const disabledFocus = targets.locator(
        '[data-searchable-listbox-disabled-focus]'
    );
    await expect(disabledFocus).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body))
        .toBe(true);
    const readsBeforeChange = mock.runRequestCount();

    await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('recipeId', 'expected-failure-recipe');
        url.searchParams.delete('distributedRunId');
        history.pushState(null, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]'
        )
    ).toHaveAttribute('aria-selected', 'true');
    mock.releaseDeferredResolution();

    await expect(actions).toHaveAttribute('aria-busy', 'false');
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]')
    ).toHaveCount(0);
    expect(mock.runRequestCount()).toBe(readsBeforeChange);
});

test('rejects an abort-ignoring stale Create response after context changes', async ({ context, page }) => {
    await installAbortIgnoringFetchGate(context, '/distributed-runs');
    await installExecuteControlFixture(context, { operatorSession: true });
    await openCompositeExecuteSelection(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await waitForAbortIgnoringFetch(page);

    await changeExecuteRecipeFromHistory(page);
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]'
        )
    ).toHaveAttribute('aria-selected', 'true');
    await releaseAbortIgnoringFetch(page);

    await expect(actions).toHaveAttribute('aria-busy', 'false');
    await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'uncreated'
    );
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]')
    ).toHaveCount(0);
});

test('rejects an abort-ignoring stale Export response after context changes', async ({ context, page }) => {
    await installAbortIgnoringFetchGate(
        context,
        '/distributed-runs/deferred/artifacts'
    );
    await installExecuteControlFixture(context, { operatorSession: true });
    await createDraftThroughVisibleControls(page);
    const runId = new URL(page.url()).searchParams.get('distributedRunId');
    if (!runId) {
        throw new Error('Created run URL omitted distributedRunId.');
    }
    const gatePath = `/distributed-runs/${encodeURIComponent(runId)}/artifacts`;
    await page.evaluate((pathname) => {
        const gate = (window as ExecuteFetchWindow).__executeFetchGate;
        if (gate) {
            gate.pathname = pathname;
        }
    }, gatePath);
    let downloads = 0;
    page.on('download', () => {
        downloads += 1;
    });
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: 'Export artifact' }).click();
    await waitForAbortIgnoringFetch(page);

    await changeExecuteRecipeFromHistory(page);
    await releaseAbortIgnoringFetch(page);

    await expect(actions).toHaveAttribute('aria-busy', 'false');
    expect(downloads).toBe(0);
    await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]')
    ).toHaveCount(0);
});

test('cancels a known non-terminal run through an accessible confirmation', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, { operatorSession: true });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');

    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?'
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('execute-control-a');
    await expect(dialog.getByRole('button', { name: 'Keep run' })).toBeFocused();
    await dialog
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'cancelled'
    );
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true })
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Refresh', exact: true })
    ).toBeFocused();
    expect(
        mock.successfulWrites.some((request) => request.path.endsWith('/cancel'))
    ).toBe(true);
});

test('keeps failed Cancel focus trapped and disables dialog motion when requested', async ({ context, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installExecuteControlFixture(context, {
        operatorSession: true,
        failure: {
            path: '/cancel',
            status: 409,
            message: 'Cancellation conflict from control truth.'
        }
    });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?'
    });
    await expect(dialog).toBeVisible();
    const motion = await page.locator('[data-execute-cancel-dialog]').evaluate(
        (backdrop) => {
            const dialogElement = backdrop.querySelector<HTMLElement>(
                '[role="alertdialog"]'
            );
            return {
                backdropAnimation: getComputedStyle(backdrop).animationName,
                dialogAnimation: dialogElement
                    ? getComputedStyle(dialogElement).animationName
                    : 'missing'
            };
        }
    );
    expect(motion).toEqual({
        backdropAnimation: 'none',
        dialogAnimation: 'none'
    });

    await dialog
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    await expect(dialog).toBeVisible();
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind="http"]')
    ).toContainText('Cancellation conflict from control truth.');
    await expect(dialog).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(
        dialog.getByRole('button', { name: 'Cancel run', exact: true })
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Keep run' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true })
    ).toBeFocused();
});

test('does not reopen Cancel when URL context leaves and restores a run', async ({ context, page }) => {
    await installExecuteControlFixture(context, { operatorSession: true });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?'
    });
    await expect(dialog).toBeVisible();

    await changeExecuteRecipeFromHistory(page);
    await expect(dialog).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
    await expect(dialog).toHaveCount(0);
});

test('renders waiting-for-barrier truth with bounded Start Cancel and Export policy', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, { operatorSession: true });
    await createDraftThroughVisibleControls(page);
    mock.setRunState('waiting-for-barrier');
    await page.getByRole('button', { name: 'Refresh control data' }).click();

    const status = page.locator('[data-execute-run-status]');
    const actions = page.locator('[data-execute-action-runway]');
    await expect(status.locator('[data-execute-run-live-summary]'))
        .toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveAttribute('data-run-state', 'waiting-for-barrier');
    await expect(status).toContainText('Waiting For Barrier');
    await expect(
        actions.getByRole('button', { name: 'Review and start' })
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true })
    ).toBeEnabled();
    await expect(
        actions.getByRole('button', { name: 'Export artifact' })
    ).toBeEnabled();
});

test('closes Cancel on terminal failed truth and announces the authoritative error', async ({ context, page }) => {
    const mock = await installExecuteControlFixture(context, { operatorSession: true });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?'
    });
    await expect(dialog).toBeVisible();

    mock.setRunState('failed', {
        code: 'RALLAR_BB_TERMINAL_FAILURE',
        message: 'Authoritative terminal failure from control truth.'
    });
    await page.getByRole('button', { name: 'Refresh control data' }).evaluate(
        (button) => (button as HTMLButtonElement).click()
    );

    const status = page.locator('[data-execute-run-status]');
    await expect(status.locator('[data-execute-run-live-summary]'))
        .toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveAttribute('data-run-state', 'failed');
    await expect(status.getByRole('alert')).toContainText(
        'Authoritative terminal failure from control truth.'
    );
    await expect(dialog).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Review and start' })
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true })
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Export artifact' })
    ).toBeEnabled();
    expect(
        mock.successfulWrites.some((request) => request.path.endsWith('/cancel'))
    ).toBe(false);
});

test('selects an explicit control run inside the single target plane', async ({ context, page }) => {
    const first = createExecuteLiveSnapshot().runs[0];
    const secondRunId = 'execute-control-b';
    const second: ControlRunSnapshot = {
        ...first,
        runId: secondRunId,
        agents: [createExecuteAgent(secondRunId, 'execute-agent-c')]
    };
    await installExecuteControlFixture(context, {
        snapshot: {
            runs: [first, second],
            distributedRuns: []
        }
    });
    await page.goto(EXECUTE_ROUTE);

    const targets = page.locator('[data-execute-targets]');
    const runPicker = targets.locator('[data-searchable-listbox-trigger]');
    await expect(runPicker).toBeVisible();
    await expect(targets.locator('[data-execute-target]')).toHaveCount(0);

    await runPicker.click();
    await expect(targets.getByRole('option')).toHaveCount(2);
    await targets.locator(`[data-option-key="${secondRunId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`controlRunId=${secondRunId}`));
    await expect(targets.locator('[data-execute-target]')).toHaveCount(1);
    await expect(
        targets.getByText('execute-agent-c', { exact: true })
    ).toBeVisible();
});

test('restores safe targets when an explicit control run becomes live', async ({ context, page }) => {
    await installExecuteControlFixture(context);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);

    const targets = page.locator('[data-execute-targets]');
    await expect(
        targets.locator('[data-searchable-listbox-trigger]')
    ).toContainText('execute-control-a');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(2);
    await expect(targets.getByRole('checkbox')).toHaveCount(2);
    await expect(targets.getByRole('checkbox').first()).toBeChecked();
    await expect(targets.getByRole('checkbox').last()).toBeChecked();
});

test('keeps late Execute pressure evidence operable without changing lifecycle authority', async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
        hasTouch: true,
        viewport: { width: 430, height: 932 }
    });
    try {
        const snapshot = createExecutePressureSnapshot();
        const mock = await installExecuteControlFixture(context, {
            operatorSession: true,
            refreshAgentEvidence: true,
            snapshot
        });
        const page = await context.newPage();
        const selectedRunId = snapshot.runs[249]!.runId;
        const keyboardRunId = snapshot.runs[248]!.runId;
        await page.goto(`${EXECUTE_ROUTE}&controlRunId=${selectedRunId}`);

        const targets = page.locator('[data-execute-targets]');
        const actions = page.locator('[data-execute-action-runway]');
        const runTrigger = targets.locator('[data-searchable-listbox-trigger]');
        await expect(page).toHaveURL(/recipeId=rtc-realtime-stability/);
        const stableUrl = page.url();
        await expect(targets.locator('[data-execute-target]')).toHaveCount(100);
        await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ }))
            .toBeEnabled();
        await expect(actions.getByRole('button', { name: 'Create draft' }))
            .toHaveCount(0);

        const inspector = page.getByRole('dialog', { name: 'Inspector' });
        await inspector.getByRole('button', { name: 'Close inspector' }).click();
        await expect(inspector).toHaveCount(0);
        await runTrigger.focus();
        await expect(runTrigger).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(targets.getByRole('option')).toHaveCount(50);
        const runWindow = targets.getByRole('group', {
            name: 'Control run options window'
        });
        await runWindow.getByRole('button', { name: 'Previous' }).focus();
        await page.keyboard.press('Enter');
        await expect(targets.getByRole('option')).toHaveCount(100);
        await runWindow.getByRole('button', { name: 'Next' }).focus();
        await page.keyboard.press('Enter');
        await expect(targets.getByRole('option')).toHaveCount(50);
        await expect(targets.locator('[data-searchable-listbox-focus-anchor]'))
            .toBeFocused();
        await page.getByRole('button', { name: 'Refresh control data' })
            .evaluate((button: HTMLButtonElement) => button.click());
        await expect(targets.locator('[data-searchable-listbox-range]'))
            .toHaveText('Showing 201–250 of 250 options.');
        expect(page.url()).toBe(stableUrl);
        expect(mock.successfulWrites).toHaveLength(0);

        const runSearch = targets.getByRole('combobox', {
            name: 'Search Control run'
        });
        const runPopup = targets.locator('[data-searchable-listbox-popup]');
        const rangeStatus = runPopup.locator('[data-searchable-listbox-range]');
        await expect(runPopup.locator('[role="status"]')).toHaveCount(1);
        await expect(rangeStatus).toHaveAttribute('aria-live', 'polite');
        await expect(rangeStatus).toHaveAttribute('aria-atomic', 'true');
        await rangeStatus.evaluate((element) => {
            element.setAttribute('data-stable-live-region', 'true');
        });
        await runSearch.fill(keyboardRunId);
        await expect(runPopup.locator('[role="status"]')).toHaveCount(1);
        await expect(rangeStatus).toHaveAttribute('data-stable-live-region', 'true');
        await expect(rangeStatus).toHaveText('Showing 1–1 of 1 options.');
        await runSearch.fill('missing-control-run');
        await expect(runPopup.locator('[role="status"]')).toHaveCount(1);
        await expect(rangeStatus).toHaveAttribute('data-stable-live-region', 'true');
        await expect(rangeStatus).toHaveText('No options match this search.');
        await expect(runPopup.locator('[data-searchable-listbox-empty]'))
            .toHaveAttribute('aria-hidden', 'true');
        await runSearch.fill(keyboardRunId);
        await expect(targets.getByRole('option')).toHaveCount(1);
        await runSearch.press('Enter');
        await expect(page).toHaveURL(new RegExp(`controlRunId=${keyboardRunId}`));

        await runTrigger.tap();
        await targets.getByRole('combobox', { name: 'Search Control run' })
            .fill(selectedRunId);
        const selectedOption = targets.locator(
            `[data-option-key="${selectedRunId}"]`
        );
        await expect(selectedOption).toHaveCount(1);
        await selectedOption.tap();
        await expect(page).toHaveURL(new RegExp(`controlRunId=${selectedRunId}`));
        await expect(targets.locator('[data-execute-target]')).toHaveCount(100);
        expect(mock.successfulWrites).toHaveLength(0);

        const targetWindowUrl = page.url();
        const targetWindow = targets.getByRole('group', { name: 'Targets window' });
        const targetAnchor = targets.locator(
            '[data-execute-window-focus-anchor="targets"]'
        );
        await targetWindow.getByRole('button', { name: 'Next' }).tap();
        await expect(targetAnchor).toHaveText('Showing 101–200 of 240 targets.');
        await targetWindow.getByRole('button', { name: 'Next' }).click();
        await expect(targetAnchor).toHaveText('Showing 201–240 of 240 targets.');
        await expect(targetAnchor).toBeFocused();

        await targetWindow.getByRole('button', { name: 'Previous' }).focus();
        await page.keyboard.press('Space');
        await expect(targetAnchor).toHaveText('Showing 101–200 of 240 targets.');
        await expect(targetWindow.getByRole('button', { name: 'Previous' }))
            .toBeFocused();
        await page.keyboard.press('Space');
        await expect(targetAnchor).toHaveText('Showing 1–100 of 240 targets.');
        await expect(targetAnchor).toBeFocused();

        await targetWindow.getByRole('button', { name: 'Next' }).focus();
        await targetWindow.getByRole('button', { name: 'Next' }).click();
        await expect(targetAnchor).toHaveText('Showing 101–200 of 240 targets.');
        await expect(targetWindow.getByRole('button', { name: 'Next' }))
            .toBeFocused();
        await page.keyboard.press('Enter');
        await expect(targets.locator('[data-execute-target]')).toHaveCount(40);
        await expect(targetAnchor).toBeFocused();
        const lateAgentId = 'pressure-agent-0239';
        const lateTarget = targets.getByRole('checkbox', {
            name: `Select ${lateAgentId}`
        });
        await expect(lateTarget).toBeChecked();
        await lateTarget.focus();
        await lateTarget.tap();
        await expect(targets.getByText('239 selected', { exact: true })).toBeVisible();
        await lateTarget.tap();
        await expect(targets.getByText('240 selected', { exact: true })).toBeVisible();
        expect(page.url()).toBe(targetWindowUrl);
        expect(mock.successfulWrites).toHaveLength(0);
        await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ }))
            .toBeEnabled();
        await expect(actions.getByRole('button', { name: 'Create draft' }))
            .toHaveCount(0);
    }
    finally {
        await context.close();
    }
});

test('preserves the complete 240-target manifest through pressure lifecycle mutations', async ({ context, page }) => {
    test.setTimeout(60_000);
    const snapshot = createExecutePressureSnapshot();
    const mock = await installExecuteControlFixture(context, {
        operatorSession: true,
        refreshAgentEvidence: true,
        snapshot
    });
    const selectedRunId = snapshot.runs[249]!.runId;
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=${selectedRunId}`);
    const targets = page.locator('[data-execute-targets]');
    const actions = page.locator('[data-execute-action-runway]');
    await expect(targets.getByText('240 selected', { exact: true })).toBeVisible();

    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await expect(actions.getByRole('button', { name: 'Create draft' }))
        .toBeVisible();
    expect(mock.successfulWrites).toHaveLength(1);
    await actions.getByRole('button', { name: 'Create draft', exact: true }).click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
    const create = mock.successfulWrites.find((request) => request.path === '/distributed-runs');
    expect(create?.manifest?.targetPolicy).toEqual({
        mode: 'selected-agents',
        agentIds: Array.from({ length: 240 }, (_unused, index) => `pressure-agent-${String(index).padStart(4, '0')}`),
        expectedParticipantCount: 240
    });
    await actions.getByRole('button', { name: /Stage \d+ agents/ }).click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'waiting-for-ack'
    );
    expect(mock.successfulWrites.map((request) => request.path)).toEqual([
        '/distributed-runs/resolve-targets',
        '/distributed-runs/resolve-targets',
        '/distributed-runs',
        '/distributed-runs/resolve-targets',
        expect.stringMatching(/\/stage$/)
    ]);
});

test('renders one live recipe-aware target plane without seeded fallback', async ({ context, page }) => {
    await installExecuteControlFixture(context);
    await page.goto(EXECUTE_ROUTE);

    await expect(page.locator('[data-execute-workspace]')).toBeVisible();
    await expect(page.locator('[data-execute-catalog]')).toBeVisible();
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="rtc-realtime-stability"]'
        )
    ).toHaveAttribute('aria-selected', 'true');
    const targets = page.locator('[data-execute-targets]');
    await expect(targets).toBeVisible();
    await expect(targets.locator('[data-execute-target]')).toHaveCount(2);
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        2
    );
    await expect(targets.getByRole('checkbox')).toHaveCount(2);
    await expect(
        page.getByRole('region', { name: 'Control overview' })
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('seed-agent');
    await expect(page.locator('[data-execute-preflight]')).toBeVisible();
    await expect(
        page
            .locator('[data-execute-action-runway]')
            .getByRole('button', { name: /Resolve \d+ targets/ })
    ).toBeEnabled();
});

test('keeps catalog and preflight available while offline actions remain blocked', async ({ context, page }) => {
    await context.route(EXECUTE_CONTROL_ROUTE, (route) => route.abort('connectionfailed'));
    await page.goto(EXECUTE_ROUTE);

    await expect(page.locator('[data-execute-catalog]')).toBeVisible();
    await expect(page.locator('[data-execute-preflight]')).toBeVisible();
    await expect(page.locator('[data-execute-target]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('seed-agent');
    const actions = page.locator('[data-execute-action-runway]');
    await expect(
        actions.getByRole('button', { name: 'Refresh control data' })
    ).toBeEnabled();
    await expect(
        actions.getByRole('button', { name: 'Refresh control data' })
    ).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(
        actions.getByRole('button', { name: 'Refresh', exact: true })
    ).toHaveCount(0);
    await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ }))
        .toHaveCount(0);
    await expect(actions.getByRole('button', { name: 'Create draft' }))
        .toHaveCount(0);
    await expect(actions).toContainText(/offline|control truth|Refresh/i);
});
