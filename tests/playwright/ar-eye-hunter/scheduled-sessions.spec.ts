import { roomBrowserTest } from '../room-browser-fixture.ts';
import { expect } from '@playwright/test';
import { openArenaOperations, signInRoomPlayer } from '../room-player-journey.ts';
import { scheduleThroughControls, scheduledSessionPlayJourney, scheduledSessionRecoveryJourney } from '../scheduled-session-journey.ts';

roomBrowserTest(
    'schedules, reserves, reloads, reconfirms and cancels an arena session through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240_000);
        await scheduledSessionRecoveryJourney(page, guest, 'arena');
    }
);

roomBrowserTest(
    'claims scheduled seats and plays together after the host explicitly starts',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240_000);
        await scheduledSessionPlayJourney(page, guest, 'arena');
    }
);

roomBrowserTest('a guest recovers a booking after a lost response and enters while a forwarded link starts a separate visit',
    async ({ page, guest, browser, baseURL }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(180_000);
        await signInRoomPlayer(page, 'alice', 'arena');
        const session = await scheduleThroughControls(page, 300_000, true);
        await guest.goto(session.link);
        await openArenaOperations(guest);
        const booking = guest.getByRole('region', { name: 'Guest reservation' });
        await guest.route('**/session/guest/requests/*', async route => {
            await route.fetch();
            await route.abort();
        }, { times: 1 });
        await booking.getByRole('button', { name: 'Reserve as a guest' }).click();
        await expect(booking.getByRole('alert')).toBeVisible();
        await guest.reload();
        await openArenaOperations(guest);
        await expect(booking).toContainText('Your lobby seat is reserved.');
        const other = await browser.newPage({ baseURL });
        try {
            await other.goto(session.link);
            await openArenaOperations(other);
            await expect(other.getByRole('button', { name: 'Reserve as a guest' })).toBeDisabled();
            await expect(other.getByRole('button', { name: 'Claim my lobby seat' })).toHaveCount(0);
        } finally { await other.close(); }
        await booking.getByRole('button', { name: 'Claim my lobby seat' }).click();
        await expect(page.getByRole('region', { name: 'Scheduled sessions', exact: true })).toContainText('0 of 2 player seats available.');
        await expect(guest.getByText(`Entered ${session.groupId}.`, { exact: true })).toBeVisible();
    });
