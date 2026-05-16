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
