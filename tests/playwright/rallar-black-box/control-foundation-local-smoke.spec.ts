import { expect, test } from '@playwright/test';

test.skip(
    process.env.RALLAR_BLACK_BOX_LOCAL_CONTROL_SMOKE !== '1',
    'Set RALLAR_BLACK_BOX_LOCAL_CONTROL_SMOKE=1 with the standard local control process available at http://localhost:5180.'
);

test('connects Recipe Console to the standard local control process', async ({ page }) => {
    const snapshotResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === 'http://localhost:5180' &&
            url.pathname === '/runs' &&
            response.request().method() === 'GET';
    });
    await page.goto(
        '/?provider=simulated&v=1&experience=recipe-console&view=execute'
    );
    const response = await snapshotResponse;
    expect(response.status()).toBe(200);
    const requestUrl = new URL(response.url());
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
        limitCommands: '120',
        limitResults: '120',
        limitEvents: '160',
        limitStats: '60',
        limitReports: '40',
        limitHeartbeats: '80'
    });
    const payload = await response.json() as { runs?: unknown; };
    expect(Array.isArray(payload.runs)).toBe(true);
    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toHaveText('Live · reachable');
    await expect(page.getByRole('region', { name: 'Control overview' }))
        .toBeVisible();
});
