import { expect, test } from '@playwright/test';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    expectNoSecrets,
    loginUser,
    openTab,
    readExhaustivePostgresConfig,
    uniqueGroupId
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();

test.describe('exhaustive Quick Test and WebSocket command center', () => {
    test.skip(!config.enabled, config.skipReason);

    test('runs Quick Test create join subscribe send repeat and receive across browsers', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(180_000);
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await Promise.all([
                loginUser(pageA, config, config.userA, {
                    groupId,
                    sessionId: `${groupId}-alice-session`,
                    tab: 'quick-test'
                }),
                loginUser(pageB, config, config.userB, {
                    groupId,
                    sessionId: `${groupId}-bob-session`,
                    tab: 'quick-test'
                })
            ]);

            const quickA = pageA.getByLabel('Rallar Quick Test');
            const quickB = pageB.getByLabel('Rallar Quick Test');
            await expect(quickA.getByLabel('Quick Test workflow')).toContainText('Setup');
            await expect(quickA.getByLabel('Quick Test workflow')).toContainText('Subscribe');
            await expect(quickA.getByLabel('Quick Test workflow')).toContainText('Send');
            await expect(quickA.getByLabel('Quick Test workflow')).toContainText('Verify');
            await quickA.getByRole('textbox', { name: 'Group' }).fill(groupId);
            await quickA.getByLabel('Timeout', { exact: true }).fill('60000');
            await quickB.getByLabel('Timeout', { exact: true }).fill('60000');
            await quickA.getByRole('button', { name: 'Create and join group' }).click();
            await expect(quickA).toContainText(/completed|joined|created/i, { timeout: 75_000 });
            await expect(quickA.locator('.quick-workflow-step.done').filter({ hasText: 'Setup' }))
                .toBeVisible();

            await quickB.getByRole('textbox', { name: 'Group' }).fill(groupId);
            await quickB.getByRole('button', { name: 'Join group', exact: true }).click();
            await expect(quickB).toContainText(/completed|joined/i, { timeout: 75_000 });
            await quickB.getByRole('button', { name: 'Subscribe WS', exact: true }).click();
            await expect(quickB.getByLabel('Quick Test received messages')).toContainText('Listening', {
                timeout: 30_000
            });
            await expect(quickB.locator('.quick-workflow-step.done').filter({ hasText: 'Subscribe' }))
                .toBeVisible();

            for (const seq of [1, 2]) {
                const payload = {
                    kind: 'exhaustive-quick-ws',
                    groupId,
                    seq,
                    text: `quick-test-${seq}`
                };
                await quickA.getByLabel('Payload JSON').fill(JSON.stringify(payload, null, 2));
                await quickA.getByRole('button', { name: 'Send WS JSON' }).click();
                await expect(quickA.locator('.quick-workflow-step.done').filter({ hasText: 'Send' }))
                    .toBeVisible();
                await expect(quickB.getByLabel('Quick Test received messages')).toContainText(
                    `quick-test-${seq}`,
                    { timeout: 45_000 }
                );
            }

            await quickB.getByRole('button', { name: 'Wait for receive' }).click();
            await expect(quickB.locator('.quick-workflow-step.done').filter({ hasText: 'Verify' }))
                .toBeVisible();
            await quickA.getByRole('button', { name: 'Copy runner recipe' }).click();
            await quickB.getByRole('button', { name: 'Copy diagnostics' }).click();
            await expectNoSecrets(pageA.locator('body'), [config.userA.password]);
            await expectNoSecrets(pageB.locator('body'), [config.userB.password]);
        }
        finally {
            await Promise.all([
                cleanupRallarPage(pageA),
                cleanupRallarPage(pageB)
            ]);
            await Promise.all([
                contextA.close(),
                contextB.close()
            ]);
        }
    });

    test('opens authenticated API WebSocket, sends JSON, handles negative open, and closes', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-ws-session`,
                tab: 'websocket'
            });
            const panel = page.locator('#panel-websocket');

            await panel.getByLabel('Group', { exact: true }).fill(groupId);
            await panel.getByLabel('Payload JSON').fill(JSON.stringify(
                {
                    kind: 'exhaustive-websocket',
                    groupId
                },
                null,
                2
            ));

            await panel.getByRole('button', { name: 'Configure WS' }).click();
            await expect(panel).toContainText(/configured|Configure WS/i);

            await panel.getByRole('button', { name: 'Create WS ticket' }).click();
            await expect(panel).toContainText(/ticket|ws-ticket/i, { timeout: 30_000 });

            await panel.getByRole('button', { name: 'Open API WS' }).click();
            await expect(panel).toContainText(/open|opened|connected/i, { timeout: 30_000 });

            await panel.getByRole('button', { name: 'Send JSON' }).click();
            await expect(panel).toContainText(/sent|ws.send/i, { timeout: 30_000 });

            await panel.getByRole('button', { name: 'Wait for message' }).click();
            await panel.getByRole('button', { name: 'Reconnect' }).click();
            await panel.getByRole('button', { name: 'Close' }).click();

            await panel.getByRole('button', { name: 'Missing ticket open' }).click();
            await expect(panel).toContainText(/missing|ticket|failed/i, { timeout: 30_000 });
            await expectNoSecrets(panel, [config.userA.password]);

            await panel.getByRole('button', { name: /Copy.*recipe/i }).first().click();
        }
        finally {
            await cleanupRallarPage(page);
        }
    });
});
