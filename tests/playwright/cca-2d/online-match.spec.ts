import { expect, test, type Page } from '@playwright/test';

test.use({ actionTimeout: 10000 });

test('appointed director starts a shared round with two independently controlled players', async ({ browser }) => {
    test.setTimeout(90000);
    const first = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const second = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const third = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const charlie = await third.newPage();
    const alice = await first.newPage();
    const bob = await second.newPage();
    try {
        await registerPlayer(alice, `cca-host-${Date.now()}`);
        await registerPlayer(bob, `cca-peer-${Date.now()}`);
        await alice.getByRole('button', { name: 'Create town', exact: true }).click();
        await expect(alice.getByLabel('Room code')).toBeVisible();
        const roomCode = await alice.getByLabel('Room code').inputValue();
        await alice.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await alice.getByLabel('Friend username').pressSequentially('wasd-friend');
        await expect(alice.getByLabel('Friend username')).toHaveValue('wasd-friend');
        await bob.getByLabel('Town code').fill(roomCode);
        await bob.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(alice.locator('#roster li')).toHaveCount(2);
        await expect(bob.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await alice.getByRole('button', { name: 'Ready', exact: true }).click();
        await bob.getByRole('button', { name: 'Ready', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Start round', exact: true })).toBeEnabled();
        const startedAt = Date.now();
        await alice.getByRole('button', { name: 'Start round', exact: true }).click();
        await expect(alice.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 20000 });
        await expect(bob.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 20000 });
        expect(Date.now() - startedAt).toBeLessThan(8000);
        await expect(bob.getByLabel('Movement joystick')).toBeVisible();
        const initial = Number(await bob.locator('#online-game').getAttribute('data-x'));
        await bob.keyboard.down('KeyD');
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-x')))
            .toBeGreaterThan(initial + 1);
        await bob.keyboard.up('KeyD');
        await expect.poll(async () => Number(await alice.locator('#online-game').getAttribute('data-peer-x')))
            .toBeGreaterThan(initial + 1);
        await bob.getByRole('button', { name: 'Dash and drop', exact: true }).click();
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-dashes')))
            .toBeGreaterThan(0);
        await bob.screenshot({ path: test.info().outputPath('online-match-phone.png') });
        await bob.keyboard.down('KeyA');
        await bob.evaluate(() => window.dispatchEvent(new Event('blur')));
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-speed')))
            .toBeLessThan(0.1);
        await registerPlayer(charlie, `cca-late-${Date.now()}`);
        await charlie.getByLabel('Town code').fill(roomCode);
        await charlie.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(charlie.locator('#round-winners')).toContainText('roster changed');
        await charlie.getByRole('button', { name: 'Leave match', exact: true }).click();
        await expect(charlie.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
        await bob.getByRole('button', { name: 'Leave match', exact: true }).click();
        await expect(bob.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
        await expect(alice.locator('#round-winners')).toContainText('roster changed');
        await alice.getByRole('button', { name: 'New round', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Ready', exact: true })).toBeVisible();
    }
    finally {
        await Promise.allSettled([first.close(), second.close(), third.close()]);
    }
});

async function registerPlayer(page: Page, username: string): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('Local-trial-only-48!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'Create town', exact: true })).toBeVisible({ timeout: 15000 });
}

test('a lost prepared graphics context revokes readiness and leaves a usable exit', async ({ page }) => {
    await registerPlayer(page, `cca-context-${Date.now()}`);
    await page.getByRole('button', { name: 'Create town', exact: true }).click();
    await page.getByRole('button', { name: 'Host match', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Not ready', exact: true })).toBeVisible();
    await page.locator('#online-game canvas').evaluate((canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error('The match canvas is missing.');
        }
        const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!extension) {
            throw new Error('The test browser cannot inject WebGL context loss.');
        }
        extension.loseContext();
    });
    await expect(page.locator('#match-controls')).toContainText('Graphics context lost');
    await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Leave town', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
});
