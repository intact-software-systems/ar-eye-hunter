import { expect } from '@playwright/test';
import { tournamentBrowserTest } from '../tournament-browser-fixture.ts';
import {
    cancelPlayingTournament,
    registerTournament,
    startTournamentMatch,
    tournamentMatch
} from '../tournament-journey.ts';
import { playRelicTournament } from './tournament-native-play.ts';

tournamentBrowserTest(
    'four accounts play both semifinals and a final with native scores and bracket advancement',
    async ({ page, players }) => {
        tournamentBrowserTest.skip(
            process.env.RELIC_HUNTERS_FULL_STACK !== '1',
            'Requires the native game server and SPA.'
        );
        tournamentBrowserTest.setTimeout(600000);
        await registerTournament(players, 'relic');
        const champion = await page.getByRole('region', { name: 'Tournaments', exact: true })
            .locator('ol li').first().innerText();
        for (
            const [slot, winner, opponent] of [
                ['semifinal-1', players[0], players[1]],
                ['semifinal-2', players[2], players[3]],
                ['final', players[0], players[2]]
            ] as const
        ) {
            await startTournamentMatch(page, [winner, opponent], slot);
            await playRelicTournament(winner, opponent);
            const winnerId = await winner.locator('.victory-panel h2').innerText();
            await expect(tournamentMatch(page, slot)).toContainText(`Winner: ${winnerId} · score`, {
                timeout: 30000
            });
        }
        await expect(page.getByRole('status').filter({ hasText: `Champion: ${champion}` })).toBeVisible();
        await page.reload();
        await expect(page.getByRole('status').filter({ hasText: `Champion: ${champion}` })).toBeVisible();
    }
);

tournamentBrowserTest(
    'cancels a playing tournament and returns both competitors to the bracket',
    async ({ players }) => {
        tournamentBrowserTest.skip(
            process.env.RELIC_HUNTERS_FULL_STACK !== '1',
            'Requires the native game server and SPA.'
        );
        tournamentBrowserTest.setTimeout(180000);
        await cancelPlayingTournament(players, 'relic');
    }
);
