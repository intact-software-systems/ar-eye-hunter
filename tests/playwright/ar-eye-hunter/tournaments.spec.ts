import { expect, test } from '@playwright/test';
import { localStartInput } from '../local-start-input.ts';
import { tournamentBrowserTest } from '../tournament-browser-fixture.ts';
import {
    cancelPlayingTournament,
    registerTournament,
    startTournamentMatch,
    tournamentMatch
} from '../tournament-journey.ts';
import { playArenaTournament } from './tournament-native-play.ts';

tournamentBrowserTest.use({ hasTouch: true });

tournamentBrowserTest(
    'four accounts play a server-scored arena tournament through both semifinals and the final',
    async ({ page, players }) => {
        tournamentBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the native game server and built SPA.'
        );
        tournamentBrowserTest.setTimeout(600000);
        await registerTournament(players, 'arena');
        const entrants = await page.getByRole('region', { name: 'Tournaments', exact: true })
            .locator('ol li').allTextContents();
        for (
            const [slot, winner, opponent, winnerId] of [
                ['semifinal-1', players[0], players[1], entrants[0]],
                ['semifinal-2', players[2], players[3], entrants[2]],
                ['final', players[0], players[2], entrants[0]]
            ] as const
        ) {
            await startTournamentMatch(page, [winner, opponent], slot);
            await playArenaTournament(winner, opponent);
            await expect(tournamentMatch(page, slot)).toContainText(`Winner: ${winnerId} · score`, {
                timeout: 30000
            });
        }
        await expect(page.getByRole('status').filter({ hasText: `Champion: ${entrants[0]}` })).toBeVisible();
    }
);

tournamentBrowserTest(
    'cancels a playing tournament and returns both competitors to the bracket',
    async ({ players }) => {
        tournamentBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the native game server and SPA.'
        );
        tournamentBrowserTest.setTimeout(180000);
        await cancelPlayingTournament(players, 'arena');
    }
);

/** The native input normalizes zero seconds; the shared journey must supply that canonical value. */
test('tournament scheduling accepts whole-minute and second-precision browser-local input', async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: 'Europe/Oslo' });
    try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date('2030-01-02T10:59:55Z'));
        await page.setContent('<label>Match start<input type="datetime-local" step="1"></label>');
        for (const [delay, expected] of [[5000, '2030-01-02T12:00'], [6000, '2030-01-02T12:00:01']] as const) {
            const start = await localStartInput(page, delay);
            await page.getByLabel('Match start').fill(start.input);
            await expect(page.getByLabel('Match start')).toHaveValue(expected);
        }
    }
    finally {
        await context.close();
    }
});
