import { expect, test } from '@playwright/test';

test('declares a successful same-origin document icon', async ({ page }) => {
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');

    const icon = page.locator('head link[rel~="icon"]');
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute('type', 'image/svg+xml');

    const href = await icon.getAttribute('href');
    expect(href).not.toBeNull();
    const iconUrl = new URL(href ?? '', page.url());
    expect(iconUrl.origin).toBe(new URL(page.url()).origin);
    expect(iconUrl.pathname).not.toBe('/favicon.ico');

    const response = await page.request.get(iconUrl.toString());
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/svg+xml');
    await expect(response.text()).resolves.toContain('<svg');
});
