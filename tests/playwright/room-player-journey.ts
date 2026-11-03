import { expect, type Page } from '@playwright/test';

export async function signInRoomPlayer(page: Page, username: string, game: 'arena' | 'relic'): Promise<void> {
    await page.goto(game === 'arena' ? 'http://127.0.0.1:5186' : 'http://127.0.0.1:5175');
    if (game === 'arena') {
        await openArenaOperations(page);
    }
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('secret');
    await page.getByRole('button', { name: game === 'arena' ? 'Enter Arena' : 'Enter', exact: true }).click();
}

export async function playTogetherInRoom(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await prepareRoomPlayers(host, guest, game);
    await startAndVerifyRoomPlay(host, guest, game);
}

export async function prepareRoomPlayers(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    if (game === 'arena') {
        const appoint = host.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        await expect(host.getByRole('button', { name: '1m', exact: true })).toBeEnabled();
    }
    else {
        await expect(host.locator('.lobby-party-row')).toHaveCount(0);
        await expect(guest.locator('.lobby-party-row')).toHaveCount(0);
        for (const page of [host, guest]) {
            await page.getByRole('button', { name: /Join as/ }).click();
        }
        await expect(host.locator('.lobby-party-row')).toHaveCount(2);
    }
}

export async function startAndVerifyRoomPlay(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    if (game === 'arena') {
        await host.getByRole('button', { name: '1m', exact: true }).click();
        await expect(guest.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/);
        const hostCanvas = host.getByLabel('AR Eye Hunter gameplay canvas');
        const guestCanvas = guest.getByLabel('AR Eye Hunter gameplay canvas');
        await expect(hostCanvas).toHaveAttribute('data-arena-match-id', /^match:/);
        await expect(guestCanvas).toHaveAttribute(
            'data-arena-match-id',
            await hostCanvas.getAttribute('data-arena-match-id') ?? ''
        );
    }
    else {
        await host.locator('.lobby-begin-btn').click();
        await expect(guest.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await host.getByRole('button', { name: 'Submit Plan' }).click();
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
        for (const hunter of [host, guest]) {
            await expect(hunter.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', { timeout: 30000 });
        }
    }
}

export function toGroupId(link: string): string {
    const id = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
    if (!id) {
        throw new Error('Room sharing did not expose a group identity');
    }
    return id;
}

export async function openArenaOperations(page: Page): Promise<void> {
    const panel = page.getByRole('region', { name: 'Arena operations', exact: true });
    if (await panel.isVisible()) {
        return;
    }
    const button = page.getByRole('button', { name: 'Ops', exact: true });
    await expect(panel.or(button).first()).toBeVisible({ timeout: 30000 });
    if (!await panel.isVisible()) {
        await button.click();
    }
    await expect(panel).toBeVisible();
}
