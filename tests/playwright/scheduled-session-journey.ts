import { expect, type Browser, type Page } from '@playwright/test';
import { assertIdleViewReads } from './assert-idle-view-reads.ts';
import { localStartInput } from './local-start-input.ts';
import {
    openArenaOperations,
    prepareRoomPlayers,
    signInRoomPlayer,
    startAndVerifyRoomPlay
} from './room-player-journey.ts';

/** Exercise only visible SPA controls against the actual API and game authority. */
export async function scheduledSessionRecoveryJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    const session = await scheduleThroughControls(host, 20 * 60_000);
    await followSessionLink(guest, session.link, game);
    await observeUnreservedPreviewChange(host, guest, game);
    const guestPanel = guest.getByRole('region', { name: 'Scheduled sessions', exact: true });
    const hostPanel = host.getByRole('region', { name: 'Scheduled sessions', exact: true });
    await expect(guestPanel.getByRole('button', { name: 'Enter lobby', exact: true })).toBeDisabled();
    await guestPanel.getByRole('button', { name: 'Reserve a seat', exact: true }).click();
    await expect(guestPanel.getByRole('article', { name: 'Session details' })).toContainText('Your seat is reserved');
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await expect(guestPanel.getByRole('article', { name: 'Session details' })).toContainText('Your seat is reserved');
    await guestPanel.getByRole('button', { name: 'Cancel reservation', exact: true }).click();
    await expect(guestPanel.getByRole('button', { name: 'Reserve a seat', exact: true })).toBeEnabled();
    await guestPanel.getByRole('button', { name: 'Reserve a seat', exact: true }).click();
    await expect(guestPanel.getByRole('button', { name: 'Cancel reservation', exact: true })).toBeEnabled();
    await hostPanel.getByText('Change schedule', { exact: true }).click();
    const next = await localStartInput(host, 25 * 60_000);
    await hostPanel.getByLabel('New session start', { exact: true }).fill(next.input);
    await hostPanel.getByRole('button', { name: 'Reschedule session', exact: true }).click();
    await expect(guestPanel.getByRole('button', { name: 'Confirm new time', exact: true })).toBeEnabled({
        timeout: 30_000
    });
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await expect(guestPanel.getByRole('button', { name: 'Confirm new time', exact: true })).toBeEnabled();
    await guestPanel.getByRole('button', { name: 'Confirm new time', exact: true }).click();
    await expect(guestPanel.getByRole('article', { name: 'Session details' })).toContainText('Your seat is reserved');
    await hostPanel.getByText('Change schedule', { exact: true }).click();
    await hostPanel.getByRole('button', { name: 'Cancel session', exact: true }).click();
    await expect(guestPanel.getByRole('article', { name: 'Session details' })).toContainText(
        'This session was cancelled.',
        { timeout: 30_000 }
    );
    await expect(guestPanel.getByRole('button', { name: 'Enter lobby', exact: true })).toBeDisabled();
}

/** A share-link visitor receives updates before acquiring any reservation or room membership. */
async function observeUnreservedPreviewChange(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    const hostPanel = host.getByRole('region', { name: 'Scheduled sessions', exact: true });
    const guestPanel = guest.getByRole('region', { name: 'Scheduled sessions', exact: true });
    const previewName = await guestPanel.getByRole('article', { name: 'Session details' }).getByRole('heading')
        .innerText();
    const savedPreview = guestPanel.getByLabel('Your scheduled sessions', { exact: true })
        .getByRole('button', { name: previewName });
    await expect(savedPreview).toHaveCount(0);
    await expect(guestPanel).toContainText('Reserve a seat before entering.');
    await assertIdleViewReads(guest, 'sessions');
    const oldStart = await guestPanel.getByText(/^Starts /).innerText();
    await hostPanel.getByText('Change schedule', { exact: true }).click();
    const next = await localStartInput(host, 22 * 60_000);
    await hostPanel.getByLabel('New session start', { exact: true }).fill(next.input);
    await hostPanel.getByRole('button', { name: 'Reschedule session', exact: true }).click();
    await expect(guestPanel.getByText(/^Starts /)).not.toHaveText(oldStart);
    await expect(guestPanel.getByText(/^Starts /)).toHaveText(await hostPanel.getByText(/^Starts /).innerText());
    await expect(savedPreview).toHaveCount(0);
    await assertIdleViewReads(guest, 'sessions');
    const previewLink = guest.url();
    await guest.goto('about:blank');
    await hostPanel.getByText('Change schedule', { exact: true }).click();
    const whileAway = await localStartInput(host, 23 * 60_000);
    await hostPanel.getByLabel('New session start', { exact: true }).fill(whileAway.input);
    await hostPanel.getByRole('button', { name: 'Reschedule session', exact: true }).click();
    await followSessionLink(guest, previewLink, game);
    await expect(guestPanel.getByText(/^Starts /)).toHaveText(await hostPanel.getByText(/^Starts /).innerText());
    await expect(savedPreview).toHaveCount(0);
}

export async function scheduledSessionPlayJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    const session = await scheduleThroughControls(host, 90_000);
    await followSessionLink(guest, session.link, game);
    const guestPanel = guest.getByRole('region', { name: 'Scheduled sessions', exact: true });
    await guestPanel.getByRole('button', { name: 'Reserve a seat', exact: true }).click();
    await expect(guestPanel.getByRole('article', { name: 'Session details' })).toContainText('Your seat is reserved');
    for (const page of [host, guest]) {
        const panel = page.getByRole('region', { name: 'Scheduled sessions', exact: true });
        await panel.getByRole('button', { name: 'Enter lobby', exact: true }).click();
        await expect(page.getByText(`Entered ${session.groupId}.`, { exact: true })).toBeVisible({ timeout: 30_000 });
    }
    await prepareRoomPlayers(host, guest, game);
    expect(Date.now()).toBeLessThan(session.startsAtEpochMs);
    const startButton = game === 'arena'
        ? host.getByRole('button', { name: '1m', exact: true })
        : host.locator('.lobby-begin-btn');
    await startButton.click();
    await expect(host.getByText('Wait until the scheduled start time before starting gameplay.', { exact: true }))
        .toBeVisible();
    // Server time advances naturally: browser-clock mocking would not prove the authority gate.
    await expect.poll(() => Date.now(), { timeout: 120_000, intervals: [500] }).toBeGreaterThanOrEqual(
        session.startsAtEpochMs
    );
    // Reaching the instant must not start either game automatically.
    await expect(startButton).toBeEnabled();
    await startAndVerifyRoomPlay(host, guest, game);
    if (game === 'arena') {
        const canvas = guest.getByLabel('AR Eye Hunter gameplay canvas');
        await expect(canvas).toHaveAttribute('data-arena-avatar-count', /^[1-9]\d*$/, { timeout: 20_000 });
        const shotsBefore = Number(await canvas.getAttribute('data-arena-shot-sequence'));
        await canvas.click({ position: { x: 400, y: 200 } });
        await expect.poll(async () => Number(await canvas.getAttribute('data-arena-shot-sequence'))).toBeGreaterThan(
            shotsBefore
        );
        await guest.keyboard.press('Escape');
    }
}

export interface ScheduledSessionDestination {
    readonly link: string;
    readonly groupId: string;
    readonly startsAtEpochMs: number;
}

export async function scheduleThroughControls(page: Page, delayMs: number, guestBooking = false): Promise<ScheduledSessionDestination> {
    const panel = page.getByRole('region', { name: 'Scheduled sessions', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByText('Schedule a session', { exact: true }).click();
    const start = await localStartInput(page, delayMs);
    await panel.getByLabel('Session name', { exact: true }).fill(`Together ${Date.now()}`);
    await panel.getByLabel('Session start', { exact: true }).fill(start.input);
    await panel.getByLabel('Player seats', { exact: true }).fill('2');
    if (guestBooking) await panel.getByLabel('Allow guest reservations').check();
    await panel.getByRole('button', { name: 'Create scheduled session', exact: true }).click();
    const link = panel.getByLabel('Session share link', { exact: true });
    await expect(link).toHaveValue(/#rallar-session\?/);
    const value = await link.inputValue();
    const groupId = new URLSearchParams(new URL(value).hash.slice('#rallar-session?'.length)).get('groupId');
    if (!groupId) {
        throw new Error('Scheduled session did not expose its scoped room identity');
    }
    return { link: value, groupId, startsAtEpochMs: start.epochMs };
}

async function followSessionLink(page: Page, link: string, game: 'arena' | 'relic'): Promise<void> {
    await page.goto(link);
    if (game === 'arena') {
        await openArenaOperations(page);
    }
    await expect(page.getByRole('article', { name: 'Session details', exact: true })).toBeVisible();
}

interface GuestSessionBookingJourneyInput {
    readonly page: Page;
    readonly guest: Page;
    readonly browser: Browser;
    readonly game: 'arena' | 'relic';
}

export async function guestSessionBookingJourney({ page, guest, browser, game }: GuestSessionBookingJourneyInput): Promise<void> {
    await signInRoomPlayer(page, 'alice', game);
    const session = await scheduleThroughControls(page, 300_000, true);
    await guest.goto(session.link);
    if (game === 'arena') await openArenaOperations(guest);
    const booking = guest.getByRole('region', { name: 'Guest reservation' });
    await guest.route('**/session/guest/requests/*', async route => {
        await route.fetch();
        await route.abort();
    }, { times: 1 });
    await booking.getByRole('button', { name: 'Reserve as a guest' }).click();
    await expect(booking.getByRole('alert')).toBeVisible();
    await guest.reload();
    if (game === 'arena') await openArenaOperations(guest);
    await expect(booking).toContainText('Your lobby seat is reserved.');
    const other = await browser.newPage();
    try {
        await other.goto(session.link);
        if (game === 'arena') await openArenaOperations(other);
        await expect(other.getByRole('button', { name: 'Reserve as a guest' })).toBeDisabled();
        await expect(other.getByRole('button', { name: 'Claim my lobby seat' })).toHaveCount(0);
    } finally { await other.close(); }
    const claim = booking.getByRole('button', { name: 'Claim my lobby seat' });
    const requests: string[] = [];
    const accountOnlyReads: string[] = [];
    guest.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (/\/(?:group-directory|tournament|clients|groups)$/.test(path)) accountOnlyReads.push(path);
    });
    await guest.route('**/session/guest/requests/*', async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        requests.push(route.request().url());
        if (requests.length === 1) {
            await guest.evaluate(() => {
                const getItem = Storage.prototype.getItem;
                Storage.prototype.getItem = function (key: string) {
                    if (key === 'auth.session') throw new DOMException('Browser session storage temporarily unavailable', 'SecurityError');
                    return getItem.call(this, key);
                };
                window.addEventListener('restore-test-storage', () => { Storage.prototype.getItem = getItem; }, { once: true });
            });
        }
        await route.fulfill({ response });
    });
    await claim.click();
    await expect(booking.getByRole('alert')).toContainText('Browser session storage temporarily unavailable');
    await guest.evaluate(() => { window.dispatchEvent(new Event('restore-test-storage')); });
    await claim.click();
    await expect(page.getByRole('region', { name: 'Scheduled sessions', exact: true })).toContainText('0 of 2 player seats available.');
    await expect(guest.getByText(`Entered ${session.groupId}.`, { exact: true })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
    const refresh = guest.waitForResponse(response => {
        const path = new URL(response.url()).pathname;
        return response.request().method() === 'GET' && (path.endsWith('/groups') || path.endsWith('/groups/' + session.groupId));
    });
    await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
    expect((await refresh).status()).toBe(200);
    await expect(guest.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
    if (game === 'arena') {
        await expect(guest.getByRole('button', { name: 'Appoint this SPA' })).toBeDisabled();
    }
    expect(accountOnlyReads).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
}
