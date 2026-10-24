import { expect, test } from '@playwright/test';

test('deployed Quick Join reaches admission through visible sign-in and room controls', async ({ page }, testInfo) => {
    const username = process.env.RALLAR_ARENA_TEST_USERNAME;
    const password = process.env.RALLAR_ARENA_TEST_PASSWORD;
    if (!username || !password) {
        throw new Error(
            'Provide RALLAR_ARENA_TEST_USERNAME and RALLAR_ARENA_TEST_PASSWORD for a provisioned test account.'
        );
    }
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    const open = page.getByRole('button', { name: 'Ops', exact: true });
    if (await open.isVisible()) {
        await open.click();
    }
    const operations = page.getByRole('region', { name: 'Arena operations' });
    await operations.getByLabel('Username', { exact: true }).fill(username);
    await operations.getByLabel('Password', { exact: true }).fill(password);
    await operations.getByRole('button', { name: 'Enter Arena', exact: true }).click();
    const quickJoin = operations.getByRole('button', { name: 'Quick Join', exact: true });
    await expect(quickJoin).toBeVisible();
    const admission = page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().includes('/groups/quick-join/requests/')
    );
    await quickJoin.click();
    const response = await admission;
    expect(response.status(), 'The API used by the deployed SPA must serve Quick Join.').toBe(200);
    const result = await response.json();
    expect(['joined', 'unavailable']).toContain(result.status);
    await expect(operations.getByRole('status')).toHaveText(
        result.status === 'joined' ? 'Joined arena.' : 'No available arena. Try again or create one.'
    );
    if (result.status === 'joined') {
        await expect(operations.locator('.room-row.active')).toContainText(result.snapshot.group.displayName);
    }
    await expect(quickJoin).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('deployed-quick-join.png'), fullPage: true });
});
