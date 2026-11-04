import { expect, test, type Page } from '@playwright/test';
import type { TournamentMatch } from '../../packages/shared/api/tournaments/tournament-types.ts';
import { localStartInput } from './local-start-input.ts';
import { openArenaOperations } from './room-player-journey.ts';
import { assertIdleViewReads } from './view-push-observation.ts';

/** Real accounts register, check in and enter through the same controls as human players. */
export async function registerTournament(
    players: readonly [Page, Page, Page, Page],
    game: 'arena' | 'relic'
): Promise<string> {
    const { host, title, linkGuest } = await createTournamentPreview(players, game);
    await verifyNarrowTournamentNavigation(host);
    await panel(host).getByRole('button', { name: 'Publish tournament', exact: true }).click();
    await expect(panel(host).getByText('Published in Discover', { exact: true })).toBeVisible();
    for (const [index, page] of players.entries()) {
        if (index !== 0) {
            await panel(page).getByRole('article', { name: `Tournament ${title}`, exact: true }).getByRole('button', {
                name: 'Open tournament',
                exact: true
            }).click();
        }
        await expect(panel(page).getByRole('article', { name: 'Tournament bracket', exact: true })).toContainText(
            title
        );
        await expect(panel(page).getByRole('button', { name: 'Enter tournament match', exact: true })).toHaveCount(0);
        await expect(panel(host).locator('ol li')).toHaveCount(index);
        if (index === 2) {
            await linkGuest.context().setOffline(true);
        }
        await panel(page).getByRole('button', { name: 'Register for tournament', exact: true }).click();
        await expect(panel(host).locator('ol li')).toHaveCount(index + 1);
        if (index === 2) {
            await expect(panel(linkGuest).locator('ol li')).toHaveCount(index);
            await linkGuest.context().setOffline(false);
        }
        if (index < 3) {
            await expect(panel(linkGuest).locator('ol li')).toHaveCount(index + 1);
        }
        if (index === 1) {
            await withdrawAndRegisterAgain(page, title);
        }
    }
    await recoverTournamentFromHistory({ page: host, game, title, completedMatch: false });
    await expect(panel(host).locator('ol li')).toHaveCount(4);
    await panel(host).getByRole('button', { name: 'Unlist tournament', exact: true }).click();
    await expect(panel(host).getByText('Unlisted · available through its share link', { exact: true })).toBeVisible();
    await expect(panel(players[1]).getByRole('article', { name: `Tournament ${title}`, exact: true })).toHaveCount(0);
    await expect(panel(players[1]).locator('ol li')).toHaveCount(4);
    await panel(host).getByRole('button', { name: 'Launch bracket', exact: true }).click();
    return title;
}

interface TournamentPreview {
    readonly host: Page;
    readonly title: string;
    readonly linkGuest: Page;
}

async function createTournamentPreview(
    players: readonly [Page, Page, Page, Page],
    game: 'arena' | 'relic'
): Promise<TournamentPreview> {
    for (const [index, page] of players.entries()) {
        await registerHunter(page, game, index);
    }
    const host = players[0];
    const title = `Four hunter cup ${crypto.randomUUID().slice(0, 8)}`;
    await panel(host).getByRole('button', { name: 'New tournament', exact: true }).click();
    await panel(host).getByLabel('Tournament title', { exact: true }).fill(title);
    await panel(host).getByRole('button', { name: 'Create tournament', exact: true }).click();
    const share = panel(host).getByLabel('Tournament share link', { exact: true });
    await expect(share).toHaveValue(/#rallar-tournament\?/);
    await expect(panel(host).getByText('Unlisted · available through its share link', { exact: true })).toBeVisible();
    await expect(panel(players[1]).getByRole('article', { name: `Tournament ${title}`, exact: true })).toHaveCount(0);
    // An unlisted share link stays usable without adding an entrant or changing rooms.
    const linkGuest = players[3];
    await panel(linkGuest).getByLabel('Tournament link', { exact: true }).fill(await share.inputValue());
    await panel(linkGuest).getByRole('button', { name: 'Preview tournament', exact: true }).click();
    await expect(panel(linkGuest).getByRole('article', { name: 'Tournament bracket', exact: true })).toContainText(
        title
    );
    await expect(panel(host).locator('ol li')).toHaveCount(0);
    await assertIdleViewReads(linkGuest, 'tournaments');
    return { host, title, linkGuest };
}

async function verifyNarrowTournamentNavigation(page: Page): Promise<void> {
    const previousViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    const catalogue = page.getByRole('region', { name: 'Tournament catalogue', exact: true });
    const discover = catalogue.getByRole('button', { name: 'Discover', exact: true });
    const mine = catalogue.getByRole('button', { name: 'My tournaments', exact: true });
    await discover.focus();
    await page.keyboard.press('Tab');
    await expect(mine).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(mine).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Shift+Tab');
    await expect(discover).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(discover).toHaveAttribute('aria-pressed', 'true');
    const bounds = await catalogue.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await test.info().attach('tournament-hub-narrow', { body: await page.screenshot(), contentType: 'image/png' });
    if (previousViewport) {
        await page.setViewportSize(previousViewport);
    }
}

async function withdrawAndRegisterAgain(page: Page, title: string): Promise<void> {
    await panel(page).getByRole('button', { name: 'Withdraw from tournament', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Confirm withdraw from tournament', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Register for tournament', exact: true })).toBeEnabled();
    await panel(page).getByRole('button', { name: 'My tournaments', exact: true }).click();
    await expect(panel(page).getByText('No tournaments found.', { exact: true })).toBeVisible();
    await expect(panel(page).getByRole('article', { name: `Tournament ${title}`, exact: true })).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Register for tournament', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Discover', exact: true }).click();
}

export interface TournamentHistoryRecoveryInput {
    readonly page: Page;
    readonly game: 'arena' | 'relic';
    readonly title: string;
    readonly completedMatch: boolean;
}

export async function recoverTournamentFromHistory(input: TournamentHistoryRecoveryInput): Promise<void> {
    const { page, game, title } = input;
    await page.reload();
    if (game === 'arena' && input.completedMatch) {
        const results = page.getByRole('dialog', { name: 'Match results', exact: true });
        await expect(results).toBeVisible();
        await results.getByRole('button', { name: 'Return to tournament bracket', exact: true }).click();
        await expect(results).toHaveCount(0);
    }
    if (game === 'arena') {
        await openArenaOperations(page);
    }
    await panel(page).getByRole('button', { name: 'My tournaments', exact: true }).click();
    const card = panel(page).getByRole('article', { name: `Tournament ${title}`, exact: true });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Open tournament', exact: true }).click();
    await expect(panel(page).getByRole('article', { name: 'Tournament bracket', exact: true })).toContainText(title);
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
        const entry = player.getByRole('region', { name: 'Shared room entry', exact: true });
        const entered = entry.getByText(/^Entered /);
        const previousEntry = await entered.count() === 0 ? null : await entered.innerText();
        await panel(player).getByRole('article', { name: slot, exact: true }).getByRole('button', {
            name: 'Enter tournament match',
            exact: true
        }).click();
        await expect(entered).toBeVisible();
        if (previousEntry !== null) {
            await expect(entered).not.toHaveText(previousEntry);
        }
        await expect(entry.getByRole('alert')).toHaveCount(0);
    }
}

export function tournamentMatch(page: Page, slot: TournamentMatch['slot']) {
    return panel(page).getByRole('article', { name: slot, exact: true });
}

async function registerHunter(page: Page, game: 'arena' | 'relic', index: number): Promise<void> {
    page.setDefaultTimeout(20000);
    const baseURL = test.info().project.use.baseURL;
    if (!baseURL) {
        throw new Error('Tournament journeys require the configured game base URL');
    }
    await page.goto(baseURL);
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
