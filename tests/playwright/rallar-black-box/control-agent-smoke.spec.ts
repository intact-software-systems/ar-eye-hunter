import { expect, test } from '@playwright/test';

const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

test('SPA auto-connects as a control agent and returns command results', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `smoke-run-${suffix}`;
    const agentId = `smoke-agent-${suffix}`;
    const commandId = `smoke-stats-${suffix}`;

    await page.goto(
        `/?mode=control&provider=simulated&tab=local-workbench&controlUrl=${encodeURIComponent(CONTROL_WS_URL)}` +
            `&runId=${encodeURIComponent(runId)}` +
            `&agentId=${encodeURIComponent(agentId)}`
    );

    await expect(page.locator('#panel-local-workbench .control-panel'))
        .toContainText('registered');

    const response = await request.post(
        `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/commands`,
        {
            data: {
                commandId,
                command: {
                    kind: 'stats'
                }
            }
        }
    );
    expect(response.status()).toBe(202);

    await expect.poll(async () => {
        const runResponse = await request.get(
            `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`
        );
        const run = await runResponse.json();
        return run.results?.some((result: { commandId?: string; ok?: boolean; }) =>
            result.commandId === commandId && result.ok === true
        ) ?? false;
    }).toBe(true);

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    await expect(page.locator('#panel-event-stream').getByText(commandId).first()).toBeVisible();
});
