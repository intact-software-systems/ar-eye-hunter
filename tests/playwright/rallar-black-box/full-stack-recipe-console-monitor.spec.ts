import {
    expect,
    type APIRequestContext,
    type APIResponse,
    type Page,
    test,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    evaluateFullStackConfiguredServiceEvidence,
    type FullStackConfiguredServiceProbe,
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    FULL_STACK_SPA_ORIGIN,
    loginUser,
    openBrowserControlAgent,
    readExhaustivePostgresConfig,
    uniqueGroupId,
    uniqueRunId,
    waitForControlRunAgent,
} from './full-stack-helpers.ts';

const CONFIGURED_LIVE_SKIP_REASON = 'Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.';
const CONFIGURED_POSTGRES = readExhaustivePostgresConfig();
const CONFIGURED_POSTGRES_MODE =
    (process.env.RALLAR_BLACK_BOX_API_MODE?.trim() ?? 'postgres') ===
    'postgres';
const CONFIGURED_FRESH_POSTGRES_API = [
    '1',
    'true',
].includes(
    process.env.RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API?.trim().toLowerCase() ?? '',
);

async function configuredPostgresStackAvailability(
    request: APIRequestContext,
): Promise<'ready' | 'unavailable'> {
    if (!CONFIGURED_POSTGRES.enabled ||
        !CONFIGURED_POSTGRES_MODE ||
        !CONFIGURED_FRESH_POSTGRES_API
    ) {
        return 'unavailable';
    }
    const [apiProbe, controlProbe] = await Promise.allSettled([
        request.get(`${CONFIGURED_POSTGRES.apiBaseUrl}/api/config`, {
            failOnStatusCode: false,
            headers: { origin: FULL_STACK_SPA_ORIGIN },
            timeout: 5_000,
        }),
        request.get(`${CONFIGURED_POSTGRES.controlBaseUrl}/health`, {
            failOnStatusCode: false,
            timeout: 5_000,
        }),
    ]);
    return await evaluateFullStackConfiguredServiceEvidence({
        api: configuredServiceProbe(apiProbe, 'API configuration'),
        control: configuredServiceProbe(controlProbe, 'control health'),
        expectedApiBaseUrl: CONFIGURED_POSTGRES.apiBaseUrl,
    });
}

function configuredServiceProbe(
    probe: PromiseSettledResult<APIResponse>,
    label: string,
): FullStackConfiguredServiceProbe {
    if (probe.status === 'rejected') return { kind: 'unavailable' };
    return {
        kind: 'reachable',
        ok: probe.value.ok(),
        status: probe.value.status(),
        statusText: probe.value.statusText(),
        readJson: () => configuredReadinessJson(probe.value, label),
    };
}

async function configuredReadinessJson(
    response: APIResponse,
    label: string,
): Promise<unknown> {
    try {
        return await response.json() as unknown;
    } catch (cause) {
        throw new Error(`Configured ${label} returned malformed JSON.`, {
            cause,
        });
    }
}

function operatorUrl(input: Readonly<{
    groupId: string;
    controlRunId: string;
    sessionId: string;
}>): string {
    return `${FULL_STACK_SPA_ORIGIN}/?${new URLSearchParams({
        provider: 'browser-rallar',
        v: '1',
        experience: 'recipe-console',
        view: 'execute',
        recipeId: 'rtc-realtime-stability',
        apiBaseUrl: CONFIGURED_POSTGRES.apiBaseUrl,
        controlUrl: CONFIGURED_POSTGRES.controlWsUrl,
        applicationId: CONFIGURED_POSTGRES.applicationId,
        workspaceId: CONFIGURED_POSTGRES.workspaceId,
        roomId: input.groupId,
        controlRunId: input.controlRunId,
        actor: CONFIGURED_POSTGRES.userC.actor,
        sessionId: input.sessionId,
    }).toString()}`;
}

async function assertLiveExecuteTargets(
    page: Page,
    agentIds: readonly string[],
): Promise<void> {
    const recipe = page.locator(
        '[data-execute-recipe][data-recipe-id="rtc-realtime-stability"]',
    );
    await expect(recipe).toHaveAttribute('aria-selected', 'true');
    await expect(recipe).toContainText('browser-rallar');
    await expect(recipe).toContainText('Live services');

    const targets = page.locator('[data-execute-targets]');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(
        agentIds.length,
        { timeout: 30_000 },
    );
    for (const agentId of agentIds) await expect(targets).toContainText(agentId);
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        agentIds.length,
    );
}

async function createDraftThroughVisibleExecuteControls(
    page: Page,
): Promise<string> {
    const actions = page.locator('[data-execute-action-band]');
    await actions.getByRole('button', { name: 'Resolve targets' }).click();
    await actions.getByRole('button', { name: 'Arm Create draft' }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft',
    );
    const distributedRunId = new URL(page.url()).searchParams.get(
        'distributedRunId',
    );
    expect(distributedRunId).toMatch(/^dist-/);
    if (!distributedRunId) {
        throw new Error('Created run URL omitted distributedRunId.');
    }
    return distributedRunId;
}

async function stageThroughVisibleExecuteControls(page: Page): Promise<void> {
    const actions = page.locator('[data-execute-action-band]');
    await actions.getByRole('button', { name: 'Arm Stage run' }).click();
    await actions
        .getByRole('button', { name: 'Stage run', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'ready',
        { timeout: 60_000 },
    );
}

async function startThroughVisibleExecuteControls(page: Page): Promise<void> {
    const actions = page.locator('[data-execute-action-band]');
    await actions.getByRole('button', { name: 'Arm Start run' }).click();
    await actions
        .getByRole('button', { name: 'Start run', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'passed',
        { timeout: 90_000 },
    );
}

async function navigateToMonitor(
    page: Page,
    distributedRunId: string,
    state: ControlDistributedRunSnapshot['state'],
): Promise<void> {
    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page).toHaveURL(/(?:\?|&)view=monitor(?:&|$)/);
    await expect(page).toHaveURL(
        new RegExp(`(?:\\?|&)distributedRunId=${distributedRunId}(?:&|$)`),
    );
    await expect(
        page.locator('[data-monitor-section="verdict"]'),
    ).toHaveAttribute('data-run-state', state, { timeout: 30_000 });
}

async function exportMonitorArtifact(
    page: Page,
    distributedRunId: string,
): Promise<Readonly<Record<string, unknown>>> {
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    const downloadPromise = page.waitForEvent('download');
    await actions.getByRole('button', { name: 'Export artifact' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
        `${distributedRunId}-artifact.json`,
    );
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Artifact download path is unavailable.');
    return JSON.parse(await readFile(downloadPath, 'utf8')) as Readonly<
        Record<string, unknown>
    >;
}

function assertSchemaV2Artifact(
    artifact: Readonly<Record<string, unknown>>,
    input: Readonly<{
        distributedRunId: string;
        controlRunId: string;
        groupId: string;
        agentIds: readonly string[];
    }>,
): void {
    expect(artifact).toMatchObject({
        artifactSchemaVersion: 2,
        distributedRunId: input.distributedRunId,
        files: {
            'distributed-run.json': expect.any(String),
            'manifest.json': expect.any(String),
            'target-resolution.json': expect.any(String),
            'control-run.json': expect.any(String),
            'report.json': expect.any(String),
            'metadata.json': expect.any(String),
        },
    });
    const files = artifact.files as Record<string, string>;
    expect(JSON.parse(files['manifest.json'] ?? '{}')).toMatchObject({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        group: { groupId: input.groupId },
        recipes: [{ recipeId: 'rtc-realtime-stability' }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: [...input.agentIds].sort(),
            expectedParticipantCount: input.agentIds.length,
        },
    });
    expect(JSON.parse(files['distributed-run.json'] ?? '{}')).toMatchObject({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'passed',
        targetAgentIds: [...input.agentIds].sort(),
        rollup: { state: 'passed', ok: true },
    });
    expect(JSON.parse(files['report.json'] ?? '{}')).toMatchObject({
        artifactSchemaVersion: 2,
        execution: 'distributed-run',
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'passed',
        ok: true,
    });
    expect(JSON.parse(files['control-run.json'] ?? '{}')).toMatchObject({
        runId: input.controlRunId,
        agents: expect.arrayContaining(input.agentIds.map(agentId =>
            expect.objectContaining({
                agentId,
                identity: expect.objectContaining({
                    groupId: input.groupId,
                    providerMode: 'browser-rallar',
                }),
            })
        )),
        results: expect.arrayContaining([
            expect.objectContaining({ ok: true }),
        ]),
    });
}

async function fetchDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.get(
        `${CONFIGURED_POSTGRES.controlBaseUrl}/distributed-runs/${encodeURIComponent(distributedRunId)}`,
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ControlDistributedRunSnapshot;
}

async function fetchControlRun(
    request: APIRequestContext,
    controlRunId: string,
): Promise<ControlRunSnapshot> {
    const response = await request.get(
        `${CONFIGURED_POSTGRES.controlBaseUrl}/runs/${encodeURIComponent(controlRunId)}`,
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ControlRunSnapshot;
}

function hasCompletedCancelProof(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
): boolean {
    const cancelLinks = distributedRun.commandLinks.filter(
        link => link.phase === 'cancel',
    );
    return distributedRun.state === 'cancelled' &&
        cancelLinks.length === distributedRun.targetAgentIds.length &&
        distributedRun.targetAgentIds.every(agentId =>
            cancelLinks.filter(link => link.agentId === agentId).length === 1
        ) &&
        cancelLinks.every(link => {
            const command = controlRun.commands.find(candidate =>
                candidate.envelope.commandId === link.commandId
            );
            const result = controlRun.results.find(candidate =>
                candidate.commandId === link.commandId &&
                candidate.agentId === link.agentId
            );
            return command?.envelope.command.kind === 'recipe.cancel' &&
                command.dispatchedAtEpochMs !== undefined &&
                command.completedAtEpochMs !== undefined &&
                result?.ok === true;
        });
}

async function expectCompletedCancelProof(
    request: APIRequestContext,
    controlRunId: string,
    distributedRunId: string,
): Promise<void> {
    await expect.poll(async () => {
        const [distributedRun, controlRun] = await Promise.all([
            fetchDistributedRun(request, distributedRunId),
            fetchControlRun(request, controlRunId),
        ]);
        return hasCompletedCancelProof(distributedRun, controlRun);
    }, { timeout: 30_000 }).toBe(true);

    const [distributedRun, controlRun] = await Promise.all([
        fetchDistributedRun(request, distributedRunId),
        fetchControlRun(request, controlRunId),
    ]);
    const cancelLinks = distributedRun.commandLinks.filter(
        link => link.phase === 'cancel',
    );
    expect(cancelLinks.map(link => link.agentId).sort()).toEqual(
        [...distributedRun.targetAgentIds].sort(),
    );
    for (const link of cancelLinks) {
        expect(controlRun.commands.find(candidate =>
            candidate.envelope.commandId === link.commandId
        )).toMatchObject({
            envelope: {
                agentId: link.agentId,
                commandId: link.commandId,
                command: { kind: 'recipe.cancel' },
            },
            dispatchedAtEpochMs: expect.any(Number),
            completedAtEpochMs: expect.any(Number),
        });
        expect(controlRun.results.find(candidate =>
            candidate.commandId === link.commandId &&
            candidate.agentId === link.agentId
        )).toMatchObject({
            agentId: link.agentId,
            commandId: link.commandId,
            ok: true,
        });
    }
}

test('completes the configured live distributed run lifecycle and exports its artifact', async ({
    browser,
    page,
    request,
}, testInfo) => {
    test.skip(
        !CONFIGURED_POSTGRES.enabled ||
            !CONFIGURED_POSTGRES_MODE ||
            !CONFIGURED_FRESH_POSTGRES_API,
        CONFIGURED_LIVE_SKIP_REASON,
    );
    test.skip(
        (await configuredPostgresStackAvailability(request)) === 'unavailable',
        CONFIGURED_LIVE_SKIP_REASON,
    );
    test.setTimeout(240_000);
    await expectFullStackApiReady(request, CONFIGURED_POSTGRES);

    const groupId = uniqueGroupId(testInfo);
    const controlRunId = uniqueRunId(testInfo);
    const agentIds = [
        `${controlRunId}-agent-a`,
        `${controlRunId}-agent-b`,
    ];
    const operatorSessionId = `${controlRunId}-operator-session`;
    const agents: Array<Awaited<ReturnType<typeof openBrowserControlAgent>>> = [];

    try {
        agents.push(
            await openBrowserControlAgent(
                browser,
                CONFIGURED_POSTGRES,
                CONFIGURED_POSTGRES.userA,
                { runId: controlRunId, agentId: agentIds[0], groupId },
            ),
        );
        agents.push(
            await openBrowserControlAgent(
                browser,
                CONFIGURED_POSTGRES,
                CONFIGURED_POSTGRES.userB,
                { runId: controlRunId, agentId: agentIds[1], groupId },
            ),
        );
        await Promise.all(agentIds.map(agentId =>
            waitForControlRunAgent(request, controlRunId, agentId)
        ));
        await loginUser(page, CONFIGURED_POSTGRES, CONFIGURED_POSTGRES.userC, {
            groupId,
            sessionId: operatorSessionId,
            tab: 'rallar-server',
        });
        await page.goto(operatorUrl({
            groupId,
            controlRunId,
            sessionId: operatorSessionId,
        }));
        await expect(page).toHaveURL(/(?:\?|&)provider=browser-rallar(?:&|$)/);

        await assertLiveExecuteTargets(page, agentIds);
        const passedRunId = await createDraftThroughVisibleExecuteControls(page);
        await stageThroughVisibleExecuteControls(page);
        await startThroughVisibleExecuteControls(page);
        await navigateToMonitor(page, passedRunId, 'passed');
        assertSchemaV2Artifact(
            await exportMonitorArtifact(page, passedRunId),
            { distributedRunId: passedRunId, controlRunId, groupId, agentIds },
        );

        await page.getByRole('button', { name: 'Execute', exact: true }).click();
        await expect(page.locator('[data-execute-workspace]')).toBeVisible();
        await page.goto(operatorUrl({
            groupId,
            controlRunId,
            sessionId: operatorSessionId,
        }));
        await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
        await assertLiveExecuteTargets(page, agentIds);
        const cancelledRunId = await createDraftThroughVisibleExecuteControls(page);
        expect(cancelledRunId).not.toBe(passedRunId);
        await stageThroughVisibleExecuteControls(page);
        expect((await fetchDistributedRun(request, cancelledRunId)).state).toBe(
            'ready',
        );

        await navigateToMonitor(page, cancelledRunId, 'ready');
        const monitorActions = page.getByRole('region', {
            name: 'Monitor actions',
        });
        await monitorActions
            .getByRole('button', { name: 'Arm Cancel', exact: true })
            .click();
        await monitorActions
            .getByRole('button', { name: 'Cancel run', exact: true })
            .click();
        const cancelDialog = page.getByRole('alertdialog', {
            name: 'Cancel distributed run?',
        });
        await expect(cancelDialog).toBeVisible();
        await expect(cancelDialog).toContainText(cancelledRunId);
        await expect(cancelDialog).toContainText('ready');
        await cancelDialog
            .getByRole('button', { name: 'Cancel run', exact: true })
            .click();
        await expect(cancelDialog).toHaveCount(0);
        await expect(
            page.locator('[data-monitor-section="verdict"]'),
        ).toHaveAttribute('data-run-state', 'cancelled', { timeout: 30_000 });
        await expectCompletedCancelProof(
            request,
            controlRunId,
            cancelledRunId,
        );
    } finally {
        try {
            await Promise.allSettled([
                cleanupRallarPage(page),
                ...agents.map(agent => cleanupRallarPage(agent.page)),
            ]);
        } finally {
            await Promise.allSettled(
                agents.map(agent => agent.context.close()),
            );
        }
    }
});
