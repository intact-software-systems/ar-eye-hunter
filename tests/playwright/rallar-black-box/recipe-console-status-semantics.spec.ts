import { expect, test } from '@playwright/test';

test('pairs every operational status with text and shape', async ({ page }) => {
    await page.goto('/test/fixtures/recipe-console-css-isolation.html?mode=recipe-console');
    const contracts = {
        running: { shape: 'notched-ring', part: 'notch', background: 'rgb(228, 245, 247)', foreground: 'rgb(6, 93, 107)', border: 'rgb(22, 128, 143)' },
        passed: { shape: 'check-circle', part: 'check', background: 'rgb(231, 245, 237)', foreground: 'rgb(20, 99, 63)', border: 'rgb(46, 129, 92)' },
        failed: { shape: 'x-octagon', part: 'x', background: 'rgb(252, 235, 237)', foreground: 'rgb(152, 31, 44)', border: 'rgb(195, 66, 79)' },
        warning: { shape: 'warning-triangle', part: 'mark', background: 'rgb(255, 242, 213)', foreground: 'rgb(119, 70, 0)', border: 'rgb(168, 102, 0)' },
        stale: { shape: 'clock', part: 'hands', background: 'rgb(238, 241, 244)', foreground: 'rgb(78, 89, 106)', border: 'rgb(112, 123, 140)' },
        partial: { shape: 'half-circle', part: 'fill', background: 'rgb(241, 235, 255)', foreground: 'rgb(89, 55, 154)', border: 'rgb(122, 85, 184)' },
        disabled: { shape: 'barred-square', part: 'bar', background: 'rgb(238, 241, 244)', foreground: 'rgb(97, 107, 121)', border: 'rgb(212, 217, 225)' },
    } as const;
    for (const [status, contract] of Object.entries(contracts)) {
        const mark = page.locator(`[data-status="${status}"]`);
        await expect(mark).toContainText(new RegExp(status, 'i'));
        await expect(mark.locator('[data-status-shape]')).toHaveCount(1);
        await expect(mark.locator('[data-status-shape]')).toHaveAttribute('data-shape', contract.shape);
        await expect(mark.locator(`[data-status-part="${contract.part}"]`)).toHaveCount(1);
        await expect(mark).toHaveCSS('background-color', contract.background);
        await expect(mark).toHaveCSS('color', contract.foreground);
        await expect(mark).toHaveCSS('border-top-color', contract.border);
    }
    await expect(page.locator('[data-status="failed"]')).toHaveCSS('border-left-width', '4px');
});

test('keeps empty stale and error states explicit without discarding evidence', async ({ page }) => {
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=analyze');
    const empty = page.locator('[data-state="empty"]');
    await expect(empty).toHaveAttribute('aria-live', 'polite');
    await expect(empty.getByRole('heading', { name: 'Seeded artifact readiness' }))
        .toBeVisible();
    await expect(page.getByText('Core bundle', { exact: true })).toBeVisible();
    await expect(page.getByText('Evidence bundle', { exact: true })).toBeVisible();
    await expect(page.getByText('Partial bundle', { exact: true })).toBeVisible();

    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=fleet');
    const error = page.locator('[data-state="error"]');
    await expect(error).toHaveAttribute('aria-live', 'assertive');
    await expect(error.getByRole('heading', {
        name: 'Fleet live data unavailable in offline preview',
    })).toBeVisible();
    await expect(error).toContainText('No control connection is available in offline preview.');

    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=monitor');
    await page.getByRole('button', { name: 'Simulate stale connection' }).click();
    await expect.soft(page.getByRole('button', {
        name: 'Return to seeded current state',
        exact: true,
    })).toBeVisible();
    await expect.soft(page.getByRole('button', {
        name: 'Restore live connection',
        exact: true,
    })).toHaveCount(0);
    const stale = page.locator('[data-state="stale"]');
    await expect(stale, 'Monitor should expose one semantic StaleState').toHaveCount(1);
    await expect(stale).toBeVisible();
    await expect(stale).toHaveAttribute('aria-live', 'polite');
    await expect(stale).toContainText('Stale · reconnecting');
    await expect(stale).toContainText('Last known evidence 12s ago');

    await expect(page.locator('[data-failure-key]')).toHaveCount(2);
    await expect(page.locator('[data-failure-key="seed-start-receiver"]'))
        .toContainText('SYNTHETIC_ASSERTION_FAILED');
    const matrix = page.getByRole('region', { name: 'Agent by phase matrix' });
    await expect(matrix.getByText('seed-agent-a', { exact: true })).toBeVisible();
    await expect(matrix.getByText('seed-agent-b', { exact: true })).toBeVisible();
});
