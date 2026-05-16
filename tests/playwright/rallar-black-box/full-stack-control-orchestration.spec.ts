import { expect, test } from '@playwright/test';
import {
    FULL_STACK_CONTROL_WS_URL,
    enqueueControlCommand,
    fetchControlRun,
    readFullStackConfig,
    uniqueSuffix,
    waitForControlCommandOk,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();

test.describe('full-stack control orchestration', () => {
    test.skip(!config.enabled, config.skipReason);

    test('registers a browser agent, executes a command, and stores telemetry', async ({
        page,
        request,
    }) => {
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
            tab: 'local-workbench',
        });

        await page.goto(`/?${query.toString()}`);
        await expect(page.locator('.control-panel')).toContainText('registered');

        await enqueueControlCommand(request, runId, agentId, commandId, {
            kind: 'stats',
            commandId,
        });
        await waitForControlCommandOk(request, runId, commandId);

        const run = await fetchControlRun(request, runId);
        expect(run.results?.some(result => result.commandId === commandId && result.ok === true)).toBe(true);
        expect((run.events ?? []).length).toBeGreaterThan(0);
        await expect(page.getByText(commandId).first()).toBeVisible();
    });
});
