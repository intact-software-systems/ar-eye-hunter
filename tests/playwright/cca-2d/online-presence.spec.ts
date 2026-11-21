import { expect, test } from '@playwright/test';

import {
    decodeMatchWire,
    registerPlayer,
    startTownMatch
} from './match-browser.ts';

test('a foreground host keeps the same round after two client heartbeat timeouts', async ({ browser }) => {
    test.setTimeout(60000);
    const alice = await browser.newPage();
    const bob = await browser.newPage();
    const held: (() => void)[] = [];
    let timeouts = 0;
    try {
        await startTownMatch([alice, bob]);
        const matchId = await alice.locator('#online-game').getAttribute('data-match-id');
        alice.on('console', (message) => {
            if (/State heartbeat failed.*(?:TimedOut|timed out)/i.test(message.text())) {
                timeouts++;
            }
        });
        await alice.route(/\/clients\/[^/]+\/instances\/[^/]+\/sessions\/[^/]+\/heartbeat\b/, async (route) => {
            if (held.length < 2) {
                await new Promise<void>((resolve) => held.push(resolve));
                await route.abort();
            }
            else {
                await route.continue();
            }
        });
        await expect.poll(() => timeouts, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
        for (const page of [alice, bob]) {
            await expect(page.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            const tick = Number(await page.locator('#online-game').getAttribute('data-tick'));
            await expect.poll(async () => Number(await page.locator('#online-game').getAttribute('data-tick')), {
                timeout: 15000
            }).toBeGreaterThan(tick + 90);
            await expect(page.locator('#round-results')).toBeHidden();
        }
    }
    finally {
        held.forEach((release) => release());
        await alice.close();
        await bob.close();
    }
});

test('a ready host sees a guest reload and ready again in the same lobby', async ({ browser }) => {
    test.setTimeout(60000);
    const alice = await browser.newPage();
    const bob = await browser.newPage();
    try {
        await registerPlayer(alice, `presence-host-${Date.now()}`);
        await registerPlayer(bob, `presence-guest-${Date.now()}`);
        await alice.getByRole('button', { name: 'Create town', exact: true }).click();
        const room = await alice.getByLabel('Room code').inputValue();
        await alice.getByRole('button', { name: 'Host match' }).click();
        await alice.getByRole('button', { name: 'Ready', exact: true }).click();
        for (let entry = 0; entry < 2; entry++) {
            if (entry === 1) {
                await bob.reload();
                await bob.getByRole('button', { name: 'Play with friends' }).click();
            }
            const joinCode = bob.getByLabel('Town code', { exact: true });
            const roomCode = bob.getByLabel('Room code', { exact: true });
            await expect(roomCode.or(joinCode)).toBeVisible({ timeout: 15000 });
            if (await joinCode.isVisible()) {
                await joinCode.fill(room);
                await bob.getByRole('button', { name: 'Join town', exact: true }).click();
            }
            await expect(bob.getByLabel('Room code')).toHaveValue(room, { timeout: 15000 });
            await expect(alice.locator('#match-controls')).toContainText('1/2 ready', { timeout: 15000 });
            await bob.getByRole('button', { name: 'Ready', exact: true }).click({ timeout: 12000 });
            await expect(alice.locator('#roster li')).toHaveCount(2);
            await expect(alice.getByRole('button', { name: 'Start round' })).toBeEnabled();
        }
    }
    finally {
        await alice.close();
        await bob.close();
    }
});

test('a ready choice survives another player joining before the host can receive it', async ({ browser }) => {
    test.setTimeout(90000);
    const alice = await browser.newPage();
    const bob = await browser.newPage();
    const charlie = await browser.newPage();
    let withholdReady = true;
    let held = false;
    await bob.routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
            if (withholdReady && decodeMatchWire(message)?.action.kind === 'ready') {
                held = true;
            }
            else {
                server.send(message);
            }
        });
    });
    try {
        await registerPlayer(alice, `ready-owner-${Date.now()}`);
        await registerPlayer(bob, `ready-guest-${Date.now()}`);
        await registerPlayer(charlie, `ready-newcomer-${Date.now()}`);
        await alice.getByRole('button', { name: 'Create town', exact: true }).click();
        const room = await alice.getByLabel('Room code').inputValue();
        await bob.getByLabel('Town code').fill(room);
        await bob.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(alice.locator('#roster li')).toHaveCount(2);
        await alice.getByRole('button', { name: 'Host match' }).click();
        await bob.getByRole('button', { name: 'Ready', exact: true }).click({ timeout: 15000 });
        await expect.poll(() => held).toBe(true);

        await charlie.getByLabel('Town code').fill(room);
        await charlie.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(bob.locator('#match-controls')).toContainText('0/3 ready', { timeout: 15000 });
        withholdReady = false;

        await expect(alice.locator('#match-controls')).toContainText('1/3 ready', { timeout: 10000 });
        await expect(bob.getByRole('button', { name: 'Not ready', exact: true })).toBeEnabled();
    }
    finally {
        await Promise.allSettled([alice.close(), bob.close(), charlie.close()]);
    }
});

test('a confirmed lobby replaces a transient room recovery error', async ({ page }) => {
    test.setTimeout(60000);
    await registerPlayer(page, `recover-ready-${Date.now()}`);
    await page.getByRole('button', { name: 'Create town', exact: true }).click();
    const room = await page.getByLabel('Room code').inputValue();
    await page.getByRole('button', { name: 'Host match' }).click();
    await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(page.locator('#match-controls')).toContainText('1/1 ready');

    const scope = new RegExp('/groups/' + room + '(?:[/?]|$)');
    try {
        // Leave this room's requests pending until both the lease and the recovery read expire.
        await page.route(scope, () => {});
        await expect(page.locator('#match-controls')).toContainText('Command timed out', { timeout: 20000 });
    }
    finally {
        await page.unroute(scope);
    }
    await expect(page.locator('#match-controls')).toContainText('1/1 ready', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Not ready', exact: true })).toBeEnabled();
});
