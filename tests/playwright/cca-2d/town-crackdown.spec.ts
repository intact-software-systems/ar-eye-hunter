import {
    expect,
    test,
    type Page
} from '@playwright/test';

async function walk(page: Page, destination: { axis: 'x' | 'z'; value: number; }): Promise<void> {
    const app = page.locator('#app');
    const current = Number(await app.getAttribute(`data-${destination.axis}`));
    const positive = destination.value > current;
    const key = destination.axis === 'x' ? (positive ? 'KeyD' : 'KeyA') : positive ? 'KeyW' : 'KeyS';
    await page.keyboard.down(key);
    await expect.poll(async () => {
        const position = Number(await app.getAttribute(`data-${destination.axis}`));
        return positive ? position >= destination.value - 0.12 : position <= destination.value + 0.12;
    }, { intervals: [30], timeout: 12000 }).toBe(true);
    await page.keyboard.up(key);
}

async function dashNorth(page: Page, incident: number): Promise<void> {
    await expect(page.getByRole('button', { name: 'Dash and drop' })).toHaveAttribute('aria-disabled', 'false');
    await page.keyboard.down('KeyW');
    await page.keyboard.press('Space');
    await expect.poll(async () => Number(await page.locator('#app').getAttribute('data-mischief')))
        .toBeGreaterThanOrEqual(incident);
    await page.keyboard.up('KeyW');
}

test('six real street messes award the bonus and deploy ten police, then the shift ends', async ({ page }) => {
    test.setTimeout(150000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
    const app = page.locator('#app');
    await walk(page, { axis: 'z', value: -3.8 });
    await walk(page, { axis: 'x', value: -3.5 });
    await dashNorth(page, 1);
    await walk(page, { axis: 'z', value: -4 });
    await walk(page, { axis: 'x', value: 0 });
    await walk(page, { axis: 'z', value: -8 });
    await walk(page, { axis: 'x', value: -5.5 });
    await dashNorth(page, 2);
    await walk(page, { axis: 'z', value: -8 });
    await walk(page, { axis: 'x', value: -3 });
    await dashNorth(page, 3);
    await walk(page, { axis: 'z', value: -8 });
    await walk(page, { axis: 'x', value: 5 });
    await walk(page, { axis: 'z', value: -6 });
    await dashNorth(page, 4);
    await walk(page, { axis: 'x', value: 7 });
    await walk(page, { axis: 'z', value: 0.5 });
    await walk(page, { axis: 'x', value: 5 });
    await dashNorth(page, 5);
    await walk(page, { axis: 'z', value: 0 });
    await walk(page, { axis: 'x', value: 2.5 });
    await walk(page, { axis: 'z', value: 6 });
    await walk(page, { axis: 'x', value: 0 });
    await dashNorth(page, 6);
    await expect(app).toHaveAttribute('data-fountain', 'true');
    await expect(app).toHaveAttribute('data-raid', 'alarm');
    await expect(app).toHaveAttribute('data-bonuses', '1');
    await expect(page.locator('#heat')).toHaveText('6/6');
    await expect(page.locator('#status')).toContainText('+50 MISCHIEF BONUS');
    await expect(app).toHaveAttribute('data-raid', 'active', { timeout: 7000 });
    await expect(app).toHaveAttribute('data-police', '10', { timeout: 4000 });
    await expect(app).toHaveAttribute('data-frozen', 'true', { timeout: 20000 });
    await expect(app).toHaveAttribute('data-frozen', 'false', { timeout: 8000 });
    await expect(app).toHaveAttribute('data-raid', 'returning', { timeout: 30000 });
    await expect(app).toHaveAttribute('data-police', '0', { timeout: 17000 });
    await expect(app).toHaveAttribute('data-bonuses', '1');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(app).toHaveAttribute('data-mischief', '0');
    await expect(app).toHaveAttribute('data-bonuses', '0');
    await expect(app).toHaveAttribute('data-stain', 'clean');
    expect(errors).toEqual([]);
});
