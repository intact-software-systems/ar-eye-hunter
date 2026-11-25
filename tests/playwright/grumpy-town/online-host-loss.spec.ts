import { type Browser, expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { SOCKET_CLOCK_REPLY_PREFIX, socketClockRequest } from '../../../packages/shared/websocket/socket-clock.ts';

import { decodeTownMatchSnapshot } from '../../../apps/grumpy-town/src/match/agreement/match-snapshot.ts';
import { decodeMatchWire, startTownMatch } from './match-browser.ts';

test('two survivors replace a silently unreachable host and fence its return', ({ browser }) =>
    restoreHost(browser, false));

test('a player rejoins the same round after a total outage retires its clock', ({ browser }) =>
    restoreHost(browser, true));

async function restoreHost(browser: Browser, fullOutage: boolean): Promise<void> {
    test.setTimeout(90000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [alice, bob, carol] = pages;
    const epochs: number[] = [];
    const graceByProposal = new Map<string, number>();
    let offline = false;
    let discarded = 0;
    let closes = 0;
    let connections = 0;
    let hostEpoch = 0;
    let recoveryElapsedMs = 0;
    await contexts[0].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
            // Clock retirement intentionally closes the socket. Exercise room lease loss on a live socket.
            if (offline && (fullOutage || !(typeof message === 'string' && message.startsWith(socketClockRequest(''))))) {
                discarded += 1;
            }
            else {
                server.send(message);
            }
        });
        server.onMessage((message) => {
            if (!offline || (!fullOutage && typeof message === 'string' && message.startsWith(SOCKET_CLOCK_REPLY_PREFIX))) {
                socket.send(message);
            }
        });
    });
    await contexts[0].route('**/api/**', (route) => offline ? route.abort() : route.continue());
    alice.on('websocket', (socket) => {
        if (!/\/api\/ws\//.test(socket.url())) return;
        connections += 1;
        socket.on('close', () => closes += 1);
        socket.on('framesent', ({ payload }) => {
            const frame = decodeMatchWire(payload);
            if (frame?.action.kind === 'proposal' && !offline) {
                hostEpoch = frame.epoch;
            }
        });
    });
    for (const survivor of [bob, carol]) {
        survivor.on('websocket', (socket) =>
            socket.on('framesent', ({ payload }) => {
                const frame = decodeMatchWire(payload);
                if (frame?.action.kind !== 'proposal') {
                    return;
                }
                if (!epochs.includes(frame.epoch)) {
                    epochs.push(frame.epoch);
                }
                if (offline && frame.epoch > hostEpoch) {
                    const match = decodeTownMatchSnapshot(frame.action.snapshot).right;
                    const away = match?.seats.find((seat) => seat.status === 'away');
                    if (away) {
                        graceByProposal.set(frame.action.digest, away.expiresAtEpochMs);
                    }
                }
            }));
    }
    try {
        await startTownMatch(pages);
        await expect(bob.getByRole('button', { name: 'Extend by 1 minute' })).toBeHidden();
        await alice.getByRole('button', { name: 'Extend by 1 minute' }).click();
        for (const page of pages) {
            await expect.poll(async () => parseInt(await page.locator('#round-clock').innerText())).toBeGreaterThan(
                220
            );
        }
        const matchId = await alice.locator('#online-game').getAttribute('data-match-id');
        const score = await bob.locator('#round-score').textContent();
        const originalEpoch = hostEpoch;
        expect(originalEpoch).toBeGreaterThan(0);
        const partitionedAt = Date.now();
        offline = true;
        await expect.poll(() => discarded).toBeGreaterThan(0);
        await expect(bob.locator('#round-status')).toContainText('Waiting for confirmed match state');
        const confirmedTick = Number(await bob.locator('#online-game').getAttribute('data-tick'));
        await expect.poll(() => epochs.some((epoch) => epoch > originalEpoch), { timeout: 14000 }).toBe(true);
        for (const survivor of [bob, carol]) {
            await expect(survivor.locator('#round-status')).toContainText('Dash to make trouble');
            await expect(survivor.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            await expect(survivor.locator('#round-score')).toHaveText(score!);
            await expect.poll(async () => Number(await survivor.locator('#online-game').getAttribute('data-tick')))
                .toBeGreaterThan(confirmedTick);
        }
        recoveryElapsedMs = Date.now() - partitionedAt;
        const director = await bob.locator('#online-game').getAttribute('data-director') === 'true' ? bob : carol;
        for (const survivor of [bob, carol]) {
            const remaining = parseInt(await survivor.locator('#round-clock').innerText());
            expect(remaining).toBeGreaterThan(210);
            expect(remaining).toBeLessThanOrEqual(240);
        }
        await director.getByRole('button', { name: 'Extend by 1 minute' }).click();
        for (const survivor of [bob, carol]) {
            await expect.poll(async () => parseInt(await survivor.locator('#round-clock').innerText())).toBeGreaterThan(
                270
            );
        }
        expect(recoveryElapsedMs).toBeLessThan(11500);
        if (!fullOutage) {
            expect(closes).toBe(0);
            await expect(alice.locator('#round-results')).toBeVisible();
        }
        await expect.poll(() => graceByProposal.size).toBeGreaterThan(1);
        const deadlines = [...new Set(graceByProposal.values())];
        expect(deadlines).toHaveLength(1);
        expect(deadlines[0]).toBeGreaterThanOrEqual(partitionedAt + 10_000);
        if (fullOutage) await expect.poll(() => closes, { timeout: 40_000 }).toBeGreaterThan(0);
        offline = false;
        await expect(alice.locator('#online-game')).toHaveAttribute('data-director', 'false', { timeout: 15000 });
        await expect(alice.locator('#online-game')).toHaveAttribute('data-seat', fullOutage ? /^(active|observer)$/ : 'active');
        await expect(alice.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
        for (const page of pages) {
            await expect(page.locator('#round-results')).toBeHidden();
            const observer = await page.locator('#online-game').getAttribute('data-seat') === 'observer';
            await expect(page.locator('#round-status')).toContainText(observer ? 'Watching until the next round' : 'Dash to make trouble');
        }
        await expect.poll(async () =>
            (await Promise.all(pages.map((page) => page.locator('#online-game').getAttribute('data-director'))))
                .filter((value) => value === 'true').length
        ).toBe(1);
        const before = Number(await bob.locator('#online-game').getAttribute('data-x'));
        await bob.keyboard.down('KeyD');
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-x')))
            .toBeGreaterThan(before + 1);
        await bob.keyboard.up('KeyD');
        const tick = await alice.locator('#online-game').getAttribute('data-tick');
        await expect.poll(() => alice.locator('#online-game').getAttribute('data-tick')).not.toBe(tick);
        if (fullOutage) {
            expect(connections).toBeGreaterThan(1);
            if (await alice.locator('#online-game').getAttribute('data-seat') === 'observer') return;
        }
        const returnedX = Number(await alice.locator('#online-game').getAttribute('data-x'));
        await alice.keyboard.down('KeyA');
        await expect.poll(async () => Number(await alice.locator('#online-game').getAttribute('data-x')))
            .toBeLessThan(returnedX - 1);
        await alice.keyboard.up('KeyA');
        if (!fullOutage) expect(closes).toBe(0);
    }
    finally {
        try {
            const views = await Promise.all(pages.map((page) =>
                page.evaluate(() => {
                    const game = document.querySelector('#online-game');
                    return {
                        phase: game?.getAttribute('data-phase') ?? null,
                        director: game?.getAttribute('data-director') ?? null,
                        tick: game?.getAttribute('data-tick') ?? null,
                        seat: game?.getAttribute('data-seat') ?? null,
                        status: document.querySelector('#round-status')?.textContent,
                        results: document.querySelector('#round-winners')?.textContent
                    };
                })
            ));
            const path = test.info().outputPath('silent-host-loss.json');
            await writeFile(path, JSON.stringify({ discarded, closes, epochs, recoveryElapsedMs, views }));
            await test.info().attach('silent-host-loss', { path, contentType: 'application/json' });
        }
        finally {
            offline = false;
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    }
}
