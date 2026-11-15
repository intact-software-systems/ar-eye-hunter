import {
    expect,
    test,
    type Page
} from '@playwright/test';

async function openTown(page: Page): Promise<void> {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
}

async function walk(page: Page, destination: { axis: 'x' | 'z'; value: number; }): Promise<void> {
    const app = page.locator('#app');
    const current = Number(await app.getAttribute(`data-${destination.axis}`));
    const positive = destination.value > current;
    const key = destination.axis === 'x' ? positive ? 'KeyD' : 'KeyA' : positive ? 'KeyW' : 'KeyS';
    await page.keyboard.down(key);
    await expect.poll(async () => {
        const position = Number(await app.getAttribute(`data-${destination.axis}`));
        return positive ? position >= destination.value - 0.08 : position <= destination.value + 0.08;
    }, { intervals: [30], timeout: 15000 }).toBe(true);
    await page.keyboard.up(key);
}

async function dashNorth(page: Page): Promise<void> {
    const dash = page.getByRole('button', { name: 'Dash and drop' });
    await expect(dash).toHaveAttribute('aria-disabled', 'false');
    await page.keyboard.down('KeyW');
    await dash.tap();
}

test('a bomb pickup arms the existing touch button, warns, splats and fully resets', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openTown(page);
    await walk(page, { axis: 'z', value: -12 });
    await walk(page, { axis: 'x', value: 3 });
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-power', 'poop-bomb');
    await page.getByRole('button', { name: 'Dash and drop' }).tap();
    await expect(app).toHaveAttribute('data-spectacle-phase', 'warning');
    await expect(app).toHaveAttribute('data-bombs', '1', { timeout: 4000 });
    await expect(app).toHaveAttribute('data-stain', 'poop');
    await page.getByRole('button', { name: 'Pause', exact: true }).tap();
    await page.getByRole('button', { name: 'Start over' }).tap();
    await expect(app).toHaveAttribute('data-spectacle', 'none');
    await expect(app).toHaveAttribute('data-bombs', '0');
    await expect(app).toHaveAttribute('data-stain', 'clean');
    expect(errors).toEqual([]);
});

test('the barbecue dispatches firefighters who extinguish the fire and leave', async ({ page }) => {
    test.setTimeout(65000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openTown(page);
    await walk(page, { axis: 'z', value: -13.5 });
    await walk(page, { axis: 'x', value: -12 });
    await walk(page, { axis: 'z', value: -10.5 });
    await walk(page, { axis: 'x', value: -14 });
    await dashNorth(page);
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-spectacle', 'fire');
    await page.keyboard.up('KeyW');
    await expect(app).toHaveAttribute('data-firefighters', '2');
    await expect(app).toHaveAttribute('data-spectacle-phase', 'cleanup', { timeout: 25000 });
    await expect(app).toHaveAttribute('data-spectacle', 'none', { timeout: 20000 });
    await expect(app).toHaveAttribute('data-firefighters', '0');
    await expect(app).toHaveAttribute('data-fires', '1');
    expect(errors).toEqual([]);
});

test('the café sample tray triggers a warned, finite vomit scene', async ({ page }) => {
    test.setTimeout(45000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openTown(page);
    await walk(page, { axis: 'z', value: -13.5 });
    await walk(page, { axis: 'x', value: -12 });
    await walk(page, { axis: 'z', value: -3.5 });
    await dashNorth(page);
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-spectacle', 'vomit');
    await page.keyboard.up('KeyW');
    await expect(app).toHaveAttribute('data-spectacle-phase', 'active', { timeout: 4000 });
    await expect(app).toHaveAttribute('data-dinners', '1');
    await expect(app).toHaveAttribute('data-spectacle', 'none', { timeout: 16000 });
    expect(errors).toEqual([]);
});
