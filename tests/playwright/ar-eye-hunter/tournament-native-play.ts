import { expect, type Page } from '@playwright/test';
import { blocksShot } from '../../../packages/ar-eye-hunter/arena-layout.ts';
import { decodeArenaTournamentSnapshot } from '../../../packages/ar-eye-hunter/arena-tournament-snapshot.ts';
import type { TournamentArena } from '../../../packages/ar-eye-hunter/tournament-arena.ts';
import { toGroupId } from '../room-player-journey.ts';

/** Observe the public state, then aim and shoot exclusively with real canvas input. */
export async function playArenaTournament(winner: Page, opponent: Page): Promise<void> {
    await winner.bringToFront();
    const canvas = winner.getByLabel('AR Eye Hunter gameplay canvas', { exact: true });
    const roomId = toGroupId(await winner.getByLabel('Room link', { exact: true }).inputValue());
    const initial = await observeArena(winner, roomId);
    await expect(canvas).toHaveAttribute('data-arena-match-id', initial.gameId);
    await opponent.bringToFront();
    await expect(opponent.getByLabel('AR Eye Hunter gameplay canvas', { exact: true })).toHaveAttribute(
        'data-arena-match-id',
        initial.gameId
    );
    const closeOperations = winner.getByRole('button', { name: 'Close Ops', exact: true });
    if (await closeOperations.isVisible()) {
        await closeOperations.click();
    }
    await winner.bringToFront();

    await winner.keyboard.down('w');
    let moved = initial;
    try {
        await expect.poll(async () => {
            moved = await observeArena(winner, roomId);
            return distance(initial.players[0].simulation.position, moved.players[0].simulation.position);
        }).toBeGreaterThan(0.1);
    }
    finally {
        await winner.keyboard.up('w');
    }
    await scoreWithTouch(winner, roomId);
    await winner.keyboard.press('Escape');
    await opponent.reload();
    for (const page of [winner, opponent]) {
        await expect(page.getByRole('dialog', { name: 'Match results', exact: true })).toBeVisible({ timeout: 75000 });
        await expect(page.locator('.match-result-row').first().locator('span').first()).toHaveText(/^[1-9]\d* pts$/);
    }
    await expect(opponent.locator('.match-result-row')).toHaveText(
        await winner.locator('.match-result-row').allTextContents()
    );
    // Results return to the bracket without deleting the owner’s old membership.
    for (const page of [winner, opponent]) {
        await page.getByRole('button', { name: 'Return to tournament bracket', exact: true }).click();
    }
}

async function scoreWithTouch(page: Page, roomId: string): Promise<void> {
    const viewport = page.viewportSize();
    if (!viewport) {
        throw new Error('The gameplay journey needs a viewport for touch aiming.');
    }
    await expect.poll(async () => {
        const state = await observeArena(page, roomId);
        const player = state.players[0];
        if (player.simulation.combat.score > 0) {
            return player.simulation.combat.score;
        }
        // The fresh camera faces +Z. Project public targets into its 0.94-radian vertical field of view.
        const origin = player.simulation.position;
        const focalLength = viewport.height / (2 * Math.tan(0.94 / 2));
        for (const target of state.arena.targets) {
            const [x, y, z] = target.position.map((value, index) => value - origin[index]);
            const screenX = viewport.width / 2 + x * focalLength / z;
            const screenY = viewport.height / 2 - y * focalLength / z;
            if (
                z > 0 && screenX > 30 && screenX < viewport.width - 30 &&
                screenY > 160 && screenY < viewport.height - 120 &&
                !blocksShot(state.arena.layout, origin, target.position) &&
                await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', {
                    x: screenX,
                    y: screenY
                })
            ) {
                await page.touchscreen.tap(screenX, screenY);
                return 0;
            }
        }
        throw new Error('No visible native target can be tapped outside the HUD.');
    }, { timeout: 15000, intervals: [500] }).toBeGreaterThan(0);
}

async function observeArena(page: Page, roomId: string): Promise<TournamentArena> {
    const path = `/api/ar-eye/rooms/${encodeURIComponent(roomId)}/tournament`;
    const response = await page.waitForResponse((candidate) =>
        candidate.request().method() === 'GET' && new URL(candidate.url()).pathname === path &&
        candidate.status() === 200
    );
    const snapshot = decodeArenaTournamentSnapshot(await response.json());
    if (!snapshot.state) {
        return observeArena(page, roomId);
    }
    return snapshot.state;
}

function distance(left: readonly number[], right: readonly number[]): number {
    return Math.hypot(...left.map((value, index) => value - right[index]));
}
