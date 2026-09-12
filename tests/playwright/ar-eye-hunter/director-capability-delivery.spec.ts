import { expect, test } from '@playwright/test';

test('authenticated arena diagnostics observe capability transport evidence', async ({ page }, testInfo) => {
    test.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture on port 8080.');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    const operations = page.getByRole('region', { name: 'Arena operations' });
    const openOperations = page.getByRole('button', { name: 'Ops', exact: true });
    if (await openOperations.isVisible()) {
        await openOperations.click();
    }
    await operations.getByLabel('Username', { exact: true }).fill('alice');
    await operations.getByLabel('Password', { exact: true }).fill('secret');
    await operations.getByRole('button', { name: 'Enter Arena', exact: true }).click();
    const createArena = operations.getByRole('button', { name: 'New Arena', exact: true });
    await expect(createArena).toBeVisible();
    const appointmentResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().includes('/director/appoint/requests/')
    );
    await createArena.click();
    expect((await appointmentResponse).status()).toBe(200);
    await expect(operations.locator('.attempt-note')).toContainText('succeeded');
    const closeOperations = page.getByRole('button', { name: 'Close Ops', exact: true });
    if (await closeOperations.isVisible()) {
        await closeOperations.click();
    }
    await page.getByRole('button', { name: 'Diag', exact: true }).click();
    const diagnostics = page.getByRole('complementary', { name: 'Arena diagnostics' });
    const retryResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().includes('/director/appoint/requests/')
    );
    await diagnostics.getByRole('button', { name: 'Retry appoint', exact: true }).click();
    expect((await retryResponse).status()).toBe(200);
    const attempt = diagnostics.locator('.diagnostics-row').filter({ has: page.getByText('Attempt', { exact: true }) });
    await expect(attempt).toContainText('manual succeeded');
    const delivery = diagnostics.locator('.diagnostics-row').filter({
        has: page.getByText('Capability delivery', { exact: true })
    });
    await expect(delivery).toContainText('transport accepted (hop)');
    await page.screenshot({ path: testInfo.outputPath('capability-delivery.png'), fullPage: true });
    await diagnostics.getByText('JSON', { exact: true }).click();
    const observation = JSON.parse(await diagnostics.locator('pre').innerText());
    expect(observation.directorAttempt).toMatchObject({
        source: 'manual',
        status: 'succeeded',
        capabilityDelivery: { state: 'confirmed', evidence: 'transport-accepted' }
    });
    expect(observation.transport.ws.readyState).toBe('open');
    expect(errors).toEqual([]);
    await diagnostics.getByText('JSON', { exact: true }).click();
});

test('copies the displayed diagnostics JSON and resets the copy state when reopened', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await page.getByRole('button', { name: 'Diag', exact: true }).click();
    const diagnostics = page.getByRole('complementary', { name: 'Arena diagnostics' });
    await diagnostics.getByText('JSON', { exact: true }).click();
    const displayed = JSON.parse(await diagnostics.locator('pre').innerText());
    await diagnostics.getByRole('button', { name: 'Copy JSON', exact: true }).click();
    await expect(diagnostics.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(copied)).toEqual(displayed);
    await diagnostics.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Diag', exact: true }).click();
    await diagnostics.getByText('JSON', { exact: true }).click();
    await expect(diagnostics.getByRole('button', { name: 'Copy JSON', exact: true })).toBeVisible();
});
