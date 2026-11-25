import { expect, test } from '@playwright/test';
import { decodeMatchWire } from './match-browser.ts';

test('an interrupted guest can read consented connection diagnostics on a phone', async ({ page, browser }) => {
    test.setTimeout(80000);
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill('trial-owner-' + Date.now());
    await page.getByLabel('Password', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Create town' }).click();
    await page.getByRole('button', { name: 'Host match' }).click();
    await page.getByRole('button', { name: 'Invite guests' }).click();
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
        let stall = false;
        let close: (() => void) | undefined;
        await guest.routeWebSocket(/\/api\/ws\//, socket => {
            const server = socket.connectToServer();
            close = () => socket.close({ code: 4001, reason: 'Trial interruption' });
            server.onMessage(payload => {
                if (!stall || !decodeMatchWire(payload)) socket.send(payload);
            });
        });
        const phone = await guest.newPage();
        const link = new URL(await page.getByLabel('Guest invitation link').inputValue());
        link.searchParams.set('diagnostics', '1');
        await phone.goto(link.href);
        await phone.getByRole('button', { name: 'Join this town' }).click();
        await phone.getByRole('button', { name: 'Ready', exact: true }).click();
        await page.getByRole('button', { name: 'Ready', exact: true }).click();
        await page.getByRole('button', { name: 'Start round' }).click();
        await expect.poll(async () => Number(await phone.locator('#online-game').getAttribute('data-tick'))).toBeGreaterThan(3);
        stall = true;
        await expect(phone.getByRole('heading', { name: 'Round interrupted' })).toBeVisible({ timeout: 25000 });
        const status = phone.getByRole('status', { name: 'Connection diagnostics' });
        await expect(status).toContainText('WebSocket close unobserved');
        await expect(status).toContainText(/Last confirmed tick [1-9][0-9]*/);
        await expect(status).toContainText('Page visible');
        await expect(status).toContainText('Restored no');
        close!();
        await expect(status).toContainText('WebSocket close 4001');
    }
    finally {
        await guest.close();
    }
});
