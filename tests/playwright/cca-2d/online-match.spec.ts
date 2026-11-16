import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { decodeTownMatchFrame, type TownMatchFrame } from '../../../apps/cca-2d/src/match/match-protocol.ts';
import { decodeALMessage } from '../../../packages/shared/al-contracts/al-message-persistence-validation.ts';

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

async function registerPlayer(page: Page, username: string): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('Local-trial-only-48!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'Create town', exact: true })).toBeVisible({ timeout: 15000 });
}

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
            await survivor.getByRole('button', { name: 'Leave match', exact: true }).click();
            await expect(survivor.getByRole('button', { name: 'Create town', exact: true })).toBeVisible();
        }
        finally {
            await Promise.allSettled([first.close(), second.close()]);
        }
    });
}

test('a stalled authoritative room read cannot prevent the local recovery deadline', async ({ browser }) => {
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
        await alice.route(/\/api\/state\/apps\/cca-2d\/workspaces\/default\/groups\/[^/?]+(?:\?.*)?$/, (route) => {
            if (route.request().method() === 'GET') {
                stalledReads += 1;
                return;
            }
            return route.continue();
        });
        dropMatchMessages = true;
        await expect(alice.locator('#round-status')).toContainText('Waiting for confirmed match state');
        await expect.poll(() => stalledReads).toBeGreaterThan(0);
        await expect(alice.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
            timeout: 12000
        });
        await expect(alice.locator('#round-winners')).toContainText('Confirmed points');
    }
    finally {
        await Promise.allSettled([first.close(), second.close()]);
    }
});

async function startTownMatch(pages: readonly Page[]): Promise<void> {
    for (const [index, page] of pages.entries()) {
        await registerPlayer(page, `cca-player-${index}-${Date.now()}`);
    }
    const alice = pages[0];
    await alice.getByRole('button', { name: 'Create town', exact: true }).click();
    const roomCode = await alice.getByLabel('Room code').inputValue();
    for (const page of pages.slice(1)) {
        await page.getByLabel('Town code').fill(roomCode);
        await page.getByRole('button', { name: 'Join town', exact: true }).click();
    }
    await expect(alice.locator('#roster li')).toHaveCount(pages.length);
    await alice.getByRole('button', { name: 'Host match', exact: true }).click();
    for (const page of pages) {
        await expect(page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await page.getByRole('button', { name: 'Ready', exact: true }).click();
    }
    await alice.getByRole('button', { name: 'Start round', exact: true }).click();
    for (const page of pages) {
        await expect(page.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 15000 });
    }
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

function decodeMatchWire(message: string | Buffer): TownMatchFrame | undefined {
    const envelope = decodeALMessage(String(message)).right;
    if (!envelope || envelope.payload.typeId !== 'cca.match.frame') {
        return undefined;
    }
    const payload: unknown = JSON.parse(envelope.payload.resource);
    return decodeTownMatchFrame(payload).right;
}

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
    const action = frame.action.kind === 'proposal'
        ? { kind: frame.action.kind, digest: frame.action.digest }
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
