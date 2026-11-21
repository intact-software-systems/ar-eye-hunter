import { expect, type Page } from '@playwright/test';

import { decodeTownMatchFrame, type TownMatchFrame } from '../../../apps/cca-2d/src/match/match-protocol.ts';
import { decodeALMessage } from '../../../packages/shared/al-contracts/al-message-persistence-validation.ts';

export async function registerPlayer(page: Page, username: string): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('Local-trial-only-48!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'Create town', exact: true })).toBeVisible({ timeout: 15000 });
}

export async function startTownMatch(
    pages: readonly Page[],
    usernames: readonly string[] = pages.map((_, index) => `cca-player-${index}-${Date.now()}`)
): Promise<void> {
    for (const [index, page] of pages.entries()) {
        await registerPlayer(page, usernames[index]);
    }
    const alice = pages[0];
    await alice.getByRole('button', { name: 'Create town', exact: true }).click();
    const roomCode = await alice.getByLabel('Room code').inputValue();
    for (const page of pages.slice(1)) {
        await page.getByLabel('Town code').fill(roomCode);
        await page.getByRole('button', { name: 'Join town', exact: true }).click();
    }
    await expect(alice.locator('#roster li')).toHaveCount(pages.length);
    await alice.getByRole('button', { name: 'Host match', exact: true }).click();
    for (const page of pages) {
        await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await page.getByRole('button', { name: 'Ready', exact: true }).click();
    }
    await alice.getByRole('button', { name: 'Start round', exact: true }).click();
    for (const page of pages) {
        await expect(page.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 15000 });
        await expect(page.getByLabel('Movement joystick')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Dash and drop', exact: true })).toBeEnabled();
    }
}

export function decodeMatchWire(message: string | Buffer): TownMatchFrame | undefined {
    const envelope = decodeALMessage(String(message)).right;
    if (!envelope || envelope.payload.typeId !== 'cca.match.frame') {
        return undefined;
    }
    const payload: unknown = JSON.parse(envelope.payload.resource);
    return decodeTownMatchFrame(payload).right;
}
