import { expect, test } from '@playwright/test';

test('phone controls move, slide, drop once, zoom and resume without stuck movement', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    const app = page.locator('#app');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(app).toHaveAttribute('data-z', '-2.00');
    const joystick = await page.getByLabel('Movement joystick').boundingBox();
    expect(joystick).not.toBeNull();
    if (!joystick) {
        throw new Error('Movement joystick is missing');
    }
    expect(joystick.y).toBeGreaterThan(844 * 0.75);
    await page.mouse.move(joystick.x + joystick.width / 2, joystick.y + 12);
    await page.mouse.down();
    await expect(app).toHaveAttribute('data-slipping', 'true');
    await page.mouse.up();
    const releasedZ = Number(await app.getAttribute('data-z'));
    await expect.poll(async () => Number(await app.getAttribute('data-z'))).toBeGreaterThan(releasedZ + 0.2);
    await page.getByRole('button', { name: 'Dash and drop' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '1');
    // Cooldown is an observable rejection, not a queued second action.
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(app).toHaveAttribute('data-zoom', '15.00');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const pausedZ = await app.getAttribute('data-z');
    await page.keyboard.press('KeyW');
    await expect(app).toHaveAttribute('data-z', pausedZ ?? '');
    await page.getByRole('button', { name: 'Back to mischief' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '1');
    await expect(page.getByRole('button', { name: 'Dash and drop' })).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '1');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '0');
    await expect(app).toHaveAttribute('data-z', '-2.00');
    expect(errors).toEqual([]);
});

test('desktop keyboard moves and action remains reachable after tablet and landscape resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-x', '0.00');
    await page.keyboard.down('KeyD');
    await expect.poll(async () => Number(await app.getAttribute('data-x'))).toBeGreaterThan(1);
    await page.keyboard.up('KeyD');
    await page.keyboard.press('Space');
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '1');
    for (const viewport of [{ width: 820, height: 1180 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        const action = await page.getByRole('button', { name: 'Dash and drop' }).boundingBox();
        expect(action).not.toBeNull();
        if (!action) {
            throw new Error('Dash button is missing');
        }
        expect(action.width).toBeGreaterThanOrEqual(44);
        expect(action.y + action.height).toBeLessThanOrEqual(viewport.height);
        await page.getByRole('button', { name: 'Zoom in' }).click();
    }
    await expect(app).toHaveAttribute('data-zoom', '9.00');
});

test('two touch pointers can move and dash together, and a separate pinch zooms', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
    const stick = await page.getByLabel('Movement joystick').boundingBox();
    const dash = await page.getByRole('button', { name: 'Dash and drop' }).boundingBox();
    if (!stick || !dash) {
        throw new Error('Touch controls are missing');
    }
    const touch = await context.newCDPSession(page);
    const movement = { id: 1, x: stick.x + stick.width / 2, y: stick.y + 12 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [movement] });
    await expect.poll(async () => Number(await page.locator('#app').getAttribute('data-z'))).toBeGreaterThan(-1);
    await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [movement, { id: 2, x: dash.x + dash.width / 2, y: dash.y + dash.height / 2 }]
    });
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '1');
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ id: 3, x: 145, y: 240 }, { id: 4, x: 245, y: 240 }]
    });
    await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ id: 3, x: 120, y: 240 }, { id: 4, x: 270, y: 240 }]
    });
    await expect(page.locator('#app')).toHaveAttribute('data-zoom', '8.67');
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-z', '-2.00');
});

test('focused buttons keep native Space activation without triggering a prank', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
    await page.getByRole('button', { name: 'Pause', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Back to mischief' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to mischief' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '0');
});

test('dash spills a stall, its owner cleans while a neighbour watches, and reset restores town', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
    const app = page.locator('#app');
    await page.keyboard.down('KeyD');
    await expect.poll(async () => Number(await app.getAttribute('data-x')), { intervals: [30] }).toBeGreaterThan(4.7);
    await page.keyboard.up('KeyD');
    await page.keyboard.down('KeyW');
    await expect.poll(async () => Number(await app.getAttribute('data-z')), { intervals: [30] }).toBeGreaterThan(0.6);
    await page.keyboard.press('Space');
    await expect(app).toHaveAttribute('data-spills', '1');
    await expect(page.locator('#points')).toHaveText('10');
    await page.keyboard.up('KeyW');
    await expect(page.locator('#heat')).toHaveText('1/6');
    await expect.poll(async () => Number(await app.getAttribute('data-cleaned')), { timeout: 15000 }).toBeGreaterThan(
        0
    );
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(app).toHaveAttribute('data-spills', '0');
    await expect(app).toHaveAttribute('data-cleaned', '0');
});

test('powder can be collected in the larger town and used with the same action', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
    const app = page.locator('#app');
    await page.keyboard.down('KeyS');
    await expect.poll(async () => Number(await app.getAttribute('data-z')), { intervals: [30] }).toBeLessThan(-11.3);
    await page.keyboard.up('KeyS');
    await page.keyboard.down('KeyA');
    await expect(app).toHaveAttribute('data-power', 'powder');
    await page.keyboard.up('KeyA');
    await expect(page.locator('#power')).toContainText('POWDER LOADED');
    await page.getByRole('button', { name: 'Dash and drop' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-pranks', '1');
    await expect(app).toHaveAttribute('data-power', 'fart');
});

test('landscape pause keeps help and reset reachable without clipping', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const help = await page.locator('#pause-overlay > div').boundingBox();
    expect(help).not.toBeNull();
    if (!help) {
        throw new Error('Pause help is missing');
    }
    expect(help.y).toBeGreaterThanOrEqual(0);
    expect(help.y + help.height).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('fountain and parcel cart respond to the same dash action', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GRUMPY TOWN' })).toBeVisible();
    await expect(page.locator('#scene-loading')).toBeHidden();
    const app = page.locator('#app');
    await page.keyboard.down('KeyW');
    await expect.poll(async () => Number(await app.getAttribute('data-z')), { intervals: [30] }).toBeGreaterThan(5.5);
    await page.keyboard.press('Space');
    await expect(app).toHaveAttribute('data-fountain', 'true');
    await page.keyboard.up('KeyW');
    await expect(page.locator('#points')).toHaveText('10');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Start over' }).click();
    await page.keyboard.down('KeyS');
    await expect.poll(async () => Number(await app.getAttribute('data-z')), { intervals: [30] }).toBeLessThan(-8.1);
    await page.keyboard.up('KeyS');
    await page.keyboard.down('KeyA');
    await expect.poll(async () => Number(await app.getAttribute('data-x')), { intervals: [30] }).toBeLessThan(-2.85);
    await page.keyboard.up('KeyA');
    await page.keyboard.down('KeyW');
    await page.keyboard.press('Space');
    await expect(app).toHaveAttribute('data-cart', 'true');
    await page.keyboard.up('KeyW');
    await expect(page.locator('#points')).toHaveText('10');
});
