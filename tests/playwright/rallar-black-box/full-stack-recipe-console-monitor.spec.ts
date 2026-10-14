import {
    expect,
    test,
    type APIRequestContext,
    type APIResponse,
    type Page
} from '@playwright/test';
import { readFile } from 'node:fs/promises';

import type { ControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { decodeControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';

import {
    evaluateFullStackConfiguredServiceEvidence,
    type FullStackConfiguredServiceProbe
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    FULL_STACK_SPA_ORIGIN,
    loginUser,
    readControlRun,
    readExhaustivePostgresConfig,
    uniqueGroupId,
    uniqueRunId,
    waitForControlRunAgent
} from './full-stack-helpers.ts';

interface OperatorUrlInput {
    readonly groupId: string;
    readonly controlRunId: string;
    readonly sessionId: string;
}

interface LaunchBrowserAgentsInput {
    readonly controlRunId: string;
    readonly groupId: string;
    readonly prefix: string;
    readonly count: number;
}

interface LaunchedBrowserAgents {
    readonly pages: readonly Page[];
    readonly agentIds: readonly string[];
}

interface ArtifactExpectation {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly groupId: string;
    readonly agentIds: readonly string[];
}

const CONFIGURED_LIVE_SKIP_REASON =
    'Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.';
const CONFIGURED_POSTGRES = readExhaustivePostgresConfig();
const CONFIGURED_POSTGRES_MODE = (process.env.RALLAR_BLACK_BOX_API_MODE?.trim() ?? 'postgres') ===
    'postgres';
const CONFIGURED_FRESH_POSTGRES_API = [
    '1',
    'true'
].includes(
    process.env.RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API?.trim().toLowerCase() ?? ''
);

test('completes the configured live distributed run lifecycle and exports its artifact', async ({
    page,
    request
}, testInfo) => {
    test.skip(
        !CONFIGURED_POSTGRES.enabled ||
            !CONFIGURED_POSTGRES_MODE ||
            !CONFIGURED_FRESH_POSTGRES_API,
        CONFIGURED_LIVE_SKIP_REASON
    );
    test.skip(
        (await configuredPostgresStackAvailability(request)) === 'unavailable',
        CONFIGURED_LIVE_SKIP_REASON
    );
    test.setTimeout(240_000);
    await expectFullStackApiReady(request, CONFIGURED_POSTGRES);

    const groupId = uniqueGroupId(testInfo);
    const controlRunId = uniqueRunId(testInfo);
    const operatorSessionId = `${controlRunId}-operator-session`;
    const agentPages: Page[] = [];
    let agentIds: readonly string[] = [];

    try {
        await loginUser({
            page,
            config: CONFIGURED_POSTGRES,
            user: CONFIGURED_POSTGRES.userC,
            groupId,
            sessionId: operatorSessionId,
            tab: 'rallar-server'
        });
        await page.goto(operatorUrl({
            groupId,
            controlRunId,
            sessionId: operatorSessionId
        }));
        await expect(page).toHaveURL(/(?:\?|&)provider=browser-rallar(?:&|$)/);

        const launched = await launchBrowserAgentsThroughVisibleControls(page, {
            controlRunId,
            groupId,
            prefix: 'recipe-console-live-agent',
            count: 3
        });
        agentPages.push(...launched.pages);
        agentIds = launched.agentIds;
        await Promise.all(agentIds.map((agentId) => waitForControlRunAgent(request, controlRunId, agentId)));

        await assertLiveExecuteTargets(page, agentIds);
        const passedRunId = await createDraftThroughVisibleExecuteControls(page);
        await stageThroughVisibleExecuteControls(page);
        await startThroughVisibleExecuteControls(page);
        await navigateToMonitor(page, passedRunId, 'passed');
        assertSchemaV2Artifact(
            await exportMonitorArtifact(page, passedRunId),
            { distributedRunId: passedRunId, controlRunId, groupId, agentIds }
        );

        await page.getByRole('button', { name: 'Execute', exact: true }).click();
        await expect(page.locator('[data-execute-workspace]')).toBeVisible();
        await page.goto(operatorUrl({
            groupId,
            controlRunId,
            sessionId: operatorSessionId
        }));
        await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
        await assertLiveExecuteTargets(page, agentIds);
        const cancelledRunId = await createDraftThroughVisibleExecuteControls(page);
        expect(cancelledRunId).not.toBe(passedRunId);
        await stageThroughVisibleExecuteControls(page);
        expect((await readDistributedRun(request, cancelledRunId)).state).toBe(
            'ready'
        );

        await navigateToMonitor(page, cancelledRunId, 'ready');
        const monitorActions = page.getByRole('region', {
            name: 'Monitor actions'
        });
        await monitorActions
            .getByRole('button', { name: 'Arm Cancel', exact: true })
            .click();
        await monitorActions
            .getByRole('button', { name: 'Cancel run', exact: true })
            .click();
        const cancelDialog = page.getByRole('alertdialog', {
            name: 'Cancel distributed run?'
        });
        await expect(cancelDialog).toBeVisible();
        await expect(cancelDialog).toContainText(cancelledRunId);
        await expect(cancelDialog).toContainText('ready');
        await cancelDialog
            .getByRole('button', { name: 'Cancel run', exact: true })
            .click();
        await expect(cancelDialog).toHaveCount(0);
        await expect(
            page.locator('[data-monitor-section="verdict"]')
        ).toHaveAttribute('data-run-state', 'cancelled', { timeout: 30_000 });
        await expectCompletedCancelProof(
            request,
            controlRunId,
            cancelledRunId
        );
    }
    finally {
        try {
            await Promise.allSettled([
                cleanupRallarPage(page),
                ...agentPages.map((agentPage) => cleanupRallarPage(agentPage))
            ]);
        }
        finally {
            await Promise.allSettled(
                agentPages.map((agentPage) => agentPage.close())
            );
        }
    }
});

function configuredServiceProbe(
    probe: PromiseSettledResult<APIResponse>,
    label: string
): FullStackConfiguredServiceProbe {
    if (probe.status === 'rejected') {
        return { kind: 'unavailable' };
    }
    return {
        kind: 'reachable',
        ok: probe.value.ok(),
        status: probe.value.status(),
        statusText: probe.value.statusText(),
        readJson: () => configuredReadinessJson(probe.value, label)
    };
}

function operatorUrl(
    input: OperatorUrlInput
): string {
    return `${FULL_STACK_SPA_ORIGIN}/?${
        new URLSearchParams({
            provider: 'browser-rallar',
            v: '1',
            experience: 'recipe-console',
            view: 'execute',
            recipeId: 'composite-evidence-recipe',
            controlUrl: CONFIGURED_POSTGRES.controlWsUrl,
            applicationId: CONFIGURED_POSTGRES.applicationId,
            workspaceId: CONFIGURED_POSTGRES.workspaceId,
            roomId: input.groupId,
            controlRunId: input.controlRunId,
            actor: CONFIGURED_POSTGRES.userC.actor,
            sessionId: input.sessionId
        }).toString()
    }`;
}

function hasCompletedCancelProof(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot
): boolean {
    const cancelLinks = distributedRun.commandLinks.filter(
        (link) => link.phase === 'cancel'
    );
    return distributedRun.state === 'cancelled' &&
        cancelLinks.length === distributedRun.targetAgentIds.length &&
        distributedRun.targetAgentIds.every((agentId) =>
            cancelLinks.filter((link) => link.agentId === agentId).length === 1
        ) &&
        cancelLinks.every((link) => {
            const command = controlRun.commands.find((candidate) => candidate.envelope.commandId === link.commandId);
            const result = controlRun.results.find((candidate) =>
                candidate.commandId === link.commandId &&
                candidate.agentId === link.agentId
            );
            return command?.envelope.command.kind === 'recipe.cancel' &&
                command.dispatchedAtEpochMs !== undefined &&
                command.completedAtEpochMs !== undefined &&
                result?.ok === true;
        });
}

async function configuredPostgresStackAvailability(
    request: APIRequestContext
): Promise<'ready' | 'unavailable'> {
    if (
        !CONFIGURED_POSTGRES.enabled ||
        !CONFIGURED_POSTGRES_MODE ||
        !CONFIGURED_FRESH_POSTGRES_API
    ) {
        return 'unavailable';
    }
    const [apiProbe, controlProbe] = await Promise.allSettled([
        request.get(`${CONFIGURED_POSTGRES.apiBaseUrl}/api/config`, {
            failOnStatusCode: false,
            headers: { origin: FULL_STACK_SPA_ORIGIN },
            timeout: 5_000
        }),
        request.get(`${CONFIGURED_POSTGRES.controlBaseUrl}/health`, {
            failOnStatusCode: false,
            timeout: 5_000
        })
    ]);
    return await evaluateFullStackConfiguredServiceEvidence({
        api: configuredServiceProbe(apiProbe, 'API configuration'),
        control: configuredServiceProbe(controlProbe, 'control health'),
        expectedApiBaseUrl: CONFIGURED_POSTGRES.apiBaseUrl
    });
}

async function configuredReadinessJson(
    response: APIResponse,
    label: string
): Promise<unknown> {
    try {
        return await response.json();
    }
    catch (cause) {
        throw new Error(`Configured ${label} returned malformed JSON.`, {
            cause
        });
    }
}

async function assertLiveExecuteTargets(
    page: Page,
    agentIds: readonly string[]
): Promise<void> {
    const recipe = page.locator(
        '[data-execute-recipe][data-recipe-id="composite-evidence-recipe"]'
    );
    await expect(recipe).toHaveAttribute('aria-selected', 'true');
    await expect(recipe).toContainText('simulated');
    await expect(recipe).toContainText('Self-contained');

    const targets = page.locator('[data-execute-targets]');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(
        agentIds.length,
        { timeout: 30_000 }
    );
    for (const agentId of agentIds) {
        await expect(targets).toContainText(agentId);
    }
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        agentIds.length
    );
}

async function launchBrowserAgentsThroughVisibleControls(
    page: Page,
    input: LaunchBrowserAgentsInput
): Promise<LaunchedBrowserAgents> {
    const setup = page.locator('[data-execute-agent-setup]');
    await expect(setup).toBeVisible();
    await expect(setup.getByLabel('Control run ID for new agents')).toHaveValue(
        input.controlRunId
    );
    await setup.getByLabel('Agent ID prefix').fill(input.prefix);
    await setup.getByLabel('Agent count').fill(String(input.count));

    const context = page.context();
    const existingPages = new Set(context.pages());
    try {
        await setup.getByRole('button', {
            name: `Open ${input.count} browser agents`
        }).click();
        await expect.poll(
            () => context.pages().filter((candidate) => !existingPages.has(candidate)).length,
            { timeout: 30_000 }
        ).toBe(input.count);
        const agentPages = context.pages().filter((candidate) => !existingPages.has(candidate));
        await Promise.all(
            agentPages.map((agentPage) =>
                agentPage.waitForURL((url) =>
                    url.searchParams.get('mode') === 'control' &&
                    url.searchParams.get('agentId')?.startsWith(`${input.prefix}-`) === true
                )
            )
        );

        const agentIds = readLaunchedAgentIds(agentPages, input);
        await expect(setup.getByRole('status')).toContainText(
            `${input.count} launched browser agents are ready and selected as targets.`,
            { timeout: 60_000 }
        );
        return { pages: agentPages, agentIds };
    }
    catch (error) {
        const acquired = context.pages().filter((candidate) => !existingPages.has(candidate));
        const cleanup = await Promise.allSettled(acquired.map((page) => page.close()));
        const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (failures.length > 0) {
            throw new AggregateError([error, ...failures], 'Visible agent acquisition and cleanup failed.', {
                cause: error
            });
        }
        throw error;
    }
}

async function createDraftThroughVisibleExecuteControls(
    page: Page
): Promise<string> {
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
    const distributedRunId = new URL(page.url()).searchParams.get(
        'distributedRunId'
    );
    expect(distributedRunId).toMatch(/^dist-/);
    if (!distributedRunId) {
        throw new Error('Created run URL omitted distributedRunId.');
    }
    return distributedRunId;
}

async function stageThroughVisibleExecuteControls(page: Page): Promise<void> {
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: /Stage \d+ agents/ })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'ready',
        { timeout: 60_000 }
    );
}

async function startThroughVisibleExecuteControls(page: Page): Promise<void> {
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: 'Review and start' }).click();
    await page.getByRole('dialog', { name: 'Start distributed run?' })
        .getByRole('button', { name: 'Start distributed run' }).click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'passed',
        { timeout: 90_000 }
    );
}

async function navigateToMonitor(
    page: Page,
    distributedRunId: string,
    state: ControlDistributedRunSnapshot['state']
): Promise<void> {
    if (state === 'ready') {
        await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    }
    else {
        await page.locator('[data-execute-action-runway]')
            .getByRole('button', { name: 'Monitor run' }).click();
    }
    await expect(page).toHaveURL(/(?:\?|&)view=monitor(?:&|$)/);
    await expect(page).toHaveURL(
        new RegExp(`(?:\\?|&)distributedRunId=${distributedRunId}(?:&|$)`)
    );
    await expect(
        page.locator('[data-monitor-section="verdict"]')
    ).toHaveAttribute('data-run-state', state, { timeout: 30_000 });
}

async function exportMonitorArtifact(
    page: Page,
    distributedRunId: string
): Promise<ControlDistributedRunArtifactBundle> {
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    const downloadPromise = page.waitForEvent('download');
    await actions.getByRole('button', { name: 'Export artifact' }).click();
    const download = await downloadPromise;
    expect(distributedRunId).toMatch(/^[a-z0-9-]+$/u);
    const expectedStem = distributedRunId.slice(0, 120).replace(/-+$/u, '');
    expect(download.suggestedFilename()).toBe(`${expectedStem}-artifact.json`);
    const downloadPath = await download.path();
    if (!downloadPath) {
        throw new Error('Artifact download path is unavailable.');
    }
    return decodeControlDistributedRunArtifactBundle(JSON.parse(await readFile(downloadPath, 'utf8'))).fold(
        (issue) => {
            throw new Error(`Invalid distributed artifact: ${issue}`);
        },
        (artifact) => artifact
    );
}

function assertSchemaV2Artifact(
    artifact: ControlDistributedRunArtifactBundle,
    input: ArtifactExpectation
): void {
    expect(JSON.stringify(artifact)).not.toMatch(
        /agentSessionTicket|controlToken|authorization:\s*bearer/iu
    );
    expect(artifact).toMatchObject({
        artifactSchemaVersion: 2,
        distributedRunId: input.distributedRunId,
        files: {
            'distributed-run.json': expect.any(String),
            'manifest.json': expect.any(String),
            'target-resolution.json': expect.any(String),
            'control-run.json': expect.any(String),
            'report.json': expect.any(String),
            'metadata.json': expect.any(String)
        }
    });
    const files = artifact.files;
    expect(JSON.parse(files['manifest.json'])).toMatchObject({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        group: { groupId: input.groupId },
        recipes: [{ recipeId: 'composite-evidence-recipe' }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: [...input.agentIds].sort(),
            expectedParticipantCount: input.agentIds.length
        }
    });
    expect(JSON.parse(files['distributed-run.json'])).toMatchObject({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'passed',
        targetAgentIds: [...input.agentIds].sort(),
        rollup: { state: 'passed', ok: true }
    });
    expect(JSON.parse(files['report.json'] ?? '{}')).toMatchObject({
        artifactSchemaVersion: 2,
        execution: 'distributed-run',
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'passed',
        ok: true
    });
    assertArtifactControlSessions(
        decodeControlRunSnapshot(JSON.parse(files['control-run.json'])).fold(
            (issue) => {
                throw new Error(`Invalid embedded control run: ${issue}`);
            },
            (snapshot) => snapshot
        ),
        input
    );
}

function assertArtifactControlSessions(controlRun: ControlRunSnapshot, input: ArtifactExpectation): void {
    expect(controlRun).toMatchObject({
        runId: input.controlRunId,
        agents: expect.arrayContaining(input.agentIds.map((agentId) =>
            expect.objectContaining({
                agentId,
                identity: expect.objectContaining({
                    groupId: input.groupId,
                    providerMode: 'browser-rallar'
                })
            })
        )),
        results: expect.arrayContaining([
            expect.objectContaining({ ok: true })
        ])
    });
    const launchedSessions = controlRun.agents
        .filter((agent) => input.agentIds.includes(agent.agentId))
        .map((agent) => agent.identity?.sessionId);
    expect(launchedSessions).toHaveLength(input.agentIds.length);
    expect(launchedSessions.every((sessionId) => Boolean(sessionId))).toBe(true);
    expect(new Set(launchedSessions).size).toBe(input.agentIds.length);
}

async function readDistributedRun(
    request: APIRequestContext,
    distributedRunId: string
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.get(
        `${CONFIGURED_POSTGRES.controlBaseUrl}/distributed-runs/${encodeURIComponent(distributedRunId)}`
    );
    expect(response.ok()).toBe(true);
    return decodeControlDistributedRunSnapshot(await response.json()).fold(
        (issue) => {
            throw new Error(`Invalid distributed run: ${issue}`);
        },
        (snapshot) => snapshot
    );
}

async function expectCompletedCancelProof(
    request: APIRequestContext,
    controlRunId: string,
    distributedRunId: string
): Promise<void> {
    await expect.poll(async () => {
        const [distributedRun, controlRun] = await Promise.all([
            readDistributedRun(request, distributedRunId),
            readControlRun(request, controlRunId)
        ]);
        return hasCompletedCancelProof(distributedRun, controlRun);
    }, { timeout: 30_000 }).toBe(true);

    const [distributedRun, controlRun] = await Promise.all([
        readDistributedRun(request, distributedRunId),
        readControlRun(request, controlRunId)
    ]);
    const cancelLinks = distributedRun.commandLinks.filter(
        (link) => link.phase === 'cancel'
    );
    expect(cancelLinks.map((link) => link.agentId).sort()).toEqual(
        [...distributedRun.targetAgentIds].sort()
    );
    for (const link of cancelLinks) {
        expect(controlRun.commands.find((candidate) => candidate.envelope.commandId === link.commandId)).toMatchObject({
            envelope: {
                agentId: link.agentId,
                commandId: link.commandId,
                command: { kind: 'recipe.cancel' }
            },
            dispatchedAtEpochMs: expect.any(Number),
            completedAtEpochMs: expect.any(Number)
        });
        expect(controlRun.results.find((candidate) =>
            candidate.commandId === link.commandId &&
            candidate.agentId === link.agentId
        )).toMatchObject({
            agentId: link.agentId,
            commandId: link.commandId,
            ok: true
        });
    }
}

function readLaunchedAgentIds(agentPages: readonly Page[], input: LaunchBrowserAgentsInput): readonly string[] {
    const agentIds = agentPages.map((agentPage) => {
        const url = new URL(agentPage.url());
        expect(url.hash).toBe('');
        expect(url.searchParams.get('provider')).toBe('browser-rallar');
        expect(url.searchParams.get('runId')).toBe(input.controlRunId);
        expect(url.searchParams.get('roomId')).toBe(input.groupId);
        expect(url.searchParams.get('apiBaseUrl')).toBe(
            CONFIGURED_POSTGRES.apiBaseUrl
        );
        expect(url.searchParams.get('sessionId')).toBeNull();
        return url.searchParams.get('agentId') ?? '';
    });
    expect(new Set(agentIds).size).toBe(input.count);
    return agentIds;
}
