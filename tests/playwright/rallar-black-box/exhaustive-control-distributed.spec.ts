import { expect, test } from '@playwright/test';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    exportControlRunArtifacts,
    fetchControlRun,
    openBrowserControlAgent,
    readExhaustivePostgresConfig,
    resolveDistributedTargets,
    selectControlRunInManager,
    uniqueGroupId,
    uniqueRunId,
    waitForControlRunAgent
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();

test.describe('exhaustive control server and distributed recipes', () => {
    test.skip(!config.enabled, config.skipReason);

    test('registers browser agents, enqueues commands, exports artifacts, and runs distributed recipes', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(240_000);
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);
        const runId = uniqueRunId(testInfo);
        const agentAId = `${runId}-agent-a`;
        const agentBId = `${runId}-agent-b`;
        const agentCId = `${runId}-agent-c`;

        const agents = await Promise.all([
            openBrowserControlAgent(browser, config, config.userA, {
                runId,
                agentId: agentAId,
                groupId
            }),
            openBrowserControlAgent(browser, config, config.userB, {
                runId,
                agentId: agentBId,
                groupId
            }),
            openBrowserControlAgent(browser, config, config.userC, {
                runId,
                agentId: agentCId,
                groupId
            })
        ]);

        try {
            await Promise.all([
                waitForControlRunAgent(request, runId, agentAId),
                waitForControlRunAgent(request, runId, agentBId),
                waitForControlRunAgent(request, runId, agentCId)
            ]);

            const runManager = await selectControlRunInManager(agents[0].page, runId);
            await expect(runManager).toContainText(agentAId);
            await expect(runManager).toContainText(agentBId);
            await expect(runManager).toContainText(agentCId);

            await runManager.getByRole('button', { name: 'Health' }).click();
            await runManager.getByRole('button', { name: 'Enqueue Selected' }).click();
            await expect.poll(async () => {
                const run = await fetchControlRun(request, runId);
                return run.results?.length ?? 0;
            }, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
            await expect(runManager).toContainText(/health|Results/i);

            await runManager.getByRole('button', { name: 'Stats' }).click();
            await runManager.getByRole('button', { name: 'Enqueue Selected' }).click();
            await expect.poll(async () => {
                const run = await fetchControlRun(request, runId);
                return run.stats?.length ?? 0;
            }, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

            await openTab(agents[0].page, 'recipes', 'black-box-runner');
            const recipes = agents[0].page.locator('#panel-recipes');
            await recipes.getByLabel('Search Recipes').fill('composite');
            await recipes.getByRole('button', { name: /Composite Evidence/ }).first().click();
            await recipes.getByRole('button', { name: 'Refresh' }).click();
            await expect(recipes.getByLabel('Runner Readiness')).toContainText(
                /Control server reachable|Ready to run recipes|Ready to run in this browser/,
                { timeout: 30_000 }
            );
            await expect(recipes).toContainText(runId, { timeout: 30_000 });
            await expect(recipes).toContainText(/Targetable Agents|targetable/i, {
                timeout: 30_000
            });
            const guidedDistributedButton = recipes
                .getByRole('button', { name: 'Run on connected agents' })
                .first();
            await expect(guidedDistributedButton).toBeEnabled({ timeout: 30_000 });
            await guidedDistributedButton.click();
            await expect(recipes.locator('.runner-launch-result')).toContainText(
                /Started|passed|running/i,
                { timeout: 60_000 }
            );
            await expect(recipes).toContainText(/Distributed run|Targets|Blocking failures/i, {
                timeout: 30_000
            });

            await openTab(agents[0].page, 'fleet', 'black-box-runner');
            const fleet = agents[0].page.locator('#panel-fleet');
            await expect(fleet).toContainText(/Live Fleet|Live Fleet Agents/i, {
                timeout: 30_000
            });
            await expect(fleet).toContainText(agentAId, { timeout: 30_000 });
            await expect(fleet).toContainText(/targetable|active runs|no active run|running|passed/i);
            await expect(fleet).toContainText(/Agent x Run Heatmap|No terminal distributed run reports/i);

            await openTab(agents[0].page, 'run-manager', 'black-box-runner');
            await runManager.getByRole('button', { name: 'Load Artifact' }).click();
            await expect(runManager).toContainText(/valid|Artifacts|report/i, { timeout: 30_000 });
            const artifacts = await exportControlRunArtifacts(request, runId);
            expect(JSON.stringify(artifacts)).toContain('report.json');

            const distributed = await resolveDistributedTargets(agents[0].page, runId);
            await expect(distributed).toContainText(agentAId);
            await expect(distributed).toContainText(agentBId);
            await expect(distributed).toContainText(agentCId);
            await distributed.getByLabel('Target Policy').selectOption('selected-agents');
            await distributed.getByLabel('Barrier').selectOption('enabled');
            await distributed.getByLabel('Start Mode').selectOption('manual');
            await distributed.getByRole('button', { name: 'Stage' }).click();
            await expect(distributed).toContainText(/staged|ready|ACK/i, { timeout: 60_000 });
            await distributed.getByRole('button', { name: 'Start' }).click();
            await expect(distributed).toContainText(/started|completed|Monitor|Lifecycle/i, {
                timeout: 90_000
            });
            await expect(distributed).toContainText(/Composite Drilldowns|Runtime Diagnostics|Historical Runs/i);
            await openTab(agents[0].page, 'runs', 'black-box-runner');
            const runs = agents[0].page.locator('#panel-runs');
            await expect(runs).toContainText(/Run Participants|Distributed Analysis/i, {
                timeout: 30_000
            });
            await expect(runs).toContainText(agentAId, { timeout: 30_000 });
            await openTab(agents[0].page, 'distributed-recipes', 'black-box-runner');
            await distributed.getByRole('button', { name: 'Export artifact' }).click();
            await expect(distributed).toContainText(/Artifact|Files|schema/i, { timeout: 60_000 });
            await distributed.getByRole('button', { name: 'Copy artifact' }).click();

            await distributed.locator('.distributed-history-panel')
                .getByPlaceholder('run, group, recipe, failure')
                .fill(groupId);
            await expect(distributed).toContainText(/Compare Runs|Historical Runs/i);
            await distributed.getByRole('button', { name: 'Cancel' }).click();

            await selectControlRunInManager(agents[0].page, runId);
            await runManager.getByRole('button', { name: 'Reset Run' }).click();
            await expect(runManager).toContainText(/Reset|No commands|Runs/i, { timeout: 30_000 });
            await runManager.getByRole('button', { name: 'Delete Run' }).click();
            await expect(runManager).toContainText(/Deleted|No runs|Runs/i, { timeout: 30_000 });
        }
        finally {
            await Promise.all(agents.map((agent) => cleanupRallarPage(agent.page)));
            await Promise.all(agents.map((agent) => agent.context.close()));
        }
    });
});
