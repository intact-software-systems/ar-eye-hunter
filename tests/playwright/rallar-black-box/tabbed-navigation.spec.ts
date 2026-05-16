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

test('restores selected tab and redacted UI drafts after a fresh load', async ({ page }) => {
    await page.goto('/?provider=simulated');

    await page.getByRole('tab', { name: 'Rallar Server' }).click();
    const serverPanel = page.locator('#panel-rallar-server');
    await serverPanel.getByLabel('Method').selectOption('POST');
    await serverPanel.getByLabel('Path').fill('/api/private');
    await serverPanel.getByLabel('Headers JSON').fill(JSON.stringify({
        authorization: 'Bearer header-secret',
    }));
    await serverPanel.getByLabel('Body JSON').fill(JSON.stringify({
        password: 'body-secret',
    }));

    await page.getByRole('tab', { name: 'Manual Rallar' }).click();
    const manualPanel = page.locator('#panel-manual-rallar');
    await manualPanel.getByLabel('Group').fill('persisted-ui-room');
    await manualPanel.getByLabel('Payload JSON').fill(JSON.stringify({
        token: 'payload-secret',
        kind: 'probe',
    }));

    await page.getByRole('tab', { name: 'Event Stream' }).click();
    await page.locator('#panel-event-stream').getByRole('button', { name: 'message' }).click();

    await page.goto('/?provider=simulated');

    await expect(page.getByRole('tab', { name: 'Event Stream' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('#panel-event-stream').getByRole('button', { name: 'message' }))
        .toHaveClass(/selected/);

    await page.getByRole('tab', { name: 'Manual Rallar' }).click();
    await expect(manualPanel.getByLabel('Group')).toHaveValue('persisted-ui-room');
    await expect(manualPanel.getByLabel('Payload JSON')).toHaveValue(/<redacted>/);

    await page.getByRole('tab', { name: 'Rallar Server' }).click();
    await expect(serverPanel.getByLabel('Path')).toHaveValue('/api/private');
    await expect(serverPanel.getByLabel('Headers JSON')).toHaveValue(/<redacted>/);
    await expect(serverPanel.getByLabel('Body JSON')).toHaveValue(/<redacted>/);

    const storedValues = await page.evaluate(() => {
        const values: Record<string, string> = {};
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key) {
                values[key] = localStorage.getItem(key) ?? '';
            }
        }
        return values;
    });
    const serializedStorage = JSON.stringify(storedValues);
    expect(serializedStorage).not.toContain('header-secret');
    expect(serializedStorage).not.toContain('body-secret');
    expect(serializedStorage).not.toContain('payload-secret');
});
