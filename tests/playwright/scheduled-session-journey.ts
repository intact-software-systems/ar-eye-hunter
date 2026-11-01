import { expect, type Page } from '@playwright/test';
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

async function scheduleThroughControls(page: Page, delayMs: number) {
    const panel = page.getByRole('region', { name: 'Scheduled sessions', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByText('Schedule a session', { exact: true }).click();
    const start = await localStartInput(page, delayMs);
    await panel.getByLabel('Session name', { exact: true }).fill(`Together ${Date.now()}`);
    await panel.getByLabel('Session start', { exact: true }).fill(start.input);
    await panel.getByLabel('Player seats', { exact: true }).fill('2');
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

async function localStartInput(page: Page, delayMs: number) {
    return await page.evaluate((delay) => {
        const date = new Date(Math.ceil((Date.now() + delay) / 1000) * 1000);
        return {
            epochMs: date.getTime(),
            input: new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace(
                /:00$/,
                ''
            )
        };
    }, delayMs);
}
