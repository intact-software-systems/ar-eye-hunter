import { expect, test } from '@playwright/test';

import { decodeArenaTournamentSnapshot } from '../../../packages/ar-eye-hunter/arena-tournament-snapshot.ts';
import { createTournamentArena, type TournamentArena } from '../../../packages/ar-eye-hunter/tournament-arena.ts';
import { installAnimationFrameGate } from '../../../packages/shared-test/install-animation-frame-gate.ts';
import { toError } from '../../../packages/shared/resilience/to-error.ts';

import { localStartInput } from '../local-start-input.ts';
import { openArenaOperations, toGroupId } from '../room-player-journey.ts';
import { RoomSocketInterruption } from '../room-socket-interruption.ts';
import { tournamentBrowserTest } from '../tournament-browser-fixture.ts';
import {
    cancelPlayingTournament,
    recoverTournamentFromHistory,
    registerTournament,
    startTournamentMatch,
    tournamentMatch
} from '../tournament-journey.ts';
import { TournamentFrameObserver } from './tournament-frame-observer.ts';
import { observeArenaScore, playArenaTournament, tapVisibleTarget } from './tournament-native-play.ts';

tournamentBrowserTest.use({ hasTouch: true });

tournamentBrowserTest(
    'four accounts play a server-scored arena tournament through both semifinals and the final',
    async ({ page, players }) => {
        tournamentBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the native game server and built SPA.'
        );
        tournamentBrowserTest.setTimeout(600000);
        const spectatorConnection = await RoomSocketInterruption.install(players[2]);
        const observers = new Map(players.map((player) => [player, new TournamentFrameObserver(player)]));
        const title = await registerTournament(players, 'arena');
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
            if (slot === 'semifinal-1') {
                const watcher = players[2];
                await tournamentMatch(watcher, slot).getByRole('button', {
                    name: 'Watch tournament match',
                    exact: true
                }).click();
                await expect(
                    watcher.getByRole('region', { name: 'Shared room entry', exact: true }).getByText(/^Entered /)
                ).toBeVisible();
                await expect(watcher.getByLabel('AR Eye Hunter gameplay canvas', { exact: true })).toHaveAttribute(
                    'data-arena-match-id',
                    /.+/
                );
                const roomId = toGroupId(await winner.getByLabel('Room link', { exact: true }).inputValue());
                await spectatorConnection.disconnect();
                const read = watcher.waitForResponse((response) =>
                    response.request().method() === 'GET' &&
                    new URL(response.url()).pathname === `/api/ar-eye/rooms/${encodeURIComponent(roomId)}/tournament` &&
                    response.ok()
                );
                await spectatorConnection.reconnect();
                const snapshot = decodeArenaTournamentSnapshot(await (await read).json());
                expect(snapshot.binding.roomRef.groupId).toBe(roomId);
                const frames = observers.get(watcher);
                if (!frames) {
                    throw new Error('Expected to observe the spectator connection');
                }
                await frames.playing(roomId);
            }
            await playArenaTournament(winner, opponent, observers);
            if (slot === 'semifinal-1') {
                const results = players[2].getByRole('dialog', { name: 'Match results', exact: true });
                await expect(results).toBeVisible();
                await results.getByRole('button', { name: 'Return to tournament bracket', exact: true }).click();
                await expect(results).toHaveCount(0);
            }
            await expect(tournamentMatch(page, slot)).toContainText(`Winner: ${winnerId} · score`, {
                timeout: 30000
            });
        }
        await expect(page.getByRole('status').filter({ hasText: `Champion: ${entrants[0]}` })).toBeVisible();
        await recoverTournamentFromHistory({ page, game: 'arena', title, completedMatch: true });
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
    test(`arena score helper observes during pending input and drains ${completion} completion`, async () => {
        const initial = createTournamentArena({
            gameId: 'score-helper',
            principalIds: ['alice', 'bob'],
            seed: 7,
            startedAtEpochMs: 1000,
            durationMs: 60000
        });
        // Controlled readback proves helper ordering only; real native scoring stays in the four journeys.
        const positive = {
            ...initial,
            players: initial.players.map((player) => ({
                ...player,
                simulation: { ...player.simulation, combat: { ...player.simulation.combat, score: 1 } }
            })),
            arena: {
                ...initial.arena,
                players: initial.arena.players.map((player) => ({
                    ...player,
                    score: 1
                }))
            }
        };
        let published = initial;
        let zeroReadsWhilePending = 0;
        let inputPending = false;
        let tapCount = 0;
        let completed = false;
        const started = Promise.withResolvers<() => boolean>();
        const observedPositive = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const completionFailure = new Error('Scoring input completion failed');
        const result = observeArenaScore({
            observe: async () => {
                if (inputPending && published.players[0].simulation.combat.score === 0) {
                    zeroReadsWhilePending++;
                }
                if (published.players[0].simulation.combat.score === 1) {
                    observedPositive.resolve();
                }
                return published;
            },
            tap: async (_state, isActive) => {
                tapCount++;
                inputPending = true;
                started.resolve(isActive);
                try {
                    await release.promise;
                }
                finally {
                    inputPending = false;
                }
            }
        }).then(() => null, toError).then((outcome) => {
            completed = true;
            return outcome;
        });
        try {
            const isActive = await started.promise;
            await expect.poll(() => zeroReadsWhilePending).toBeGreaterThanOrEqual(2);
            expect(tapCount).toBe(1);
            published = positive;
            await observedPositive.promise;
            await expect.poll(isActive).toBe(false);
            expect(inputPending).toBe(true);
            expect(completed).toBe(false);
            if (completion === 'rejected') {
                release.reject(completionFailure);
            }
            else {
                release.resolve();
            }
            expect(await result).toBe(completion === 'resolved' ? null : completionFailure);
            expect(tapCount).toBe(1);
            expect(inputPending).toBe(false);
        }
        finally {
            published = positive;
            release.resolve();
            await result;
        }
    });
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

// This controlled canvas checks target selection; the native bracket journey proves actual scoring.
test('native aiming chooses the nearest clear canvas target instead of storage order', async ({ browser }) => {
    const viewport = { width: 1280, height: 720 };
    const context = await browser.newContext({ hasTouch: true, viewport });
    try {
        const page = await context.newPage();
        await page.setContent(`
            <canvas style="position:fixed;inset:0;width:100%;height:100%"></canvas>
            <aside style="position:fixed;inset:0 auto 0 0;width:500px">Room controls</aside>
            <output aria-label="Touch position"></output>
        `);
        await page.evaluate(() => {
            document.querySelector('canvas')!.addEventListener('pointerdown', (event) => {
                document.querySelector('output')!.textContent = String(event.clientX);
            });
        });
        const initial = createTournamentArena({
            gameId: 'native-aim-selection',
            principalIds: ['alice', 'bob'],
            seed: 7,
            startedAtEpochMs: 1000,
            durationMs: 60000
        });
        const state: TournamentArena = {
            ...initial,
            arena: {
                ...initial.arena,
                layout: { ...initial.arena.layout, props: [] },
                targets: [
                    { ...initial.arena.targets[0], id: 'far-first', position: [-35, 1.72, 35] },
                    { ...initial.arena.targets[0], id: 'near-clear', position: [-46, 1.72, -35] },
                    { ...initial.arena.targets[0], id: 'near-covered', position: [-47, 1.72, -40] }
                ]
            }
        };
        await tapVisibleTarget({ page, state, viewport, isActive: () => true });
        const x = Number(await page.getByLabel('Touch position').textContent());
        expect(x).toBeGreaterThan(560);
        expect(x).toBeLessThan(580);
    }
    finally {
        await context.close();
    }
});
