import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import type { TownMatchFrame } from '../../../apps/cca-2d/src/match/match-protocol.ts';
import { decodeTownMatchSnapshot } from '../../../apps/cca-2d/src/match/match-snapshot.ts';
import { decodeMatchWire, registerPlayer, startTownMatch } from './match-browser.ts';

interface MatchTrafficFrame {
    readonly player: number;
    readonly direction: 'sent' | 'received';
    readonly payload: string | Buffer;
}

test.use({ actionTimeout: 10000 });

test('appointed director starts a shared round with two independently controlled players', async ({ browser }) => {
    test.setTimeout(90000);
    const first = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const second = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const third = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const charlie = await third.newPage();
    const alice = await first.newPage();
    const bob = await second.newPage();
    try {
        await registerPlayer(alice, `cca-host-${Date.now()}`);
        await registerPlayer(bob, `cca-peer-${Date.now()}`);
        await alice.getByRole('button', { name: 'Create town', exact: true }).click();
        await expect(alice.getByLabel('Room code')).toBeVisible();
        const roomCode = await alice.getByLabel('Room code').inputValue();
        await alice.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await alice.getByLabel('Friend username').pressSequentially('wasd-friend');
        await expect(alice.getByLabel('Friend username')).toHaveValue('wasd-friend');
        await bob.getByLabel('Town code').fill(roomCode);
        await bob.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(alice.locator('#roster li')).toHaveCount(2);
        await expect(bob.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await alice.getByRole('button', { name: 'Ready', exact: true }).click();
        await bob.getByRole('button', { name: 'Ready', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Start round', exact: true })).toBeEnabled();
        const startedAt = Date.now();
        await alice.getByRole('button', { name: 'Start round', exact: true }).click();
        await expect(alice.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 20000 });
        await expect(bob.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 20000 });
        expect(Date.now() - startedAt).toBeLessThan(8000);
        await expect(bob.getByLabel('Movement joystick')).toBeVisible();
        const initial = Number(await bob.locator('#online-game').getAttribute('data-x'));
        await bob.keyboard.down('KeyD');
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-x')))
            .toBeGreaterThan(initial + 1);
        await bob.keyboard.up('KeyD');
        await expect.poll(async () => Number(await alice.locator('#online-game').getAttribute('data-peer-x')))
            .toBeGreaterThan(initial + 1);
        await bob.getByRole('button', { name: 'Dash and drop', exact: true }).click();
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-dashes')))
            .toBeGreaterThan(0);
        await bob.screenshot({ path: test.info().outputPath('online-match-phone.png') });
        await bob.keyboard.down('KeyA');
        await bob.evaluate(() => window.dispatchEvent(new Event('blur')));
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-speed')))
            .toBeLessThan(0.1);
        await registerPlayer(charlie, `cca-late-${Date.now()}`);
        await charlie.getByLabel('Town code').fill(roomCode);
        await charlie.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(charlie.locator('#round-winners')).toContainText('roster changed');
        await charlie.getByRole('button', { name: 'Leave match', exact: true }).click();
        await expect(charlie.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
        await bob.getByRole('button', { name: 'Leave match', exact: true }).click();
        await expect(bob.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
        await expect(alice.locator('#round-winners')).toContainText('roster changed');
        await alice.getByRole('button', { name: 'New round', exact: true }).click();
        await expect(alice.getByRole('button', { name: 'Ready', exact: true })).toBeVisible();
    }
    finally {
        await Promise.allSettled([first.close(), second.close(), third.close()]);
    }
});

for (const departure of ['temporary', 'expired', 'voluntary']) {
    test(`a reopened player browser respects a ${departure} departure`, async ({ browser }) => {
        test.setTimeout(90000);
        const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
        const [alice, bob, carol] = await Promise.all(contexts.map((context) => context.newPage()));
        const traffic: string[] = [];
        let expiredSeatProposed = false;
        alice.on('websocket', (socket) =>
            socket.on('framesent', ({ payload }) => {
                const frame = decodeMatchWire(payload);
                if (frame?.action.kind === 'proposal') {
                    const snapshot = decodeTownMatchSnapshot(frame.action.snapshot).right;
                    expiredSeatProposed ||= snapshot?.seats.some((seat) => seat.status === 'observer') === true;
                }
            }));
        [alice, bob, carol].forEach((page, index) => recordMatchTraffic(page, index, traffic));
        try {
            await startTownMatch([alice, bob, carol]);
            const roomCode = await alice.getByLabel('Room code').inputValue();
            const matchId = await alice.locator('#online-game').getAttribute('data-match-id');
            if (departure === 'voluntary') {
                await carol.getByRole('button', { name: 'Leave town', exact: true }).click();
                await expect(carol.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
            }
            await carol.close();
            await expect(alice.locator('#round-status')).toContainText('2 friends in town', { timeout: 10000 });
            const clock = await alice.locator('#round-clock').textContent();
            await expect.poll(() => alice.locator('#round-clock').textContent()).not.toBe(clock);
            if (departure === 'expired') {
                await expect.poll(() => expiredSeatProposed, { timeout: 16000 }).toBe(true);
            }
            const returned = await contexts[2].newPage();
            recordMatchTraffic(returned, 2, traffic);
            await returned.goto('/');
            await returned.getByRole('button', { name: 'Play with friends' }).click();
            await expect(returned.getByLabel('Town code')).toBeVisible({ timeout: 10000 });
            await returned.getByLabel('Town code').fill(roomCode);
            await returned.getByRole('button', { name: 'Join town', exact: true }).click();
            await expect(returned.locator('#online-game')).toHaveAttribute('data-match-id', matchId!, {
                timeout: 15000
            });
            await expect(returned.locator('#online-game')).toHaveAttribute(
                'data-seat',
                departure === 'temporary' ? 'active' : 'observer'
            );
            await expect(alice.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 10000 });
            if (departure === 'temporary') {
                await expect(returned.locator('#round-status')).toContainText('Dash to make trouble');
                await expect(returned.getByRole('button', { name: 'Dash and drop', exact: true })).toBeEnabled();
            }
            const initialX = Number(await returned.locator('#online-game').getAttribute('data-x'));
            await returned.keyboard.down('KeyD');
            if (departure !== 'temporary') {
                await expect(returned.locator('#round-status')).toContainText('Watching until the next round');
                await expect(returned.getByLabel('Movement joystick')).toBeHidden();
                const before = await returned.locator('#round-clock').textContent();
                await expect.poll(() => returned.locator('#round-clock').textContent()).not.toBe(before);
                expect(Number(await returned.locator('#online-game').getAttribute('data-x'))).toBe(initialX);
            }
            else {
                await expect.poll(async () => Number(await returned.locator('#online-game').getAttribute('data-x')))
                    .toBeGreaterThan(initialX + 1);
            }
            await returned.keyboard.up('KeyD');
            await returned.screenshot({ path: test.info().outputPath('returned-player-phone.png') });
            await expect(bob.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
        }
        finally {
            await writeMatchTraffic(traffic);
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    });
}

for (const outcome of ['active', 'observer', 'solo', 'interrupted-solo'] as const) {
    test(`a disconnected player returns as ${outcome} without reloading the page`, async ({ browser }) => {
        const expires = outcome === 'observer';
        test.setTimeout(90000);
        const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
        const pages = await Promise.all(contexts.map((context) => context.newPage()));
        const [alice, bob, carol] = pages;
        const traffic: string[] = [];
        let offline = false;
        let disconnect: (() => Promise<void>) | undefined;
        let expiredSeatProposed = false;
        let retainedX: number | undefined;
        let withholdCommit = false;
        let latestCommit = 0;
        let unfinishedProposal: number | undefined;
        let unfinishedAcknowledged = false;
        await contexts[2].routeWebSocket(/\/api\/ws\//, async (socket) => {
            traffic.push(JSON.stringify({ at: Date.now(), event: 'socket-attempt', offline }));
            if (offline) {
                await socket.close();
                return;
            }
            const server = socket.connectToServer();
            server.onMessage((message) => {
                const frame = decodeMatchWire(message);
                if (frame?.action.kind === 'commit') {
                    if (withholdCommit) {
                        return;
                    }
                    latestCommit = Math.max(latestCommit, frame.action.proposalSequence);
                }
                if (withholdCommit && frame?.action.kind === 'proposal' && frame.sequence > latestCommit) {
                    unfinishedProposal ??= frame.sequence;
                }
                socket.send(message);
            });
            socket.onMessage((message) => {
                const frame = decodeMatchWire(message);
                if (frame?.action.kind === 'ack' && frame.action.proposalSequence === unfinishedProposal) {
                    unfinishedAcknowledged = true;
                }
                server.send(message);
            });
            disconnect = async () => {
                await Promise.all([socket.close(), server.close()]);
            };
        });
        alice.on('websocket', (socket) =>
            socket.on('framesent', ({ payload }) => {
                const frame = decodeMatchWire(payload);
                if (frame?.action.kind === 'proposal') {
                    const snapshot = decodeTownMatchSnapshot(frame.action.snapshot).right;
                    expiredSeatProposed ||= snapshot?.seats.some((seat) => seat.status === 'observer') === true;
                    const absent = snapshot?.seats.find((seat) => seat.status === 'away');
                    if (absent) {
                        retainedX = snapshot?.players.find((player) => player.id === absent.id)?.x;
                    }
                }
            }));
        pages.forEach((page, index) => recordMatchTraffic(page, index, traffic));
        try {
            await startTownMatch(pages);
            const matchId = await carol.locator('#online-game').getAttribute('data-match-id');
            const dashes = await carol.locator('#online-game').getAttribute('data-dashes');
            expect(disconnect).toBeDefined();
            if (expires) {
                withholdCommit = true;
                await expect.poll(() => unfinishedAcknowledged, { timeout: 5000 }).toBe(true);
            }
            offline = true;
            traffic.push(JSON.stringify({ at: Date.now(), event: 'socket-disconnect' }));
            await disconnect!();
            await expect(alice.locator('#round-status')).toContainText('2 friends in town', { timeout: 10000 });
            await contexts[2].setOffline(true);
            await expect(carol.locator('#round-status')).toContainText('Waiting for confirmed match state', {
                timeout: 5000
            });
            if (outcome === 'solo' || outcome === 'interrupted-solo') {
                if (outcome === 'interrupted-solo') {
                    await expect(carol.getByRole('heading', { name: 'Round interrupted', exact: true }))
                        .toBeVisible({ timeout: 12000 });
                    await expect(carol.locator('#round-winners')).toContainText('Confirmed points');
                }
                await carol.screenshot({ path: test.info().outputPath('offline-exit-phone.png') });
                await carol.getByRole('button', { name: 'Back to solo', exact: true }).click();
                await expect(carol.getByRole('button', { name: 'Play with friends' })).toBeVisible();
                await expect(carol.getByLabel('Movement joystick')).toBeVisible();
                await expect(carol.locator('#online-game')).toHaveCount(0);
                return;
            }
            await carol.keyboard.down('KeyD');
            await carol.keyboard.press('Space');
            if (expires) {
                await expect.poll(() => expiredSeatProposed, { timeout: 16000 }).toBe(true);
            }
            offline = false;
            withholdCommit = false;
            traffic.push(JSON.stringify({ at: Date.now(), event: 'network-restored' }));
            await contexts[2].setOffline(false);
            for (const page of pages) {
                await expect(page.locator('#round-status')).toContainText(
                    expires && page === carol ? 'Watching until the next round' : 'Dash to make trouble',
                    { timeout: 40000 }
                );
                await expect(page.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
                await expect(page.locator('#round-results')).toBeHidden();
            }
            await expect(carol.locator('#online-game')).toHaveAttribute('data-seat', expires ? 'observer' : 'active');
            const resumedX = Number(await carol.locator('#online-game').getAttribute('data-x'));
            expect(retainedX).toBeDefined();
            expect(resumedX).toBe(retainedX);
            const clock = await bob.locator('#round-clock').textContent();
            await expect.poll(() => bob.locator('#round-clock').textContent()).not.toBe(clock);
            expect(Number(await carol.locator('#online-game').getAttribute('data-x'))).toBeCloseTo(resumedX, 1);
            await expect(carol.locator('#online-game')).toHaveAttribute('data-dashes', dashes!);
            await carol.keyboard.up('KeyD');
            if (!expires) {
                await carol.keyboard.down('KeyD');
                await expect.poll(async () => Number(await carol.locator('#online-game').getAttribute('data-x')))
                    .toBeGreaterThan(resumedX + 1);
                await carol.keyboard.up('KeyD');
            }
            await expect(alice.locator('#round-results')).toBeHidden();
        }
        finally {
            await writeMatchTraffic(traffic);
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    });
}

test('a briefly disconnected host settles its outstanding proposal after returning to the same appointment', async ({ browser }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [alice, bob] = pages;
    const traffic: string[] = [];
    let disconnect: (() => Promise<void>) | undefined;
    let sockets = 0;
    let withholdAcknowledgement = false;
    let baselineTick = 0;
    let unfinished: TownMatchFrame | undefined;
    let acknowledgementWithheld = false;
    let resent = false;
    await contexts[0].routeWebSocket(/\/api\/ws\//, (socket) => {
        sockets += 1;
        const server = socket.connectToServer();
        disconnect = async () => {
            await Promise.all([socket.close(), server.close()]);
        };
        socket.onMessage((message) => {
            const frame = decodeMatchWire(message);
            if (frame?.action.kind === 'proposal') {
                const snapshot = decodeTownMatchSnapshot(frame.action.snapshot).right;
                if (withholdAcknowledgement && snapshot && snapshot.tick > baselineTick) {
                    unfinished ??= frame;
                }
                if (sockets > 1 && frame.epoch === unfinished?.epoch && frame.sequence === unfinished.sequence) {
                    resent = true;
                }
            }
            server.send(message);
        });
        server.onMessage((message) => {
            const frame = decodeMatchWire(message);
            if (withholdAcknowledgement && frame?.action.kind === 'ack') {
                acknowledgementWithheld ||= frame.action.proposalSequence === unfinished?.sequence;
                return;
            }
            socket.send(message);
        });
    });
    pages.forEach((page, index) => recordMatchTraffic(page, index, traffic));
    try {
        await startTownMatch(pages);
        const matchId = await alice.locator('#online-game').getAttribute('data-match-id');
        baselineTick = Number(await alice.locator('#online-game').getAttribute('data-tick'));
        for (const context of contexts) {
            await context.route('**/director/appoint/requests/*', (route) => route.abort());
        }
        withholdAcknowledgement = true;
        await expect.poll(() => acknowledgementWithheld).toBe(true);
        expect(disconnect).toBeDefined();
        await disconnect!();
        withholdAcknowledgement = false;
        await expect.poll(() => sockets, { timeout: 10000 }).toBeGreaterThan(1);
        await expect.poll(() => resent, { timeout: 10000 }).toBe(true);
        for (const page of pages) {
            await expect(page.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 10000 });
            await expect(page.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            await expect.poll(async () => Number(await page.locator('#online-game').getAttribute('data-tick')))
                .toBeGreaterThan(baselineTick + 30);
            await expect(page.locator('#round-results')).toBeHidden();
        }
    }
    finally {
        await writeMatchTraffic(traffic);
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});

test('a lost prepared graphics context revokes readiness and leaves a usable exit', async ({ page }) => {
    await registerPlayer(page, `cca-context-${Date.now()}`);
    await page.getByRole('button', { name: 'Create town', exact: true }).click();
    await page.getByRole('button', { name: 'Host match', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Not ready', exact: true })).toBeVisible();
    await page.locator('#online-game canvas').evaluate((canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error('The match canvas is missing.');
        }
        const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!extension) {
            throw new Error('The test browser cannot inject WebGL context loss.');
        }
        extension.loseContext();
    });
    await expect(page.locator('#match-controls')).toContainText('Graphics context lost');
    await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Leave town', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to solo' }).click();
    await expect(page.getByLabel('Movement joystick')).toBeVisible();
});

test('a silent backup pauses confirmed play and resumes without replaying controls', async ({ browser }) => {
    test.setTimeout(60000);
    const first = await browser.newContext();
    const second = await browser.newContext();
    let dropMatchMessages = false;
    let dropped = 0;
    await second.routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
            if (dropMatchMessages && String(message).includes('cca.match.frame')) {
                dropped += 1;
                return;
            }
            server.send(message);
        });
    });
    const alice = await first.newPage();
    const bob = await second.newPage();
    try {
        await startTownMatch([alice, bob]);
        dropMatchMessages = true;
        await expect.poll(() => dropped).toBeGreaterThan(0);
        await expect(alice.locator('#round-status')).toContainText('Waiting for confirmed match state', {
            timeout: 5000
        });
        await expect(bob.locator('#round-status')).toContainText('Waiting for confirmed match state', {
            timeout: 5000
        });
        const clock = await alice.locator('#round-clock').textContent();
        const dashes = await bob.locator('#online-game').getAttribute('data-dashes');
        await bob.keyboard.down('KeyD');
        await bob.keyboard.press('Space');
        await expect(bob.locator('#round-clock')).toHaveText(clock!);
        dropMatchMessages = false;
        await expect(alice.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 5000 });
        await expect(bob.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 5000 });
        const resumedClock = await alice.locator('#round-clock').textContent();
        const resumedX = Number(await bob.locator('#online-game').getAttribute('data-x'));
        await bob.keyboard.down('KeyD');
        await expect.poll(async () => await alice.locator('#round-clock').textContent()).not.toBe(resumedClock);
        expect(Number(await bob.locator('#online-game').getAttribute('data-x'))).toBeCloseTo(resumedX, 1);
        await expect(bob.locator('#online-game')).toHaveAttribute('data-dashes', dashes!);
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-speed')))
            .toBeLessThan(0.1);
        await bob.keyboard.up('KeyD');
        await bob.keyboard.down('KeyD');
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-speed')))
            .toBeGreaterThan(1);
        await bob.keyboard.up('KeyD');
        dropMatchMessages = true;
        await expect(alice.locator('#round-status')).toContainText('Waiting for confirmed match state');
        await expect(alice.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
            timeout: 12000
        });
        await expect(bob.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
            timeout: 12000
        });
        await expect(alice.locator('#round-winners')).toContainText('Confirmed points');
        dropMatchMessages = false;
        await expect(alice.getByRole('button', { name: 'New round', exact: true })).toBeEnabled({ timeout: 5000 });
        await expect(bob.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible();
        await alice.getByRole('button', { name: 'New round', exact: true }).click();
        await expect(bob.getByRole('button', { name: 'Ready', exact: true })).toBeVisible();
    }
    finally {
        await Promise.allSettled([first.close(), second.close()]);
    }
});

for (const fault of ['silent network loss', 'browser suspension'] as const) {
    test(`a host returning from ${fault} preserves a shared interrupted outcome`, async ({ browser }) => {
        test.setTimeout(70000);
        const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
        const pages = await Promise.all(contexts.map((context) => context.newPage()));
        const [alice, bob] = pages;
        const traffic: string[] = [];
        let blackhole = false;
        let discarded = 0;
        await contexts[0].routeWebSocket(/\/api\/ws\//, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
                if (blackhole) {
                    discarded += 1;
                    return;
                }
                server.send(message);
            });
            server.onMessage((message) => {
                if (!blackhole) {
                    socket.send(message);
                }
            });
        });
        await contexts[0].route('**/api/**', (route) => blackhole ? route.abort() : route.continue());
        const lifecycle = await contexts[0].newCDPSession(alice);
        await lifecycle.send('Debugger.enable');
        pages.forEach((page, index) => recordMatchTraffic(page, index, traffic));
        try {
            await startTownMatch(pages);
            const matchId = await bob.locator('#online-game').getAttribute('data-match-id');
            if (fault === 'browser suspension') {
                await lifecycle.send('Debugger.pause');
            }
            else {
                blackhole = true;
                await expect.poll(() => discarded).toBeGreaterThan(0);
            }
            await expect(bob.locator('#round-status')).toContainText('Waiting for confirmed match state', {
                timeout: 6000
            });
            const confirmedScore = await bob.locator('#round-score').textContent();
            const confirmedTick = Number(await bob.locator('#online-game').getAttribute('data-tick'));
            await expect(bob.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
                timeout: 12000
            });
            await expect(bob.locator('#round-score')).toHaveText(confirmedScore!);
            await expect(bob.locator('#online-game')).toHaveAttribute('data-tick', String(confirmedTick));
            blackhole = false;
            if (fault === 'browser suspension') {
                await lifecycle.send('Debugger.resume');
            }
            for (const page of pages) {
                await expect(page.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
                    timeout: 12000
                });
                await expect(page.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
                await expect(page.locator('#online-game')).toHaveAttribute('data-phase', 'interrupted', {
                    timeout: 12000
                });
            }
            await expect(alice.getByRole('button', { name: 'New round', exact: true })).toBeEnabled();
            await alice.getByRole('button', { name: 'New round', exact: true }).click();
            for (const page of pages) {
                await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled();
            }
        }
        finally {
            blackhole = false;
            await lifecycle.send('Debugger.resume').catch(() => {});
            await writeMatchTraffic(traffic);
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    });
}

test('an old host returns as an observer after two survivors appoint a replacement', async ({ browser }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [alice, bob, carol] = pages;
    const traffic: string[] = [];
    let offline = false;
    let disconnect: (() => Promise<void>) | undefined;
    let observerProposed = false;
    await contexts[0].routeWebSocket(/\/api\/ws\//, async (socket) => {
        if (offline) {
            await socket.close();
            return;
        }
        const server = socket.connectToServer();
        disconnect = async () => {
            await Promise.all([socket.close(), server.close()]);
        };
    });
    for (const survivor of [bob, carol]) {
        survivor.on('websocket', (socket) =>
            socket.on('framesent', ({ payload }) => {
                const frame = decodeMatchWire(payload);
                if (frame?.action.kind === 'proposal') {
                    const snapshot = decodeTownMatchSnapshot(frame.action.snapshot).right;
                    observerProposed ||= frame.epoch > 1 &&
                        snapshot?.seats.some((seat) => seat.status === 'observer') === true;
                }
            }));
    }
    pages.forEach((page, index) => recordMatchTraffic(page, index, traffic));
    try {
        await startTownMatch(pages);
        const matchId = await alice.locator('#online-game').getAttribute('data-match-id');
        offline = true;
        expect(disconnect).toBeDefined();
        await disconnect!();
        await expect.poll(() => observerProposed, { timeout: 20000 }).toBe(true);
        for (const survivor of [bob, carol]) {
            await expect(survivor.locator('#round-status')).toContainText('Dash to make trouble');
        }
        offline = false;
        await expect(alice.locator('#round-status')).toContainText('Watching until the next round', { timeout: 40000 });
        await expect(alice.locator('#online-game')).toHaveAttribute('data-director', 'false');
        await expect(alice.locator('#online-game')).toHaveAttribute('data-seat', 'observer');
        const returningX = await alice.locator('#online-game').getAttribute('data-x');
        const returningDashes = await alice.locator('#online-game').getAttribute('data-dashes');
        const clock = await bob.locator('#round-clock').textContent();
        await alice.keyboard.down('KeyD');
        await alice.keyboard.press('Space');
        await expect.poll(() => bob.locator('#round-clock').textContent()).not.toBe(clock);
        await expect(alice.locator('#online-game')).toHaveAttribute('data-x', returningX!);
        await expect(alice.locator('#online-game')).toHaveAttribute('data-dashes', returningDashes!);
        await alice.keyboard.up('KeyD');
        for (const page of pages) {
            await expect(page.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            await expect(page.locator('#round-results')).toBeHidden();
        }
        await expect.poll(async () =>
            (await Promise.all(pages.map((page) => page.locator('#online-game').getAttribute('data-director'))))
                .filter((value) => value === 'true').length
        ).toBe(1);
    }
    finally {
        await writeMatchTraffic(traffic);
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});

test('two surviving players continue the same round after the appointed host closes', async ({ browser }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [alice, bob, carol] = pages;
    const traffic: string[] = [];
    pages.forEach((page, index) => recordMatchTraffic(page, index, traffic));
    let armed = false;
    let minimumTick = 0;
    let heldTick = 0;
    let heldSequence = 0;
    let heldEpoch = 0;
    let highestProposalSequence = 0;
    let dropped = 0;
    await contexts[0].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage(async (message) => {
            const frame = decodeMatchWire(message);
            const fresh = frame?.action.kind === 'proposal' && frame.sequence > highestProposalSequence;
            if (frame?.action.kind === 'proposal') {
                highestProposalSequence = Math.max(highestProposalSequence, frame.sequence);
            }
            if (armed && fresh && frame?.action.kind === 'proposal') {
                const snapshot: unknown = JSON.parse(frame.action.snapshot);
                if (
                    snapshot && typeof snapshot === 'object' && 'tick' in snapshot &&
                    typeof snapshot.tick === 'number' && snapshot.tick > minimumTick
                ) {
                    armed = false;
                    heldTick = snapshot.tick;
                    heldSequence = frame.sequence;
                    heldEpoch = frame.epoch;
                    await holdNextDigest(alice);
                }
            }
            server.send(message);
        });
    });
    await contexts[1].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
            const frame = decodeMatchWire(message);
            if (
                frame?.epoch === heldEpoch && frame.action.kind === 'commit' &&
                frame.action.proposalSequence === heldSequence
            ) {
                dropped += 1;
                return;
            }
            socket.send(message);
        });
    });
    try {
        await startTownMatch(pages);
        const matchId = await bob.locator('#online-game').getAttribute('data-match-id');
        const clock = Number((await bob.locator('#round-clock').textContent())?.replace('s', ''));
        minimumTick = Number(await bob.locator('#online-game').getAttribute('data-tick'));
        armed = true;
        await expect.poll(() => dropped).toBeGreaterThan(0);
        await expect(carol.locator('#online-game')).toHaveAttribute('data-tick', String(heldTick));
        expect(Number(await bob.locator('#online-game').getAttribute('data-tick'))).toBeLessThan(heldTick);
        await contexts[0].close();
        await expect(bob.locator('#round-status')).toContainText('Waiting for confirmed match state', {
            timeout: 5000
        });
        await expect(bob.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 12000 });
        await expect(carol.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 12000 });
        await expect.poll(async () => Number((await bob.locator('#round-clock').textContent())?.replace('s', '')))
            .toBeLessThan(clock);
        await expect(bob.locator('#round-results')).toBeHidden();
        await expect(bob.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
        await expect(carol.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
        await expect.poll(async () =>
            (await Promise.all([bob, carol].map((page) => page.locator('#online-game').getAttribute('data-director'))))
                .filter((value) => value === 'true').length
        ).toBe(1);
        const before = Number(await bob.locator('#online-game').getAttribute('data-x'));
        await bob.keyboard.down('KeyD');
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-x')))
            .toBeGreaterThan(before + 1);
        await bob.keyboard.up('KeyD');
        await expect.poll(async () => Number(await carol.locator('#online-game').getAttribute('data-peer-x')))
            .toBeGreaterThan(before + 1);
    }
    finally {
        await writeMatchTraffic(traffic);
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});

for (const lostPlayer of ['host', 'backup'] as const) {
    test(`losing the only ${lostPlayer} interrupts after the recovery window and preserves confirmed state`, async ({ browser }) => {
        test.setTimeout(60000);
        const first = await browser.newContext();
        const second = await browser.newContext();
        const alice = await first.newPage();
        const bob = await second.newPage();
        try {
            await startTownMatch([alice, bob]);
            const survivor = lostPlayer === 'host' ? bob : alice;
            await (lostPlayer === 'host' ? first : second).close();
            await expect(survivor.locator('#round-status')).toContainText('Waiting for confirmed match state');
            const pausedAt = Date.now();
            const clock = await survivor.locator('#round-clock').textContent();
            const score = await survivor.locator('#round-score').textContent();
            await expect(survivor.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
                timeout: 12000
            });
            expect(Date.now() - pausedAt).toBeGreaterThan(8500);
            await expect(survivor.locator('#round-clock')).toHaveText(clock!);
            await expect(survivor.locator('#round-score')).toHaveText(score!);
            await survivor.getByRole('button', { name: 'Back to solo', exact: true }).click();
            await expect(survivor.getByRole('button', { name: 'Play with friends' })).toBeVisible();
        }
        finally {
            await Promise.allSettled([first.close(), second.close()]);
        }
    });
}

for (const roomRead of ['stalled', 'missing'] as const) {
    test(`a ${roomRead} authoritative room read cannot prevent the local recovery deadline`, async ({ browser }) => {
        test.setTimeout(60000);
        const first = await browser.newContext();
        const second = await browser.newContext();
        let dropMatchMessages = false;
        let stalledReads = 0;
        await second.routeWebSocket(/\/api\/ws\//, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
                if (!dropMatchMessages || !String(message).includes('cca.match.frame')) {
                    server.send(message);
                }
            });
        });
        const alice = await first.newPage();
        const bob = await second.newPage();
        try {
            await startTownMatch([alice, bob]);
            await alice.route(
                /\/api\/state\/apps\/cca-2d\/workspaces\/default\/groups\/[^/?]+(?:\?.*)?$/,
                async (route) => {
                    if (route.request().method() === 'GET') {
                        stalledReads += 1;
                        if (roomRead === 'missing') {
                            await route.fulfill({ status: 404, json: { error: 'Room not found' } });
                        }
                        return;
                    }
                    return route.continue();
                }
            );
            dropMatchMessages = true;
            await expect(alice.locator('#round-status')).toContainText('Waiting for confirmed match state');
            await expect.poll(() => stalledReads).toBeGreaterThan(0);
            await expect(alice.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
                timeout: 12000
            });
            await expect(alice.locator('#round-winners')).toContainText('Confirmed points');
            await alice.getByRole('button', { name: 'Back to solo', exact: true }).click();
            await expect(alice.getByRole('button', { name: 'Play with friends' })).toBeVisible();
        }
        finally {
            await Promise.allSettled([first.close(), second.close()]);
        }
    });
}

test('a missed commit settles when a newcomer arrives before the next checkpoint is ready', async ({ browser }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const [alice, bob, charlie] = await Promise.all(contexts.map((context) => context.newPage()));
    const traffic: string[] = [];
    [alice, bob, charlie].forEach((page, index) => recordMatchTraffic(page, index, traffic));
    let armed = false;
    let delayedSequence: number | undefined;
    let highestProposalSequence = 0;
    let dropCommit = true;
    let dropped = 0;
    await contexts[0].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage(async (message) => {
            const frame = decodeMatchWire(message);
            const fresh = frame?.action.kind === 'proposal' && frame.sequence > highestProposalSequence;
            if (frame?.action.kind === 'proposal') {
                highestProposalSequence = Math.max(highestProposalSequence, frame.sequence);
            }
            if (armed && fresh && frame?.action.kind === 'proposal') {
                armed = false;
                delayedSequence = frame.sequence;
                await holdNextDigest(alice);
            }
            server.send(message);
        });
    });
    await contexts[1].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
            const frame = decodeMatchWire(message);
            if (dropCommit && frame?.action.kind === 'commit' && frame.action.proposalSequence === delayedSequence) {
                dropped += 1;
                return;
            }
            socket.send(message);
        });
    });
    try {
        await registerPlayer(charlie, `cca-commit-newcomer-${Date.now()}`);
        await startTownMatch([alice, bob]);
        const roomCode = await alice.getByLabel('Room code').inputValue();
        armed = true;
        await expect.poll(() => dropped).toBeGreaterThan(0);
        await charlie.getByLabel('Town code').fill(roomCode);
        await charlie.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(alice.locator('#roster li')).toHaveCount(3);
        dropCommit = false;
        await alice.evaluate(() => window.dispatchEvent(new Event('cca-release-digest')));
        for (const page of [alice, bob, charlie]) {
            await expect(page.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
                timeout: 5000
            });
            await expect(page.locator('#round-winners')).toContainText('roster changed');
        }
        await alice.getByRole('button', { name: 'New round', exact: true }).click();
        for (const page of [alice, bob, charlie]) {
            await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled();
        }
    }
    finally {
        await writeMatchTraffic(traffic);
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});

async function holdNextDigest(page: Page): Promise<void> {
    await page.evaluate(() => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const released = new Promise<void>((resolve) => {
            window.addEventListener('cca-release-digest', () => resolve(), { once: true });
        });
        crypto.subtle.digest = async (algorithm, data) => {
            crypto.subtle.digest = digest;
            await released;
            return digest(algorithm, data);
        };
    });
}

function recordMatchTraffic(page: Page, player: number, traffic: string[]): void {
    page.on('websocket', (socket) => {
        socket.on('framesent', ({ payload }) => recordMatchFrame({ player, direction: 'sent', payload }, traffic));
        socket.on(
            'framereceived',
            ({ payload }) => recordMatchFrame({ player, direction: 'received', payload }, traffic)
        );
    });
}

function recordMatchFrame(input: MatchTrafficFrame, traffic: string[]): void {
    const frame = decodeMatchWire(input.payload);
    if (!frame || frame.action.kind === 'controls') {
        return;
    }
    const snapshot = frame.action.kind === 'proposal' ? decodeTownMatchSnapshot(frame.action.snapshot) : undefined;
    const action = frame.action.kind === 'proposal'
        ? {
            kind: frame.action.kind,
            digest: frame.action.digest,
            phase: snapshot?.right?.phase,
            tick: snapshot?.right?.tick,
            members: snapshot?.right?.members,
            seats: snapshot?.right?.seats,
            issues: snapshot?.left
        }
        : frame.action;
    traffic.push(
        JSON.stringify({
            at: Date.now(),
            player: input.player,
            direction: input.direction,
            epoch: frame.epoch,
            sequence: frame.sequence,
            action
        })
    );
}

async function writeMatchTraffic(traffic: readonly string[]): Promise<void> {
    const path = test.info().outputPath('match-traffic.jsonl');
    await writeFile(path, traffic.join('\n'));
    await test.info().attach('match-traffic', { path, contentType: 'application/x-ndjson' });
}
