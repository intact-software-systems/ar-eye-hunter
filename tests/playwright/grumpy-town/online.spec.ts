import { expect, test, type Page } from '@playwright/test';

test('online entry explains an insecure connection and keeps solo available', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await expect(page.getByRole('alert')).toContainText('trusted HTTPS connection');
    await page.getByRole('link', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
});

test('online entry explains a missing browser crypto API before loading Rallar', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await expect(page.getByRole('alert')).toContainText('Update your browser');
    await page.getByRole('link', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
});

test('a signed-out visitor can open and reopen online play without a startup error', async ({ page }) => {
    await page.goto('/');
    for (let visit = 0; visit < 2; visit += 1) {
        await page.getByRole('button', { name: 'Play with friends' }).click();
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
        await expect(page.locator('#connection')).toHaveText('Solo needs no account. Sign in here to play together.');
        await expect(page.locator('#online-error')).toBeEmpty();
        await page.getByRole('button', { name: 'Back to solo' }).click();
        await expect(page.getByLabel('Movement joystick')).toBeVisible();
    }
});

test('short passwords support registration and sign-in before creating a real Rallar room', async ({ page }) => {
    const username = `grumpy-town-${Date.now()}`;
    await page.goto('/');
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'Create town' })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create town' })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Create town' }).click();
    await expect(page.getByRole('heading', { name: 'Your town lobby' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel('Room code')).not.toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('online-lobby-phone.png'), fullPage: true });
    await page.getByRole('button', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
});

test('friends consent, room invitation and matchmaking work between separate accounts', async ({ browser }) => {
    test.setTimeout(90000);
    const first = await browser.newContext();
    const second = await browser.newContext();
    const alice = await first.newPage();
    const bob = await second.newPage();
    const suffix = Date.now();
    const aliceName = `grumpy-town-a-${suffix}`;
    const bobName = `grumpy-town-b-${suffix}`;
    try {
        await registerPlayer(alice, aliceName);
        await registerPlayer(bob, bobName);
        await inviteFriend(alice, bob, bobName);
        const firstTown = await alice.getByLabel('Room code').inputValue();
        await alice.getByRole('button', { name: 'Leave town' }).click();
        await expect(alice.getByRole('button', { name: 'Create town' })).toBeVisible();
        await expect(alice.locator('#online-error')).toBeEmpty();
        await expect(bob.locator('#roster')).toContainText(bobName + ' · here · room owner');
        await expect(bob.locator('#roster li')).toHaveCount(1);
        await bob.getByRole('button', { name: 'Leave town' }).click();
        await expect(bob.getByRole('button', { name: 'Create town' })).toBeVisible();
        await expect(bob.locator('#online-error')).toBeEmpty();
        await loseMutationReplies(alice, /\/api\/matchmaking(?:\/|$)/);
        await alice.getByRole('button', { name: 'Find players', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Retry matchmaking action' })).toBeVisible({ timeout: 20000 });
        await alice.unroute(/\/api\/matchmaking(?:\/|$)/);
        await alice.getByRole('button', { name: 'Retry matchmaking action' }).click();
        await expect(alice.getByRole('button', { name: 'Retry matchmaking action' })).toHaveCount(0);
        await bob.getByRole('button', { name: 'Find players', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Confirm match' })).toBeVisible({ timeout: 15000 });
        await alice.getByRole('button', { name: 'Confirm match' }).click();
        await bob.getByRole('button', { name: 'Confirm match' }).click();
        await alice.getByRole('button', { name: 'Enter matched town' }).click();
        await bob.getByRole('button', { name: 'Enter matched town' }).click();
        await expect(alice.getByLabel('Room code')).not.toHaveValue(firstTown);
        await expect(bob.getByLabel('Room code')).not.toHaveValue(firstTown);
        await expect(bob.getByLabel('Room code')).toHaveValue(await alice.getByLabel('Room code').inputValue());
        await expect(alice.locator('#roster')).toContainText(bobName);
        await bob.getByRole('button', { name: 'Block', exact: true }).click();
        await expect(bob.locator('.friend')).toContainText('blocked');
        await expect(alice.locator('.friend')).toHaveCount(0);
    }
    finally {
        await first.close();
        await second.close();
    }
});

async function inviteFriend(alice: Page, bob: Page, bobName: string): Promise<void> {
    await loseMutationReplies(alice, /\/api\/friends(?:\/|$)/);
    await alice.getByLabel('Friend username').fill(bobName);
    await alice.getByRole('button', { name: 'Send friend request' }).click();
    await expect(alice.getByRole('button', { name: 'Retry friend action' })).toBeVisible({ timeout: 20000 });
    await alice.unroute(/\/api\/friends(?:\/|$)/);
    await alice.getByRole('button', { name: 'Retry friend action' }).click();
    await expect(alice.getByRole('button', { name: 'Retry friend action' })).toHaveCount(0);
    await expect(bob.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 10000 });
    await bob.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(alice.locator('.friend')).toContainText('friend ·');
    await alice.getByRole('button', { name: 'Create town' }).click();
    await alice.getByRole('button', { name: 'Invite to town' }).click();
    await expect(bob.getByRole('button', { name: 'Open invitation' })).toBeVisible({ timeout: 10000 });
    await bob.getByRole('button', { name: 'Open invitation' }).click();
    await expect(bob.getByLabel('Room code')).toHaveValue(await alice.getByLabel('Room code').inputValue());
    await expect(alice.locator('#roster')).toContainText(bobName);
}

async function registerPlayer(page: Page, username: string): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('Local-trial-only-48!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'Create town' })).toBeVisible({ timeout: 15000 });
}

async function loseMutationReplies(page: Page, pattern: RegExp): Promise<void> {
    await page.route(pattern, async (route) => {
        if (route.request().method() !== 'POST') {
            await route.continue();
            return;
        }
        await route.fetch();
        await route.abort();
    });
}

test('solo works without API access and a cancelled search survives account reconnect', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/**', (route) => {
        requests.push(route.request().url());
        return route.abort();
    });
    await page.goto('/');
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
    await page.keyboard.down('KeyD');
    await expect.poll(async () => Number(await page.locator('#app').getAttribute('data-x'))).toBeGreaterThan(1);
    await page.keyboard.up('KeyD');
    expect(requests).toEqual([]);
    await page.unroute('**/api/**');
    const username = `grumpy-town-cancel-${Date.now()}`;
    await registerPlayer(page, username);
    await page.getByRole('button', { name: 'Find players', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel search' }).click();
    await expect(page.getByRole('button', { name: 'Find players', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('Local-trial-only-48!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Find players', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel search' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Find players', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel search' })).toBeEnabled();
    await page.getByRole('button', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await expect(page.getByRole('button', { name: 'Find players', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel search' })).toHaveCount(0);
});

test('returning to solo stays immediate while a committed search reply is delayed', async ({ page }) => {
    const responseReady = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const pattern = /\/api\/matchmaking(?:\/|$)/;
    await registerPlayer(page, `grumpy-town-delayed-${Date.now()}`);
    await page.route(pattern, async (route) => {
        if (route.request().method() !== 'POST') {
            await route.continue();
            return;
        }
        const action = route.request().postDataJSON().action;
        const response = await route.fetch();
        if (action === 'start') {
            responseReady.resolve();
            await releaseResponse.promise;
        }
        await route.fulfill({ response });
        if (action === 'cancel') {
            cancelled.resolve();
        }
    });
    try {
        await page.getByRole('button', { name: 'Find players', exact: true }).click();
        await responseReady.promise;
        await page.getByRole('button', { name: 'Back to solo' }).click();
        await expect(page.getByLabel('Movement joystick')).toBeVisible({ timeout: 3000 });
        releaseResponse.resolve();
        await cancelled.promise;
        await page.getByRole('button', { name: 'Play with friends' }).click();
        await expect(page.getByRole('button', { name: 'Find players', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Cancel search' })).toHaveCount(0);
    }
    finally {
        releaseResponse.resolve();
        await page.unroute(pattern);
    }
});

test('leaving online recovers a missing matchmaking view before cancelling the search', async ({ page }) => {
    const pattern = /\/api\/matchmaking(?:\/|$)/;
    await registerPlayer(page, `grumpy-town-read-failure-${Date.now()}`);
    await page.getByRole('button', { name: 'Find players', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel search' })).toBeEnabled();
    await page.route(pattern, (route) => route.request().method() === 'GET' ? route.abort() : route.continue());
    await page.getByRole('button', { name: 'Refresh matchmaking' }).click();
    await expect(page.locator('#matchmaking-panel [role="alert"]')).not.toBeEmpty();
    await page.unroute(pattern);
    await page.getByRole('button', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await expect(page.getByRole('button', { name: 'Find players', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel search' })).toHaveCount(0);
});
