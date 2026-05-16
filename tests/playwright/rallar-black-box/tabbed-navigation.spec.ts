import { expect, test } from '@playwright/test';

test('opens a tab from the URL and updates tab state in the address bar', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=rtc-diagnostics');

    await expect(page.getByRole('tab', { name: 'RTC Diagnostics' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('#panel-rtc-diagnostics')).toBeVisible();

    await page.getByRole('tab', { name: 'Rallar Server' }).click();

    await expect(page).toHaveURL(/tab=rallar-server/);
    await expect(page.locator('#panel-rallar-server')).toBeVisible();
});

test('keeps manual form and event filters mounted across tab changes', async ({ page }) => {
    await page.goto('/?provider=simulated&tab=manual-rallar');

    const manualPanel = page.locator('#panel-manual-rallar');
    const groupInput = manualPanel.getByLabel('Group');
    await groupInput.fill('tab-persist-room');
    await manualPanel.getByRole('button', { name: 'Health' }).click();
    await expect(manualPanel.getByText('manual-health-1')).toBeVisible();

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    const eventPanel = page.locator('#panel-event-stream');
    const messageFilter = eventPanel.getByRole('button', { name: 'message' });
    await messageFilter.click();
    await expect(messageFilter).toHaveClass(/selected/);
    await expect(eventPanel.locator('.focus-panel')).toContainText('manual-health-1');

    await page.getByRole('tab', { name: 'Local Workbench' }).click();
    const localWorkbenchPanel = page.locator('#panel-local-workbench');
    const fixtureSelect = localWorkbenchPanel.getByLabel('Fixture');
    await fixtureSelect.selectOption('provider-parity');

    await page.getByRole('tab', { name: 'Manual Rallar' }).click();

    await expect(groupInput).toHaveValue('tab-persist-room');

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    await expect(messageFilter).toHaveClass(/selected/);
    await expect(eventPanel.locator('.focus-panel')).toContainText('manual-health-1');

    await page.getByRole('tab', { name: 'Local Workbench' }).click();
    await expect(fixtureSelect).toHaveValue('provider-parity');
});

test('sends a Rallar Server REST request from the server tab', async ({ page }) => {
    await page.route('http://localhost:8080/api/config', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                apiBaseUrl: 'http://localhost:8080',
                wsBaseUrl: 'ws://localhost:8080',
                endpoints: {
                    createWs: '/api/auth/ws-ticket',
                },
            }),
        });
    });

    await page.goto(
        '/?provider=simulated&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080&tab=rallar-server',
    );

    const serverPanel = page.locator('#panel-rallar-server');
    await serverPanel.getByRole('button', { name: 'Send' }).click();

    await expect(serverPanel).toContainText('200 OK');
    await expect(serverPanel).toContainText('"apiBaseUrl": "http://localhost:8080"');
    await expect(serverPanel).toContainText('"kind": "http.request"');
});
