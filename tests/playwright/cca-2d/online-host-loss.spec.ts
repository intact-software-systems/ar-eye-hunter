import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { decodeMatchWire, startTownMatch } from './match-browser.ts';

test('two survivors replace a silently unreachable host and fence its return', async ({ browser }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [alice, bob, carol] = pages;
    const epochs: number[] = [];
    let offline = false;
    let discarded = 0;
    let closes = 0;
    let hostEpoch = 0;
    await contexts[0].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
            if (offline) {
                discarded += 1;
            }
            else {
                server.send(message);
            }
        });
        server.onMessage((message) => {
            if (!offline) {
                socket.send(message);
            }
        });
    });
    await contexts[0].route('**/api/**', (route) => offline ? route.abort() : route.continue());
    alice.on('websocket', (socket) => {
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
                if (frame?.action.kind === 'proposal' && !epochs.includes(frame.epoch)) {
                    epochs.push(frame.epoch);
                }
            }));
    }
    try {
        await startTownMatch(pages);
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
        expect(Date.now() - partitionedAt).toBeLessThan(11500);
        expect(closes).toBe(0);
        offline = false;
        await expect(alice.locator('#online-game')).toHaveAttribute('data-director', 'false', { timeout: 15000 });
        await expect(alice.locator('#online-game')).toHaveAttribute('data-seat', 'active');
        await expect(alice.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
        for (const page of pages) {
            await expect(page.locator('#round-results')).toBeHidden();
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
        const returnedX = Number(await alice.locator('#online-game').getAttribute('data-x'));
        await alice.keyboard.down('KeyA');
        await expect.poll(async () => Number(await alice.locator('#online-game').getAttribute('data-x')))
            .toBeLessThan(returnedX - 1);
        await alice.keyboard.up('KeyA');
        expect(closes).toBe(0);
    }
    finally {
        try {
            const views = await Promise.all(pages.map((page) =>
                page.locator('#online-game').evaluate((element) => ({
                    phase: element.getAttribute('data-phase'),
                    director: element.getAttribute('data-director'),
                    tick: element.getAttribute('data-tick'),
                    seat: element.getAttribute('data-seat'),
                    status: element.querySelector('#round-status')?.textContent,
                    results: element.querySelector('#round-winners')?.textContent
                }))
            ));
            const path = test.info().outputPath('silent-host-loss.json');
            await writeFile(path, JSON.stringify({ discarded, closes, epochs, views }));
            await test.info().attach('silent-host-loss', { path, contentType: 'application/json' });
        }
        finally {
            offline = false;
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    }
});
