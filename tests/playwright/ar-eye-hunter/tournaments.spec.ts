import { expect, test } from '@playwright/test';

import { toError } from '../../../packages/shared/resilience/to-error.ts';

import { installAnimationFrameGate } from '../../../packages/shared-test/install-animation-frame-gate.ts';

import { localStartInput } from '../local-start-input.ts';
import { openArenaOperations, toGroupId } from '../room-player-journey.ts';
import { tournamentBrowserTest } from '../tournament-browser-fixture.ts';
import {
    cancelPlayingTournament,
    registerTournament,
    startTournamentMatch,
    tournamentMatch
} from '../tournament-journey.ts';
import { NativeTapCompletionGate } from './native-tap-completion-gate.ts';
import {
    observeArena,
    playArenaTournament,
    scoreWithTouch
} from './tournament-native-play.ts';

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

tournamentBrowserTest(
    'a queued native canvas shot progresses while animation frames remain paused',
    async ({ page, players }) => {
        tournamentBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the native game server and built SPA.'
        );
        tournamentBrowserTest.setTimeout(180000);
        await page.addInitScript(installAnimationFrameGate);
        await registerTournament(players, 'arena');
        await startTournamentMatch(page, [players[0], players[1]], 'semifinal-1');
        await page.bringToFront();
        const canvas = page.getByLabel('AR Eye Hunter gameplay canvas', { exact: true });
        await expect(canvas).toHaveAttribute('data-arena-runtime-ready', 'true');
        await expect(canvas).toHaveAttribute('data-arena-match-id', /.+/);
        const closeOperations = page.getByRole('button', { name: 'Close Ops', exact: true });
        if (await closeOperations.isVisible()) {
            await closeOperations.click();
        }
        const bounds = await canvas.boundingBox();
        if (!bounds) {
            throw new Error('The visible native gameplay canvas must have a bounding box.');
        }
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point)).toBe('CANVAS');
        const heldInput = Promise.withResolvers<number>();
        const release = Promise.withResolvers<void>();
        let holding = false;
        const inputRoute = '**/api/ar-eye/rooms/*/tournament/inputs/requests/*';
        await page.route(inputRoute, async (route) => {
            const request = route.request();
            const input = request.postDataJSON();
            if (holding || request.method() !== 'POST' || input?.controls?.fire !== false) {
                await route.continue();
                return;
            }
            holding = true;
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            heldInput.resolve(input.sequence);
            await release.promise;
            await route.fulfill({ response });
        });
        try {
            const previousSequence = await heldInput.promise;
            const fired = page.waitForResponse((response) =>
                response.request().method() === 'POST' &&
                /\/tournament\/inputs\/requests\//.test(response.url()) &&
                response.request().postDataJSON()?.controls?.fire === true
            );
            await page.evaluate(() => window.dispatchEvent(new Event('test-pause-animation-frames')));
            await page.touchscreen.tap(point.x, point.y);
            release.resolve();
            const response = await fired;
            expect(response.status()).toBe(200);
            expect(response.request().postDataJSON().sequence).toBeGreaterThan(previousSequence);
            expect(await response.json()).toMatchObject({ status: 'applied' });
        }
        finally {
            release.resolve();
            await page.evaluate(() => window.dispatchEvent(new Event('test-resume-animation-frames')));
            await page.unroute(inputRoute);
            await openArenaOperations(page);
            const bracket = page.getByRole('region', { name: 'Tournaments', exact: true });
            await bracket.getByRole('button', { name: 'Cancel tournament', exact: true }).click();
            await bracket.getByRole('button', { name: 'Confirm cancel tournament', exact: true }).click();
            for (const player of [players[0], players[1]]) {
                const notice = player.getByRole('dialog', { name: 'Tournament match cancelled', exact: true });
                await expect(notice).toBeVisible();
                await notice.getByRole('button', { name: 'Return to tournament bracket', exact: true }).click();
            }
        }
    }
);

for (const completion of ['resolved', 'rejected'] as const) {
    tournamentBrowserTest(
        `observes a native score while tap completion is ${completion}`,
        async ({ page, players }) => {
            tournamentBrowserTest.skip(
                process.env.RALLAR_ARENA_FULL_STACK !== '1',
                'Requires native game server and SPA.'
            );
            tournamentBrowserTest.setTimeout(180000);
            await registerTournament(players, 'arena');
            await startTournamentMatch(page, [players[0], players[1]], 'semifinal-1');
            await page.bringToFront();
            const canvas = page.getByLabel('AR Eye Hunter gameplay canvas', { exact: true });
            await expect(canvas).toHaveAttribute('data-arena-runtime-ready', 'true');
            const closeOperations = page.getByRole('button', { name: 'Close Ops', exact: true });
            if (await closeOperations.isVisible()) {
                await closeOperations.click();
            }
            const roomId = toGroupId(await page.getByLabel('Room link', { exact: true }).inputValue());
            const gate = new NativeTapCompletionGate(page, roomId);
            const completionFailure = new Error('Real tap completion failed after native score');
            const scoring = scoreWithTouch(page, roomId);
            const result = scoring.then(() => null, toError);
            // Hold input completion beyond the unchanged score budget; this is the ordering under test.
            const release = setTimeout(() => {
                if (completion === 'rejected') {
                    gate.release.reject(completionFailure);
                }
                else {
                    gate.release.resolve();
                }
            }, 16000);
            try {
                expect(
                    await Promise.race([
                        gate.held.promise,
                        result.then((outcome) => {
                            throw outcome ?? new Error('Score helper returned before its real tap was held.');
                        })
                    ])
                ).toBeGreaterThan(0);
                const outcome = await result;
                expect(outcome).toBe(completion === 'resolved' ? null : completionFailure);
                expect(gate.maxConcurrent).toBe(1);
                const count = gate.tapCount;
                const observed = await observeArena(page, roomId);
                await expect.poll(async () => (await observeArena(page, roomId)).simulatedAtEpochMs)
                    .toBeGreaterThan(observed.simulatedAtEpochMs + 600);
                expect(gate.tapCount).toBe(count);
            }
            finally {
                clearTimeout(release);
                gate.restore();
                await result;
                await openArenaOperations(page);
                const bracket = page.getByRole('region', { name: 'Tournaments', exact: true });
                await bracket.getByRole('button', { name: 'Cancel tournament', exact: true }).click();
                await bracket.getByRole('button', { name: 'Confirm cancel tournament', exact: true }).click();
            }
        }
    );
}

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
