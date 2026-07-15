import {
    expect,
    type BrowserContext,
    type Page,
    type Route,
    test,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxDistributedTargetResolution,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { DISTRIBUTED_RECIPE_CATALOG } from '../../../packages/shared-test/rallar-bb-test/distributed-recipe-catalog.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const API_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):8080\/.*/;
const GROUP = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'execute-live-group',
} as const;
const EXECUTE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&applicationId=rallar-server&workspaceId=default&roomId=execute-live-group';

function agent(
    runId: string,
    agentId: string,
    options: Readonly<{ connected?: boolean; groupId?: string }> = {},
): ControlAgentSnapshot {
    const now = Date.now();
    return {
        runId,
        agentId,
        connected: options.connected ?? true,
        registeredAtEpochMs: now - 2_000,
        lastSeenAtEpochMs: now - 500,
        lastHeartbeatAtEpochMs: now - 500,
        status: options.connected === false ? 'offline' : 'connected',
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            ...GROUP,
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

function liveSnapshot(): ControlServerSnapshot {
    const runId = 'execute-control-a';
    const now = Date.now();
    const run: ControlRunSnapshot = {
        runId,
        createdAtEpochMs: now - 10_000,
        updatedAtEpochMs: now - 500,
        agents: [
            agent(runId, 'execute-agent-a'),
            agent(runId, 'execute-agent-b'),
        ],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
    return { runs: [run], distributedRuns: [] };
}

function pressureSnapshot(): ControlServerSnapshot {
    const now = Date.now();
    const runs = Array.from({ length: 250 }, (_, index): ControlRunSnapshot => {
        const runId = `execute-pressure-${String(index).padStart(4, '0')}`;
        const agentCount = index === 249 ? 240 : 1;
        return {
            runId,
            createdAtEpochMs: now - (250 - index) * 1_000,
            updatedAtEpochMs: now - 500,
            agents: Array.from({ length: agentCount }, (_unused, agentIndex) =>
                agent(runId, `pressure-agent-${String(agentIndex).padStart(4, '0')}`)
            ),
            commands: [], results: [], events: [], stats: [], reports: [], heartbeats: [],
        };
    });
    return { runs, distributedRuns: [] };
}

async function fulfillJson(
    route: Route,
    body: unknown,
    status = 200,
): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
    });
}

function distributedRun(
    manifest: RallarBlackBoxDistributedRunManifest,
    state: RallarBlackBoxDistributedRunState,
    updatedAtEpochMs: number,
    options: Readonly<{
        error?: ControlDistributedRunSnapshot['error'];
    }> = {},
): ControlDistributedRunSnapshot {
    const targetAgentIds = [...(manifest.targetPolicy.agentIds ?? [])];
    const ready = ['ready', 'running', 'passed'].includes(state)
        ? targetAgentIds.length
        : 0;
    return {
        distributedRunId: manifest.distributedRunId,
        controlRunId: manifest.controlRunId ?? '',
        manifest,
        state,
        createdAtEpochMs: updatedAtEpochMs - 1_000,
        updatedAtEpochMs,
        targetAgentIds,
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: targetAgentIds.length,
                requiredParticipants: targetAgentIds.length,
                readyParticipants: ready,
                passedParticipants:
                    state === 'passed' ? targetAgentIds.length : 0,
                failedParticipants: state === 'failed' ? targetAgentIds.length : 0,
                recipes: manifest.recipes.length,
                requiredRecipes: manifest.recipes.length,
                passedRecipes: state === 'passed' ? manifest.recipes.length : 0,
                failedRecipes: state === 'failed' ? manifest.recipes.length : 0,
                blockingFailures: state === 'failed' ? 1 : 0,
            },
            failures: [],
        },
        error: options.error,
    };
}

function targetResolution(
    manifest: RallarBlackBoxDistributedRunManifest,
    targetAgentIds = manifest.targetPolicy.agentIds ?? [],
): RallarBlackBoxDistributedTargetResolution {
    return {
        group: manifest.group,
        resolvedAtEpochMs: Date.now(),
        staleAfterMs: 30_000,
        targetPolicyMode: manifest.targetPolicy.mode,
        targetAgentIds,
        roleAssignments: targetAgentIds.map((agentId) => ({
            agentId,
            role: 'all-agents',
            recipeIds: manifest.recipes
                .map(
                    (recipe) =>
                        recipe.recipeId ?? recipe.recipe?.recipeId ?? '',
                )
                .filter(Boolean),
            required: true,
        })),
        blockers: [],
        summary: {
            agents: targetAgentIds.length,
            targetable: targetAgentIds.length,
            selected: targetAgentIds.length,
            expectedParticipantCount:
                manifest.targetPolicy.expectedParticipantCount,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: { 'all-agents': targetAgentIds.length },
            regions: { 'eu-north': targetAgentIds.length },
            providers: { 'browser-rallar': targetAgentIds.length },
        },
    };
}

type LifecycleControl = Readonly<{
    successfulWrites: Array<
        Readonly<{
            path: string;
            authorization?: string;
            manifest?: RallarBlackBoxDistributedRunManifest;
        }>
    >;
    brokerAuthorizations: string[];
    tokenRequests: Array<Readonly<{ runId: string; agentId: string }>>;
    runRequestCount(): number;
    waitForDeferredResolution(): Promise<void>;
    releaseDeferredResolution(): void;
    deferNextRunRead(): void;
    waitForDeferredRunRead(): Promise<void>;
    releaseDeferredRunRead(): void;
    setRunState(
        state: RallarBlackBoxDistributedRunState,
        error?: ControlDistributedRunSnapshot['error'],
    ): void;
}>;

type LifecycleOptions = Readonly<{
    snapshot?: ControlServerSnapshot;
    enableAgentLaunch?: boolean;
    refreshAgentEvidence?: boolean;
    resolutionTargetIds?(
        call: number,
        manifest: RallarBlackBoxDistributedRunManifest,
    ): readonly string[];
    failure?: Readonly<{
        path: string;
        status: number;
        message: string;
    }>;
    createResponseDistributedRunId?: string;
    deferResolution?: boolean;
}>;

async function installLifecycleControl(
    context: BrowserContext,
    options: LifecycleOptions = {},
): Promise<LifecycleControl> {
    let base = options.snapshot ?? liveSnapshot();
    const successfulWrites: LifecycleControl['successfulWrites'] = [];
    const brokerAuthorizations: string[] = [];
    const tokenRequests: LifecycleControl['tokenRequests'] = [];
    let run: ControlDistributedRunSnapshot | undefined;
    let version = Date.now();
    let waitingReads = 0;
    let runningReads = 0;
    let runReads = 0;
    let resolutionCalls = 0;
    const createdRunIds = new Set<string>();
    let shouldDeferNextRunRead = false;
    let releaseRunRead = (): void => {};
    let markRunReadStarted = (): void => {};
    const runReadStarted = new Promise<void>((resolve) => {
        markRunReadStarted = resolve;
    });
    const runReadGate = new Promise<void>((resolve) => {
        releaseRunRead = resolve;
    });
    let releaseResolution = (): void => {};
    let markResolutionStarted = (): void => {};
    const resolutionStarted = new Promise<void>((resolve) => {
        markResolutionStarted = resolve;
    });
    const resolutionGate = new Promise<void>((resolve) => {
        releaseResolution = resolve;
    });

    await context.addInitScript(() => {
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'execute-client',
                sessionId: 'execute-session',
                username: 'execute-operator',
                accessToken: 'execute-primary-session-token',
                expiresAtEpochMs: 4_000_000_000_000,
            }),
        );
    });
    await context.route(API_ROUTE, async (route) => {
        if (route.request().method() === 'OPTIONS') {
            await fulfillCorsPreflight(route);
            return;
        }
        brokerAuthorizations.push(
            route.request().headers().authorization ?? 'missing',
        );
        await fulfillJson(route, {
            tokenType: 'Bearer',
            token: 'execute-brokered-operator-token',
            issuedAtEpochMs: Date.now(),
            expiresAtEpochMs: Date.now() + 3_600_000,
            ttlMs: 3_600_000,
        });
    });
    await context.route(CONTROL_ROUTE, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await fulfillCorsPreflight(route);
            return;
        }
        const tokenMatch = url.pathname.match(
            /^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/,
        );
        if (options.enableAgentLaunch && request.method() === 'POST' && tokenMatch) {
            const runId = decodeURIComponent(tokenMatch[1]);
            const agentId = decodeURIComponent(tokenMatch[2]);
            tokenRequests.push({ runId, agentId });
            const now = Date.now();
            const current = base.runs.find(candidate => candidate.runId === runId);
            const launchedAgent = agent(runId, agentId);
            const launchedRun: ControlRunSnapshot = current
                ? {
                      ...current,
                      agents: [
                          ...current.agents.filter(candidate => candidate.agentId !== agentId),
                          launchedAgent,
                      ],
                      updatedAtEpochMs: now,
                  }
                : {
                      runId,
                      createdAtEpochMs: now,
                      updatedAtEpochMs: now,
                      agents: [launchedAgent],
                      commands: [], results: [], events: [], stats: [], reports: [], heartbeats: [],
                  };
            base = {
                ...base,
                runs: [
                    ...base.runs.filter(candidate => candidate.runId !== runId),
                    launchedRun,
                ],
            };
            await fulfillJson(route, {
                runId,
                agentId,
                token: `control-agent-${agentId}`,
                issuedAtEpochMs: now,
                expiresAtEpochMs: now + 60_000,
            }, 201);
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            runReads += 1;
            const snapshotRun = run;
            const responseBase = options.refreshAgentEvidence
                ? refreshControlAgentEvidence(base)
                : base;
            if (shouldDeferNextRunRead) {
                shouldDeferNextRunRead = false;
                markRunReadStarted();
                await runReadGate;
                await fulfillJson(route, {
                    ...responseBase,
                    distributedRuns: snapshotRun ? [snapshotRun] : [],
                });
                return;
            }
            if (run?.state === 'waiting-for-ack' && waitingReads++ > 0) {
                run = distributedRun(run.manifest, 'ready', ++version);
            } else if (run?.state === 'running' && runningReads++ > 0) {
                run = distributedRun(run.manifest, 'passed', ++version);
            }
            await fulfillJson(route, {
                ...responseBase,
                distributedRuns: run ? [run] : [],
            });
            return;
        }

        const protectedRequest =
            request.method() === 'POST' || url.pathname.endsWith('/artifacts');
        const authorization = request.headers().authorization;
        if (
            protectedRequest &&
            authorization !== 'Bearer execute-brokered-operator-token'
        ) {
            await fulfillJson(
                route,
                { error: 'Operator token required.' },
                401,
            );
            return;
        }
        const body = request.postDataJSON() as
            | { manifest?: RallarBlackBoxDistributedRunManifest }
            | undefined;
        if (
            options.failure &&
            request.method() === 'POST' &&
            (url.pathname === options.failure.path ||
                url.pathname.endsWith(options.failure.path))
        ) {
            await fulfillJson(
                route,
                { error: options.failure.message },
                options.failure.status,
            );
            return;
        }
        if (
            request.method() === 'POST' &&
            url.pathname === '/distributed-runs/resolve-targets' &&
            body?.manifest
        ) {
            resolutionCalls += 1;
            if (options.deferResolution && resolutionCalls === 1) {
                markResolutionStarted();
                await resolutionGate;
            }
            successfulWrites.push({
                path: url.pathname,
                authorization,
                manifest: body.manifest,
            });
            try {
                await fulfillJson(
                    route,
                    targetResolution(
                        body.manifest,
                        options.resolutionTargetIds?.(
                            resolutionCalls,
                            body.manifest,
                        ) ??
                            body.manifest.targetPolicy.agentIds ??
                            [],
                    ),
                );
            } catch {
                // A configuration change may abort the request before the mock releases it.
            }
            return;
        }
        if (
            request.method() === 'POST' &&
            url.pathname === '/distributed-runs' &&
            body?.manifest
        ) {
            if (createdRunIds.has(body.manifest.distributedRunId)) {
                await fulfillJson(route, {
                    error: `Distributed run ${body.manifest.distributedRunId} already exists.`,
                }, 409);
                return;
            }
            createdRunIds.add(body.manifest.distributedRunId);
            run = distributedRun(body.manifest, 'draft', ++version);
            successfulWrites.push({
                path: url.pathname,
                authorization,
                manifest: body.manifest,
            });
            await fulfillJson(
                route,
                options.createResponseDistributedRunId
                    ? {
                          ...run,
                          distributedRunId:
                              options.createResponseDistributedRunId,
                      }
                    : run,
            );
            return;
        }
        if (
            request.method() === 'POST' &&
            run &&
            url.pathname.endsWith('/stage')
        ) {
            run = distributedRun(run.manifest, 'waiting-for-ack', ++version);
            waitingReads = 0;
            successfulWrites.push({ path: url.pathname, authorization });
            await fulfillJson(route, run);
            return;
        }
        if (
            request.method() === 'POST' &&
            run &&
            url.pathname.endsWith('/start')
        ) {
            run = distributedRun(run.manifest, 'running', ++version);
            runningReads = 0;
            successfulWrites.push({ path: url.pathname, authorization });
            await fulfillJson(route, run);
            return;
        }
        if (
            request.method() === 'POST' &&
            run &&
            url.pathname.endsWith('/cancel')
        ) {
            run = distributedRun(run.manifest, 'cancelled', ++version);
            successfulWrites.push({ path: url.pathname, authorization });
            await fulfillJson(route, run);
            return;
        }
        if (
            request.method() === 'GET' &&
            run &&
            url.pathname.endsWith('/artifacts')
        ) {
            successfulWrites.push({ path: url.pathname, authorization });
            await fulfillJson(route, {
                artifactSchemaVersion: 2,
                distributedRunId: run.distributedRunId,
                generatedAtEpochMs: 2_000_000_000_000,
                files: {
                    'distributed-run.json': JSON.stringify(run),
                    'manifest.json': JSON.stringify(run.manifest),
                    'control-run.json': JSON.stringify(base.runs[0]),
                },
            });
            return;
        }
        await fulfillJson(
            route,
            {
                error: `Unhandled ${request.method()} ${url.pathname}`,
            },
            404,
        );
    });
    return {
        successfulWrites,
        brokerAuthorizations,
        tokenRequests,
        runRequestCount: () => runReads,
        waitForDeferredResolution: () => resolutionStarted,
        releaseDeferredResolution: () => releaseResolution(),
        deferNextRunRead: () => {
            shouldDeferNextRunRead = true;
        },
        waitForDeferredRunRead: () => runReadStarted,
        releaseDeferredRunRead: () => releaseRunRead(),
        setRunState: (state, error) => {
            if (!run) throw new Error('A distributed run must exist before its state can change.');
            run = distributedRun(run.manifest, state, ++version, { error });
        },
    };
}

function refreshControlAgentEvidence(
    snapshot: ControlServerSnapshot,
): ControlServerSnapshot {
    const now = Date.now();
    return {
        ...snapshot,
        runs: snapshot.runs.map(run => ({
            ...run,
            updatedAtEpochMs: now,
            agents: run.agents.map(agentSnapshot => ({
                ...agentSnapshot,
                lastSeenAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
            })),
        })),
    };
}

async function installAbortIgnoringFetchGate(
    context: BrowserContext,
    pathname: string,
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
            release,
        };
        Object.defineProperty(window, '__executeFetchGate', {
            configurable: true,
            value: state,
        });
        window.fetch = async (input, init) => {
            const url = new URL(
                typeof input === 'string' ? input : input instanceof URL
                    ? input.href
                    : input.url,
                location.href,
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
    await page.waitForFunction(() => Boolean(
        (window as unknown as {
            __executeFetchGate?: { started: boolean };
        }).__executeFetchGate?.started,
    ));
}

async function releaseAbortIgnoringFetch(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as unknown as {
            __executeFetchGate?: { release(): void };
        }).__executeFetchGate?.release();
    });
}

async function changeExecuteRecipeFromHistory(
    page: Page,
    recipeId = 'expected-failure-recipe',
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
    page: Page,
): Promise<RallarBlackBoxDistributedRunManifest> {
    const manifest = page.getByLabel('Generated distributed run manifest');
    if (await manifest.count() === 0) {
        await page.locator('[data-execute-manifest] summary').click();
        await expect(manifest).toHaveCount(1);
    }
    const raw = await manifest.textContent();
    if (!raw) throw new Error('Generated Execute manifest is unavailable.');
    return JSON.parse(raw) as RallarBlackBoxDistributedRunManifest;
}

async function fulfillCorsPreflight(route: Route): Promise<void> {
    await route.fulfill({
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers':
                'authorization, content-type, x-client-id',
        },
    });
}

async function installLiveControl(
    context: BrowserContext,
    snapshot: ControlServerSnapshot = liveSnapshot(),
): Promise<void> {
    await context.route(CONTROL_ROUTE, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/runs') {
            await fulfillJson(route, snapshot);
            return;
        }
        await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
                error: `Unhandled ${request.method()} ${url.pathname}`,
            }),
        });
    });
}

async function createDraftThroughVisibleControls(page: Page): Promise<void> {
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    const selectedRecipe = page.locator(
        '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
    );
    await selectedRecipe.evaluate((element) =>
        element.scrollIntoView({ block: 'start' })
    );
    await selectedRecipe.focus();
    await page.keyboard.press('Enter');
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft',
    );
}

test('launches agents and runs a simulated distributed ACK recipe through visible controls', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context, {
        snapshot: { runs: [], distributedRuns: [] },
        enableAgentLaunch: true,
    });
    await page.goto(EXECUTE_ROUTE);
    await page.getByRole('option', { name: /Composite Evidence/ }).click();
    await page.getByLabel('Control run ID for new agents').fill('execute-control-a');
    await page.getByLabel('Agent ID prefix').fill('execute-agent');
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

    const actions = page.locator('[data-execute-action-runway]');
    await expect(
        actions.getByRole('button', { name: 'Resolve 3 targets' }),
    ).toBeEnabled();
    await expect(actions.getByRole('button', { name: 'Create draft' }))
        .toHaveCount(0);
    await actions.getByRole('button', { name: 'Resolve 3 targets' }).click();
    await expect(
        actions.getByRole('button', { name: 'Create draft', exact: true }),
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
            { exact: true },
        ),
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
        name: 'Start distributed run?',
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
        (request) => request.path === '/distributed-runs',
    );
    expect(create?.manifest).toMatchObject({
        controlRunId: 'execute-control-a',
        recipes: [{ recipeId: 'composite-evidence-recipe' }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: expect.arrayContaining(mock.tokenRequests.map(value => value.agentId)),
            expectedParticipantCount: 3,
        },
        metadata: { rolePattern: 'all-agents' },
        ackTimeoutMs: 15_000,
        startMode: 'manual',
    });
    expect(mock.successfulWrites.map((request) => request.path)).toEqual([
        '/distributed-runs/resolve-targets',
        '/distributed-runs/resolve-targets',
        '/distributed-runs',
        '/distributed-runs/resolve-targets',
        expect.stringMatching(/\/stage$/),
        expect.stringMatching(/\/start$/),
    ]);
    expect(
        mock.successfulWrites.every(
            (request) =>
                request.authorization ===
                'Bearer execute-brokered-operator-token',
        ),
    ).toBe(true);
    expect(mock.brokerAuthorizations).toEqual([
        'Bearer execute-primary-session-token',
    ]);
    expect(mock.tokenRequests).toHaveLength(3);
    expect(new Set(mock.tokenRequests.map(value => value.agentId)).size).toBe(3);
    expect(mock.tokenRequests.every(value => value.runId === 'execute-control-a'))
        .toBe(true);
    await expect(page.locator('textarea')).toHaveCount(0);

    const passedUrl = new URL(page.url());
    const passedDistributedRunId = passedUrl.searchParams.get('distributedRunId');
    expect(passedUrl.searchParams.get('controlRunId')).toBe('execute-control-a');
    expect(passedDistributedRunId).toMatch(/^dist-/);
    const monitorUrl = new URL(page.url());
    expect(monitorUrl.searchParams.get('controlRunId')).toBe('execute-control-a');
    expect(monitorUrl.searchParams.get('distributedRunId')).toBe(
        passedDistributedRunId,
    );
    const monitorVerdict = page.locator('[data-monitor-section="verdict"]');
    await expect(monitorVerdict).toHaveAttribute('data-run-state', 'passed');
    await expect(monitorVerdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(monitorVerdict.locator('[data-status="passed"]')).toContainText('Passed');
    for (const child of childPages) await child.close();
});

test('generates a fresh run ID when the same recipe starts another run', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context);
    await createDraftThroughVisibleControls(page);
    const firstRunId = new URL(page.url()).searchParams.get('distributedRunId');
    expect(firstRunId).toMatch(/^dist-/);

    const selectedRecipe = page.locator(
        '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
    );
    await selectedRecipe.evaluate((element) =>
        element.scrollIntoView({ block: 'start' })
    );
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
        'draft',
    );
    await expect(page).toHaveURL(
        new RegExp(`(?:\\?|&)distributedRunId=${secondManifest.distributedRunId}(?:&|$)`),
    );
    expect(
        mock.successfulWrites.filter(
            (request) => request.path === '/distributed-runs',
        ),
    ).toHaveLength(2);
});

test('advances after Resolve while root reconciliation waits for an earlier read', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
        )
        .click();
    const actions = page.locator('[data-execute-action-runway]');

    mock.deferNextRunRead();
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await mock.waitForDeferredRunRead();
    const readsBeforeResolve = mock.runRequestCount();

    try {
        await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
        await expect(
            actions.getByRole('button', { name: 'Create draft', exact: true }),
        ).toBeEnabled({ timeout: 1_000 });
        expect(mock.successfulWrites.map(request => request.path)).toEqual([
            '/distributed-runs/resolve-targets',
        ]);
        expect(mock.runRequestCount()).toBe(readsBeforeResolve);
    } finally {
        mock.releaseDeferredRunRead();
    }

    await expect.poll(() => mock.runRequestCount())
        .toBeGreaterThan(readsBeforeResolve);
});

test('queues a post-mutation read behind a preexisting control refresh', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
        )
        .click();
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();

    mock.deferNextRunRead();
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await mock.waitForDeferredRunRead();
    const readsWithPreMutationRequestPending = mock.runRequestCount();

    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect.poll(() => mock.successfulWrites.filter(
        (request) => request.path === '/distributed-runs'
    ).length).toBe(1);
    mock.releaseDeferredRunRead();

    await expect.poll(
        () => mock.runRequestCount(),
        { timeout: 1_500 },
    ).toBeGreaterThan(readsWithPreMutationRequestPending);
    await expect(actions).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft',
    );
});

test('diagnoses non-targetable agents before staging', async ({
    context,
    page,
}) => {
    const controlRunId = 'execute-control-blocked';
    const now = Date.now();
    const run: ControlRunSnapshot = {
        runId: controlRunId,
        createdAtEpochMs: now - 10_000,
        updatedAtEpochMs: now,
        agents: [
            agent(controlRunId, 'agent-safe'),
            agent(controlRunId, 'agent-offline', { connected: false }),
            agent(controlRunId, 'agent-other-group', {
                groupId: 'other-group',
            }),
        ],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
    await installLiveControl(context, { runs: [run], distributedRuns: [] });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=${controlRunId}`);

    const targets = page.locator('[data-execute-targets]');
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        1,
    );
    await expect(targets.locator('[data-target-status="offline"]')).toHaveCount(
        1,
    );
    await expect(
        targets.locator('[data-target-status="different-group"]'),
    ).toHaveCount(1);
    await expect(targets.getByRole('checkbox')).toHaveCount(1);
    await expect(targets).toContainText('disconnected from the control server');
    await expect(targets).toContainText(
        'does not match the selected global group',
    );
    await expect(
        page
            .locator('[data-execute-action-runway]')
            .getByRole('button', { name: /Stage \d+ agents/ }),
    ).toHaveCount(0);
    await expect(
        page
            .locator('[data-execute-action-runway]')
            .getByRole('button', { name: /Resolve \d+ targets/ }),
    ).toBeEnabled();
});

test('restores an existing Execute run from a copied v1 URL', async ({
    context,
    page,
}) => {
    const control = liveSnapshot();
    const catalogItem = DISTRIBUTED_RECIPE_CATALOG.find(
        (item) => item.itemId === 'composite-evidence',
    );
    if (!catalogItem)
        throw new Error('Composite Evidence catalog item is missing.');
    const manifest: RallarBlackBoxDistributedRunManifest = {
        schemaVersion: 1,
        distributedRunId: 'dist-restored-composite',
        controlRunId: control.runs[0].runId,
        displayName: 'Restored Composite Evidence',
        group: GROUP,
        recipes: [
            {
                recipeId: catalogItem.recipe.recipeId,
                recipe: catalogItem.recipe,
                required: true,
            },
        ],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['execute-agent-a', 'execute-agent-b'],
            expectedParticipantCount: 2,
        },
        ackTimeoutMs: 15_000,
        startMode: 'manual',
    };
    const restored = distributedRun(manifest, 'ready', Date.now());
    await installLiveControl(context, {
        ...control,
        distributedRuns: [restored],
    });
    await page.goto(
        `${EXECUTE_ROUTE}&controlRunId=${control.runs[0].runId}` +
            `&distributedRunId=${restored.distributedRunId}`,
    );

    await expect(page).toHaveURL(
        /(?:\?|&)recipeId=composite-evidence-recipe(?:&|$)/,
    );
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
        ),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'ready',
    );
    await expect(
        page.locator('[data-execute-targets]').getByRole('checkbox'),
    ).toHaveCount(2);
    await expect(
        page.getByRole('button', { name: 'Review and start' }),
    ).toBeVisible();
});

test('refuses Stage when fresh target resolution drifts', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context, {
        resolutionTargetIds(call, manifest) {
            const selected = manifest.targetPolicy.agentIds ?? [];
            return call === 3 ? selected.slice(0, 1) : selected;
        },
    });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    const readsBeforeFailure = mock.runRequestCount();

    await actions
        .getByRole('button', { name: /Stage \d+ agents/ })
        .click();

    const error = page.locator('[data-execute-run-status] [data-error-kind]');
    await expect(error).toContainText(
        'Server-resolved target IDs no longer exactly match the selected safe IDs.',
    );
    expect(
        mock.successfulWrites.some((request) =>
            request.path.endsWith('/stage'),
        ),
    ).toBe(false);
    expect(mock.runRequestCount()).toBeGreaterThan(readsBeforeFailure);
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft',
    );
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await expect(actions.getByRole('button', { name: /Stage \d+ agents/ }))
        .toBeEnabled();
});

test('keeps structured control provenance after a failed mutation refresh', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context, {
        failure: {
            path: '/distributed-runs/resolve-targets',
            status: 409,
            message: 'Resolution conflict from control truth.',
        },
    });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    const actions = page.locator('[data-execute-action-runway]');
    const readsBeforeFailure = mock.runRequestCount();
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();

    const error = page.locator(
        '[data-execute-run-status] [data-error-kind="http"]',
    );
    await expect(error).toContainText(
        'Resolution conflict from control truth.',
    );
    await expect(error).toContainText('HTTP 409');
    expect(mock.runRequestCount()).toBeGreaterThan(readsBeforeFailure);
    await expect(
        actions.getByRole('button', { name: /Resolve \d+ targets/ }),
    ).toBeEnabled();
});

test('renders credential-trust truth when a URL-selected control rejects Resolve', async ({
    context,
    page,
}) => {
    const controlAuthorizations: Array<string | null> = [];
    const brokerRequests: string[] = [];
    await context.addInitScript(() => {
        localStorage.setItem('auth.session', JSON.stringify({
            clientId: 'ambient-client',
            sessionId: 'ambient-session',
            username: 'ambient-operator',
            accessToken: 'ambient-session-secret',
            expiresAtEpochMs: 4_000_000_000_000,
        }));
    });
    await context.route(API_ROUTE, async (route) => {
        brokerRequests.push(route.request().url());
        await fulfillJson(route, { error: 'Broker must not be called.' }, 500);
    });
    await context.route('https://untrusted-control.test/**', async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') {
            await fulfillCorsPreflight(route);
            return;
        }
        controlAuthorizations.push(request.headers().authorization ?? null);
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'GET' && pathname === '/runs') {
            await fulfillJson(route, liveSnapshot());
            return;
        }
        if (
            request.method() === 'POST' &&
            pathname === '/distributed-runs/resolve-targets'
        ) {
            await fulfillJson(route, { error: 'Operator token required.' }, 401);
            return;
        }
        await fulfillJson(route, { error: 'Unhandled control request.' }, 404);
    });

    await page.goto(
        `${EXECUTE_ROUTE}&controlRunId=execute-control-a` +
            '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol',
    );
    await page
        .locator('[data-execute-action-runway]')
        .getByRole('button', { name: /Resolve \d+ targets/ })
        .click();

    const error = page.locator(
        '[data-execute-run-status] [data-error-kind="credential-trust"]',
    );
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText('Credential trust');
    await expect(error).toContainText(
        'Automatic stored credentials are blocked for a URL-configured control endpoint.',
    );
    expect(controlAuthorizations.length).toBeGreaterThanOrEqual(2);
    expect(controlAuthorizations.every((authorization) => authorization === null))
        .toBe(true);
    expect(brokerRequests).toEqual([]);
});

test('clears a completed operation error when Execute context changes', async ({
    context,
    page,
}) => {
    await installLifecycleControl(context, {
        failure: {
            path: '/distributed-runs/resolve-targets',
            status: 409,
            message: 'Recipe A resolution conflict.',
        },
    });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    const error = page.locator(
        '[data-execute-run-status] [data-error-kind="http"]',
    );
    await page
        .locator('[data-execute-action-runway]')
        .getByRole('button', { name: /Resolve \d+ targets/ })
        .click();
    await expect(error).toContainText('Recipe A resolution conflict.');

    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]',
        )
        .click();
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]',
        ),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(error).toHaveCount(0);
});

test('rejects a mutation response for a different run identity', async ({
    context,
    page,
}) => {
    await installLifecycleControl(context, {
        createResponseDistributedRunId: 'dist-wrong-response',
    });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
        )
        .click();
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();

    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]'),
    ).toContainText(
        'Control response identity does not match the requested distributed run.',
    );
    await expect(actions.getByRole('button', {
        name: 'Create draft',
        exact: true,
    })).toBeFocused();
    await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
});

test('aborts an in-flight action when Execute configuration changes', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context, {
        deferResolution: true,
    });
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
        )
        .click();
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
        '[data-searchable-listbox-disabled-focus]',
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
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]',
        ),
    ).toHaveAttribute('aria-selected', 'true');
    mock.releaseDeferredResolution();

    await expect(actions).toHaveAttribute('aria-busy', 'false');
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]'),
    ).toHaveCount(0);
    expect(mock.runRequestCount()).toBe(readsBeforeChange);
});

test('rejects an abort-ignoring stale Create response after context changes', async ({
    context,
    page,
}) => {
    await installAbortIgnoringFetchGate(context, '/distributed-runs');
    await installLifecycleControl(context);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);
    await page
        .locator(
            '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]',
        )
        .click();
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await waitForAbortIgnoringFetch(page);

    await changeExecuteRecipeFromHistory(page);
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="expected-failure-recipe"]',
        ),
    ).toHaveAttribute('aria-selected', 'true');
    await releaseAbortIgnoringFetch(page);

    await expect(actions).toHaveAttribute('aria-busy', 'false');
    await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'uncreated',
    );
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind]'),
    ).toHaveCount(0);
});

test('rejects an abort-ignoring stale Export response after context changes', async ({
    context,
    page,
}) => {
    await installAbortIgnoringFetchGate(
        context,
        '/distributed-runs/deferred/artifacts',
    );
    await installLifecycleControl(context);
    await createDraftThroughVisibleControls(page);
    const runId = new URL(page.url()).searchParams.get('distributedRunId');
    if (!runId) throw new Error('Created run URL omitted distributedRunId.');
    const gatePath = `/distributed-runs/${encodeURIComponent(runId)}/artifacts`;
    await page.evaluate((pathname) => {
        const gate = (window as unknown as {
            __executeFetchGate?: { pathname?: string };
        }).__executeFetchGate;
        if (gate) gate.pathname = pathname;
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
        page.locator('[data-execute-run-status] [data-error-kind]'),
    ).toHaveCount(0);
});

test('cancels a known non-terminal run through an accessible confirmation', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context);
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');

    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?',
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
        'cancelled',
    );
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true }),
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeFocused();
    expect(
        mock.successfulWrites.some((request) =>
            request.path.endsWith('/cancel'),
        ),
    ).toBe(true);
});

test('keeps failed Cancel focus trapped and disables dialog motion when requested', async ({
    context,
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLifecycleControl(context, {
        failure: {
            path: '/cancel',
            status: 409,
            message: 'Cancellation conflict from control truth.',
        },
    });
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?',
    });
    await expect(dialog).toBeVisible();
    const motion = await page.locator('[data-execute-cancel-dialog]').evaluate(
        (backdrop) => {
            const dialogElement = backdrop.querySelector<HTMLElement>(
                '[role="alertdialog"]',
            );
            return {
                backdropAnimation: getComputedStyle(backdrop).animationName,
                dialogAnimation: dialogElement
                    ? getComputedStyle(dialogElement).animationName
                    : 'missing',
            };
        },
    );
    expect(motion).toEqual({
        backdropAnimation: 'none',
        dialogAnimation: 'none',
    });

    await dialog
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    await expect(dialog).toBeVisible();
    await expect(
        page.locator('[data-execute-run-status] [data-error-kind="http"]'),
    ).toContainText('Cancellation conflict from control truth.');
    await expect(dialog).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(
        dialog.getByRole('button', { name: 'Cancel run', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Keep run' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true }),
    ).toBeFocused();
});

test('does not reopen Cancel when URL context leaves and restores a run', async ({
    context,
    page,
}) => {
    await installLifecycleControl(context);
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?',
    });
    await expect(dialog).toBeVisible();

    await changeExecuteRecipeFromHistory(page);
    await expect(dialog).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft',
    );
    await expect(dialog).toHaveCount(0);
});

test('renders waiting-for-barrier truth with bounded Start Cancel and Export policy', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context);
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
        actions.getByRole('button', { name: 'Review and start' }),
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true }),
    ).toBeEnabled();
    await expect(
        actions.getByRole('button', { name: 'Export artifact' }),
    ).toBeEnabled();
});

test('closes Cancel on terminal failed truth and announces the authoritative error', async ({
    context,
    page,
}) => {
    const mock = await installLifecycleControl(context);
    await createDraftThroughVisibleControls(page);
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?',
    });
    await expect(dialog).toBeVisible();

    mock.setRunState('failed', {
        code: 'RALLAR_BB_TERMINAL_FAILURE',
        message: 'Authoritative terminal failure from control truth.',
    });
    await page.getByRole('button', { name: 'Refresh control data' }).evaluate(
        (button) => (button as HTMLButtonElement).click(),
    );

    const status = page.locator('[data-execute-run-status]');
    await expect(status.locator('[data-execute-run-live-summary]'))
        .toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveAttribute('data-run-state', 'failed');
    await expect(status.getByRole('alert')).toContainText(
        'Authoritative terminal failure from control truth.',
    );
    await expect(dialog).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Review and start' }),
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Cancel run', exact: true }),
    ).toHaveCount(0);
    await expect(
        actions.getByRole('button', { name: 'Export artifact' }),
    ).toBeEnabled();
    expect(
        mock.successfulWrites.some((request) => request.path.endsWith('/cancel')),
    ).toBe(false);
});

test('selects an explicit control run inside the single target plane', async ({
    context,
    page,
}) => {
    const first = liveSnapshot().runs[0];
    const secondRunId = 'execute-control-b';
    const second: ControlRunSnapshot = {
        ...first,
        runId: secondRunId,
        agents: [agent(secondRunId, 'execute-agent-c')],
    };
    await installLiveControl(context, {
        runs: [first, second],
        distributedRuns: [],
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
        targets.getByText('execute-agent-c', { exact: true }),
    ).toBeVisible();
});

test('restores safe targets when an explicit control run becomes live', async ({
    context,
    page,
}) => {
    await installLiveControl(context);
    await page.goto(`${EXECUTE_ROUTE}&controlRunId=execute-control-a`);

    const targets = page.locator('[data-execute-targets]');
    await expect(
        targets.locator('[data-searchable-listbox-trigger]'),
    ).toContainText('execute-control-a');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(2);
    await expect(targets.getByRole('checkbox')).toHaveCount(2);
    await expect(targets.getByRole('checkbox').first()).toBeChecked();
    await expect(targets.getByRole('checkbox').last()).toBeChecked();
});

test('keeps late Execute pressure evidence operable without changing lifecycle authority', async ({
    browser,
}) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
        hasTouch: true,
        viewport: { width: 430, height: 932 },
    });
    try {
        const snapshot = pressureSnapshot();
        const mock = await installLifecycleControl(context, {
            refreshAgentEvidence: true,
            snapshot,
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
            name: 'Control run options window',
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
            name: 'Search Control run',
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
            `[data-option-key="${selectedRunId}"]`,
        );
        await expect(selectedOption).toHaveCount(1);
        await selectedOption.tap();
        await expect(page).toHaveURL(new RegExp(`controlRunId=${selectedRunId}`));
        await expect(targets.locator('[data-execute-target]')).toHaveCount(100);
        expect(mock.successfulWrites).toHaveLength(0);

        const targetWindowUrl = page.url();
        const targetWindow = targets.getByRole('group', { name: 'Targets window' });
        const targetAnchor = targets.locator(
            '[data-execute-window-focus-anchor="targets"]',
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
            name: `Select ${lateAgentId}`,
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

    } finally {
        await context.close();
    }
});

test('preserves the complete 240-target manifest through pressure lifecycle mutations', async ({
    context,
    page,
}) => {
    test.setTimeout(60_000);
    const snapshot = pressureSnapshot();
    const mock = await installLifecycleControl(context, {
        refreshAgentEvidence: true,
        snapshot,
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
        'draft',
    );
    const create = mock.successfulWrites.find(request =>
        request.path === '/distributed-runs'
    );
    expect(create?.manifest?.targetPolicy).toEqual({
        mode: 'selected-agents',
        agentIds: Array.from({ length: 240 }, (_unused, index) =>
            `pressure-agent-${String(index).padStart(4, '0')}`
        ),
        expectedParticipantCount: 240,
    });
    await actions.getByRole('button', { name: /Stage \d+ agents/ }).click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'waiting-for-ack',
    );
    expect(mock.successfulWrites.map(request => request.path)).toEqual([
        '/distributed-runs/resolve-targets',
        '/distributed-runs/resolve-targets',
        '/distributed-runs',
        '/distributed-runs/resolve-targets',
        expect.stringMatching(/\/stage$/),
    ]);
});

test('renders one live recipe-aware target plane without seeded fallback', async ({
    context,
    page,
}) => {
    await installLiveControl(context);
    await page.goto(EXECUTE_ROUTE);

    await expect(page.locator('[data-execute-workspace]')).toBeVisible();
    await expect(page.locator('[data-execute-catalog]')).toBeVisible();
    await expect(
        page.locator(
            '[data-execute-recipe][data-recipe-id="rtc-realtime-stability"]',
        ),
    ).toHaveAttribute('aria-selected', 'true');
    const targets = page.locator('[data-execute-targets]');
    await expect(targets).toBeVisible();
    await expect(targets.locator('[data-execute-target]')).toHaveCount(2);
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        2,
    );
    await expect(targets.getByRole('checkbox')).toHaveCount(2);
    await expect(
        page.getByRole('region', { name: 'Control overview' }),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('seed-agent');
    await expect(page.locator('[data-execute-preflight]')).toBeVisible();
    await expect(
        page
            .locator('[data-execute-action-runway]')
            .getByRole('button', { name: /Resolve \d+ targets/ }),
    ).toBeEnabled();
});

test('keeps catalog and preflight available while offline actions remain blocked', async ({
    context,
    page,
}) => {
    await context.route(CONTROL_ROUTE, (route) =>
        route.abort('connectionfailed'),
    );
    await page.goto(EXECUTE_ROUTE);

    await expect(page.locator('[data-execute-catalog]')).toBeVisible();
    await expect(page.locator('[data-execute-preflight]')).toBeVisible();
    await expect(page.locator('[data-execute-target]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('seed-agent');
    const actions = page.locator('[data-execute-action-runway]');
    await expect(
        actions.getByRole('button', { name: 'Refresh control data' }),
    ).toBeEnabled();
    await expect(
        actions.getByRole('button', { name: 'Refresh control data' }),
    ).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(
        actions.getByRole('button', { name: 'Refresh', exact: true }),
    ).toHaveCount(0);
    await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ }))
        .toHaveCount(0);
    await expect(actions.getByRole('button', { name: 'Create draft' }))
        .toHaveCount(0);
    await expect(actions).toContainText(/offline|control truth|Refresh/i);
});
