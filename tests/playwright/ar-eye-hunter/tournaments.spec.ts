import { expect } from '@playwright/test';
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
