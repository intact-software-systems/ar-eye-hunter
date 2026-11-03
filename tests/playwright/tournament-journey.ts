import { expect, type Page } from '@playwright/test';
import type { TournamentMatch } from '../../packages/shared/api/tournaments/tournament-types.ts';
import { localStartInput } from './local-start-input.ts';
import { openArenaOperations } from './room-player-journey.ts';

/** Real accounts register, check in and enter through the same controls as human players. */
export async function registerTournament(
    players: readonly [Page, Page, Page, Page],
    game: 'arena' | 'relic'
): Promise<void> {
    for (const [index, page] of players.entries()) {
        await registerHunter(page, game, index);
    }
    const host = players[0];
    await panel(host).getByRole('button', { name: 'New tournament', exact: true }).click();
    await panel(host).getByLabel('Tournament title', { exact: true }).fill('Four hunter cup');
    await panel(host).getByRole('button', { name: 'Create tournament', exact: true }).click();
    const share = panel(host).getByLabel('Tournament share link', { exact: true });
    await expect(share).toHaveValue(/#rallar-tournament\?/);
    const link = await share.inputValue();
    for (const [index, page] of players.entries()) {
        if (index !== 0) {
            await panel(page).getByLabel('Tournament link', { exact: true }).fill(link);
            await panel(page).getByRole('button', { name: 'Preview tournament', exact: true }).click();
        }
        await expect(panel(page)).toContainText('Four hunter cup');
        await expect(panel(page).getByRole('button', { name: 'Enter tournament match', exact: true })).toHaveCount(0);
        await panel(page).getByRole('button', { name: 'Register for tournament', exact: true }).click();
        await expect(panel(host).locator('ol li')).toHaveCount(index + 1);
    }
    await host.reload();
    if (game === 'arena') {
        await openArenaOperations(host);
    }
    await expect(panel(host).locator('ol li')).toHaveCount(4);
    await panel(host).getByRole('button', { name: 'Launch bracket', exact: true }).click();
}

export async function startTournamentMatch(
    host: Page,
    competitors: readonly [Page, Page],
    slot: TournamentMatch['slot']
): Promise<void> {
    const semifinal = panel(host).getByRole('article', { name: slot, exact: true });
    const startInput = await localStartInput(host, 30000);
    await semifinal.getByLabel('Match start', { exact: true }).fill(startInput.input);
    await semifinal.getByRole('button', { name: 'Schedule match', exact: true }).click();
    for (const player of competitors) {
        await panel(player).getByRole('article', { name: slot, exact: true }).getByRole('button', {
            name: 'Check in for match',
            exact: true
        }).click();
    }
    const start = semifinal.getByRole('button', { name: 'Start tournament match', exact: true });
    await expect(start).toBeEnabled({ timeout: 45000 });
    await start.click();
    for (const player of competitors) {
        await panel(player).getByRole('article', { name: slot, exact: true }).getByRole('button', {
            name: 'Enter tournament match',
            exact: true
        }).click();
        const entry = player.getByRole('region', { name: 'Shared room entry', exact: true });
        await expect(entry.getByText(/^Entered /)).toBeVisible();
        await expect(entry.getByRole('alert')).toHaveCount(0);
    }
}

export function tournamentMatch(page: Page, slot: TournamentMatch['slot']) {
    return panel(page).getByRole('article', { name: slot, exact: true });
}

async function registerHunter(page: Page, game: 'arena' | 'relic', index: number): Promise<void> {
    page.setDefaultTimeout(20000);
    await page.goto(game === 'arena' ? 'http://127.0.0.1:5186' : 'http://127.0.0.1:5175');
    if (game === 'arena') {
        await openArenaOperations(page);
    }
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(`cup-${index}-${crypto.randomUUID().slice(0, 8)}`);
    await page.getByLabel('Display name', { exact: true }).fill(`Cup hunter ${index + 1}`);
    await page.getByLabel('Password', { exact: true }).fill('Tournament-test-123!');
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    await expect(panel(page)).toBeVisible();
}

function panel(page: Page) {
    return page.getByRole('region', { name: 'Tournaments', exact: true });
}

export async function cancelPlayingTournament(
    players: readonly [Page, Page, Page, Page],
    game: 'arena' | 'relic'
): Promise<void> {
    await registerTournament(players, game);
    const [host, guest] = players;
    await startTournamentMatch(host, [host, guest], 'semifinal-1');
    for (const player of [host, guest]) {
        if (game === 'arena') {
            await player.bringToFront();
            await expect(player.getByLabel('AR Eye Hunter gameplay canvas', { exact: true })).toHaveAttribute(
                'data-arena-match-id',
                /.+/
            );
        }
        else {
            await expect(player.getByRole('button', { name: /^Submit Plan/ })).toBeEnabled();
        }
    }
    await panel(host).getByRole('button', { name: 'Cancel tournament', exact: true }).click();
    await panel(host).getByRole('button', { name: 'Confirm cancel tournament', exact: true }).click();
    for (const player of [host, guest]) {
        await expect(panel(player).getByText('Tournament cancelled', { exact: true })).toBeVisible();
        if (game === 'arena') {
            const notice = player.getByRole('dialog', { name: 'Tournament match cancelled', exact: true });
            await expect(notice).toBeVisible();
            await notice.getByRole('button', { name: 'Return to tournament bracket', exact: true }).click();
            await expect(notice).toHaveCount(0);
        }
        else {
            await expect(player.getByRole('alert').filter({ hasText: 'This tournament match was cancelled.' }))
                .toBeVisible();
            await expect(player.getByRole('button', { name: /^Submit Plan/ })).toHaveCount(0);
        }
        await expect(panel(player).getByRole('button', { name: 'New tournament', exact: true })).toBeEnabled();
        await expect(panel(player).getByText(/^Champion:/)).toHaveCount(0);
    }
}
