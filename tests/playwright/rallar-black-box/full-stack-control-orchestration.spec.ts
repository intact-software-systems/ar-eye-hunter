import { expect, test } from '@playwright/test';
import {
    enqueueControlCommand,
    fetchControlRun,
    FULL_STACK_CONTROL_WS_URL,
    readFullStackConfig,
    uniqueSuffix,
    waitForControlCommandOk
} from './full-stack-helpers.ts';

const config = readFullStackConfig();

test.describe('full-stack control orchestration', () => {
    test.skip(!config.enabled, config.skipReason);

    test('registers a browser agent, executes a command, and stores telemetry', async ({ page, request }) => {
        const suffix = uniqueSuffix();
        const runId = `full-stack-control-${suffix}`;
        const agentId = `full-stack-agent-${suffix}`;
        const commandId = `full-stack-stats-${suffix}`;
        const query = new URLSearchParams({
            mode: 'control',
            provider: 'simulated',
            controlUrl: FULL_STACK_CONTROL_WS_URL,
            runId,
            agentId,
            apiBaseUrl: config.apiBaseUrl,
            roomId: config.roomId,
            actor: config.userA.actor,
            sessionId: `${config.userA.actor}-control-${suffix}`,
            tab: 'local-workbench'
        });

        await page.goto(`/?${query.toString()}`);
        await expect(page.locator('#panel-local-workbench .control-panel'))
            .toContainText('registered');

        await enqueueControlCommand(request, runId, agentId, commandId, {
            kind: 'stats',
            commandId
        });
        await waitForControlCommandOk(request, runId, commandId);

        const run = await fetchControlRun(request, runId);
        expect(run.results?.some((result) => result.commandId === commandId && result.ok === true)).toBe(true);
        expect((run.events ?? []).length).toBeGreaterThan(0);
        const artifactResponse = await request.get(
            `http://127.0.0.1:5180/runs/${encodeURIComponent(runId)}/artifacts`
        );
        expect(artifactResponse.ok()).toBe(true);
        const artifact = await artifactResponse.json() as {
            files?: Record<string, string>;
        };
        expect(artifact.files?.['report.json']).toContain(commandId);
        expect(artifact.files?.['events.jsonl']).toContain('step-result');
        await page.getByRole('tab', { name: 'Event Stream' }).click();
        await expect(page.locator('#panel-event-stream')).toContainText(commandId);
    });
});
