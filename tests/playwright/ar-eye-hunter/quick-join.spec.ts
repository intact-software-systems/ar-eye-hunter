import {
    expect,
    type Locator,
    type Page
} from '@playwright/test';

import type { GroupSnapshot } from '../../../packages/shared/api/group-types.ts';

import { roomBrowserTest } from '../room-browser-fixture.ts';

roomBrowserTest(
    'Quick Join recovers from an unavailable API and enters a replacement arena',
    async ({ page: alice, guest: bob }, testInfo) => {
        roomBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the local API-v1 memory fixture on port 8080.'
        );
        await alice.addInitScript(installArenaWebGlObservation);
        await bob.addInitScript(installArenaWebGlObservation);
        const bobOperations = await signIn(bob, 'bob');
        await bob.route(
            '**/groups/quick-join/requests/*',
            (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
        );
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        await expect(bobOperations.getByRole('status')).toContainText('404 Not Found');
        await expect(bobOperations.getByRole('button', { name: 'Quick Join', exact: true })).toBeEnabled();
        await expect(bobOperations.locator('.room-row.active')).toHaveCount(0);
        await bob.unroute('**/groups/quick-join/requests/*');
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        await expect(bobOperations.getByRole('status')).toHaveText('No available arena. Try again or create one.');
        await expect(bobOperations.getByRole('button', { name: 'New Arena', exact: true })).toBeEnabled();
        await bob.screenshot({ path: testInfo.outputPath('quick-join-unavailable.png'), fullPage: true });

        const aliceOperations = await signIn(alice, 'alice');
        const created = alice.waitForResponse((response) =>
            response.request().method() === 'POST' &&
            /\/groups\/requests\//.test(response.url())
        );
        await aliceOperations.getByRole('button', { name: 'New Arena', exact: true }).click();
        const snapshot: GroupSnapshot = await (await created).json();
        await expect(aliceOperations.locator('.room-row.active')).toContainText(snapshot.group.displayName);

        const admitted = bob.waitForResponse((response) => response.url().includes('/groups/quick-join/requests/'));
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        const response = await admitted;
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({
            status: 'joined',
            snapshot: { group: { groupId: snapshot.group.groupId } }
        });
        await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
        await expect(bobOperations.locator('.room-row.active')).toContainText(snapshot.group.displayName);
        // A human can start another arena while still owning the previous one. That cleanup
        // denial must not prevent the host or a Quick Joining guest from entering the new match.
        const replacementCreated = alice.waitForResponse((candidate) =>
            candidate.request().method() === 'POST' && /\/groups\/requests\//.test(candidate.url())
        );
        await aliceOperations.getByRole('button', { name: 'New Arena', exact: true }).click();
        const replacement: GroupSnapshot = await (await replacementCreated).json();
        expect(replacement.group.groupId).not.toBe(snapshot.group.groupId);
        await expect(aliceOperations.locator('.room-row.active')).toContainText(replacement.group.displayName);
        await expect(aliceOperations.getByText(
            'The new arena is ready, but leaving the previous arena failed. Your membership there remains.',
            { exact: true }
        )).toBeVisible();
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
        await expect(bobOperations.locator('.room-row.active')).toContainText(replacement.group.displayName);
        await bob.screenshot({ path: testInfo.outputPath('quick-join-replacement.png'), fullPage: true });
        // interaction: one WebGL acquisition per mounted canvas avoids repeating driver initialization on room changes.
        await expect(alice.getByLabel('AR Eye Hunter gameplay canvas')).toHaveAttribute(
            'data-test-webgl-acquisitions',
            '1'
        );
        await expect(bob.getByLabel('AR Eye Hunter gameplay canvas')).toHaveAttribute(
            'data-test-webgl-acquisitions',
            '1'
        );
    }
);

roomBrowserTest(
    'Quick Joined peers keep the match countdown and results when the host renderer was paused',
    { annotation: { type: 'room-journey', description: 'repeat-play' } },
    async ({ page: alice, guest: bob }, testInfo) => {
        // One-minute play plus paused-render setup and captured peer results can exceed two minutes.
        roomBrowserTest.setTimeout(180_000);
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture.');
        await alice.addInitScript(installAnimationFrameGate);
        const [aliceOperations, bobOperations] = await Promise.all([signIn(alice, 'alice'), signIn(bob, 'bob')]);
        const created = alice.waitForResponse((response) =>
            response.request().method() === 'POST' && /\/groups\/requests\//.test(response.url())
        );
        await aliceOperations.getByRole('button', { name: 'New Arena', exact: true }).click();
        const snapshot: GroupSnapshot = await (await created).json();
        await expect(aliceOperations.locator('.room-row.active')).toContainText(snapshot.group.displayName);
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
        await expect(bobOperations.locator('.room-row.active')).toContainText(snapshot.group.displayName);
        const appoint = aliceOperations.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        await expect(aliceOperations.getByRole('button', { name: '1m', exact: true })).toBeEnabled({ timeout: 20_000 });
        await expect(bobOperations.locator('.match-panel strong')).toHaveText('infinite');
        await alice.evaluate(() => window.dispatchEvent(new Event('test-pause-animation-frames')));
        // Occluded renderers can stop producing frames while HTTP, WS and heartbeat timers continue.
        await bob.waitForTimeout(12_000);
        await aliceOperations.getByRole('button', { name: '1m', exact: true }).click();
        await expect(aliceOperations.locator('.match-panel strong')).toHaveText(/^(1:00|0:[0-5]\d)$/, {
            timeout: 20_000
        });
        await expect(bobOperations.locator('.match-panel strong')).toHaveText(/^(1:00|0:[0-5]\d)$/, {
            timeout: 20_000
        });
        await alice.evaluate(() => window.dispatchEvent(new Event('test-resume-animation-frames')));
        await assertRunningMatch(aliceOperations, bobOperations);
        await bob.getByRole('button', { name: 'Diag', exact: true }).click();
        await bob.getByRole('button', { name: 'Request sync', exact: true }).click();
        await assertRunningMatch(aliceOperations, bobOperations);
        await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
        await bob.screenshot({ path: testInfo.outputPath('quick-join-playing.png'), fullPage: true });
        const aliceResults = alice.getByRole('dialog', { name: 'Match results' });
        const bobResults = bob.getByRole('dialog', { name: 'Match results' });
        await expect(aliceResults).toBeVisible({ timeout: 65_000 });
        await expect(bobResults).toBeVisible({ timeout: 10_000 });
        await expect(aliceResults.locator('.match-results')).toContainText('alice');
        await expect(aliceResults.locator('.match-results')).toContainText('bob');
        await expect(bobResults.locator('.match-results')).toHaveText(
            await aliceResults.locator('.match-results').innerText(),
            { useInnerText: true }
        );
        await bob.screenshot({ path: testInfo.outputPath('quick-join-results.png'), fullPage: true });
        await roomBrowserTest.step('room-journey:repeat-play', async () => {
            const startAgain = aliceResults.getByRole('button', { name: 'Start next match', exact: true });
            await expect(startAgain).toBeDisabled();
            await aliceResults.getByRole('button', { name: 'Play again', exact: true }).click();
            await expect(startAgain).toBeDisabled();
            await bobResults.getByRole('button', { name: 'Play again', exact: true }).click();
            await expect(startAgain).toBeEnabled();
            await bob.reload();
            await expect(bobResults).toBeVisible({ timeout: 20_000 });
            await expect(bobResults.getByRole('button', { name: 'Cancel ready', exact: true })).toBeEnabled();
            await bobResults.getByRole('button', { name: 'Cancel ready', exact: true }).click();
            await expect(startAgain).toBeDisabled();
            await bobResults.getByRole('button', { name: 'Play again', exact: true }).click();
            await expect(startAgain).toBeEnabled();
            await expect(bobResults).toBeVisible();
            await startAgain.click();
            await expect(aliceResults).toBeHidden();
            await expect(bobResults).toBeHidden();
            const openOperations = bob.getByRole('button', { name: 'Ops', exact: true });
            if (await openOperations.isVisible()) {
                await openOperations.click();
            }
            await assertRunningMatch(aliceOperations, bobOperations);
            const canvas = bob.getByLabel('AR Eye Hunter gameplay canvas');
            const shotsBefore = Number(await canvas.getAttribute('data-arena-shot-sequence'));
            await canvas.click({ position: { x: 400, y: 200 } });
            await expect.poll(async () => Number(await canvas.getAttribute('data-arena-shot-sequence')))
                .toBeGreaterThan(shotsBefore);
            await bob.keyboard.press('Escape');
            await bob.screenshot({ path: testInfo.outputPath('quick-join-second-match.png'), fullPage: true });
            await expect(aliceOperations.getByLabel('Account reference', { exact: true })).toHaveValue('alice');
            await expect(bobOperations.getByLabel('Account reference', { exact: true })).toHaveValue('bob');
            await expect(aliceOperations.locator('.room-row.active')).toHaveAttribute(
                'data-room-id',
                snapshot.group.groupId
            );
            await expect(bobOperations.locator('.room-row.active')).toHaveAttribute(
                'data-room-id',
                snapshot.group.groupId
            );
        });
    }
);

async function signIn(page: Page, username: string) {
    await page.goto('http://127.0.0.1:5186/');
    await expect(page.getByRole('main')).toBeVisible();
    const open = page.getByRole('button', { name: 'Ops', exact: true });
    if (await open.isVisible()) {
        await open.click();
    }
    const operations = page.getByRole('region', { name: 'Arena operations' });
    await operations.getByLabel('Username', { exact: true }).fill(username);
    await operations.getByLabel('Password', { exact: true }).fill('secret');
    await operations.getByRole('button', { name: 'Enter Arena', exact: true }).click();
    await expect(operations.getByRole('button', { name: 'Quick Join', exact: true })).toBeVisible();
    return operations;
}

async function assertRunningMatch(host: Locator, guest: Locator): Promise<void> {
    const initial = await guest.locator('.match-panel strong').innerText();
    for (let observation = 0; observation < 5; observation += 1) {
        await host.page().waitForTimeout(1_000);
        await expect(host.locator('.match-panel strong')).toHaveText(/^(1:00|0:[0-5]\d)$/);
        await expect(guest.locator('.match-panel strong')).toHaveText(/^(1:00|0:[0-5]\d)$/);
    }
    expect(await guest.locator('.match-panel strong').innerText()).not.toBe(initial);
}

function installAnimationFrameGate(): void {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    const native = new Map<number, number>();
    let paused = false;
    let sequence = 0;
    const schedule = (id: number, callback: FrameRequestCallback): void => {
        native.set(
            id,
            request((timestamp) => {
                native.delete(id);
                if (paused) {
                    pending.set(id, callback);
                }
                else {
                    callback(timestamp);
                }
            })
        );
    };
    window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        schedule(id, callback);
        return id;
    };
    window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        const handle = native.get(id);
        if (handle !== undefined) {
            cancel(handle);
            native.delete(id);
        }
    };
    window.addEventListener('test-pause-animation-frames', () => {
        paused = true;
    });
    window.addEventListener('test-resume-animation-frames', () => {
        paused = false;
        for (const [id, callback] of pending) {
            schedule(id, callback);
        }
        pending.clear();
    });
}

roomBrowserTest('a director canvas shot adopts a match accepted between animation frames', async ({ page }) => {
    roomBrowserTest.skip(
        process.env.RALLAR_ARENA_FULL_STACK === '1',
        'Component integration uses the Vite source server.'
    );
    await page.addInitScript(installAnimationFrameGate);
    const fixturePath =
        new URL('../../../packages/tests/ar-eye-hunter-v1/arena-shot-browser-fixture.html', import.meta.url).pathname;
    await page.goto(`/@fs${fixturePath}`);
    const canvas = page.getByLabel('AR Eye Hunter gameplay canvas');
    await expect(canvas).toHaveAttribute('data-arena-runtime-ready', 'true');
    await page.getByRole('button', { name: 'Inspect renderer' }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-pause-animation-frames')));
    await page.getByRole('button', { name: 'Accept match snapshot' }).click();
    await expect(page.getByTestId('accepted-match')).toHaveText('accepted-match');
    await canvas.click({ position: { x: 320, y: 240 } });
    await expect(page.getByTestId('shot-hit')).toHaveText('true');
    await expect(page.getByTestId('published-match')).toHaveText('accepted-match');
    await page.evaluate(() => document.exitPointerLock());
    await page.getByRole('button', { name: 'Change room' }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-resume-animation-frames')));
    await expect(canvas).toHaveAttribute('data-arena-runtime-ready', 'true');
    await expect(canvas).toHaveAttribute('data-arena-pointer-down-count', '0');
    await expect(page.getByTestId('published-match')).toHaveText('none');
    await canvas.click({ position: { x: 320, y: 240 } });
    await expect(page.getByTestId('shot-hit')).toHaveText('true');
    await expect(page.getByTestId('published-room')).toHaveText('replacement-arena');
    await expect(page.getByTestId('published-match')).toHaveText('none');
    await page.evaluate(() => document.exitPointerLock());
    await page.getByRole('button', { name: 'Change player' }).click();
    await expect(canvas).toHaveAttribute('data-arena-pointer-down-count', '0');
    await page.getByRole('button', { name: 'Inspect renderer' }).click();
    // interaction: the canvas owns one engine and one live scene/render loop after identity and room replacement.
    expect(JSON.parse(await page.getByTestId('renderer-inspection').innerText())).toEqual({
        sameEngine: true,
        originalEngineDisposed: false,
        originalSceneDisposed: true,
        scenes: 1,
        loops: 1
    });
    await page.getByRole('button', { name: 'Unmount arena' }).click();
    await expect(canvas).toHaveCount(0);
    await page.getByRole('button', { name: 'Inspect renderer' }).click();
    expect(JSON.parse(await page.getByTestId('renderer-inspection').innerText())).toEqual({
        sameEngine: false,
        originalEngineDisposed: true,
        originalSceneDisposed: true,
        scenes: 0,
        loops: 0
    });
});

function installArenaWebGlObservation(): void {
    HTMLCanvasElement.prototype.getContext = new Proxy(HTMLCanvasElement.prototype.getContext, {
        apply(target, canvas: HTMLCanvasElement, argumentsList: Parameters<HTMLCanvasElement['getContext']>) {
            const context = Reflect.apply(target, canvas, argumentsList);
            const kind = argumentsList[0];
            if (
                context && typeof kind === 'string' && kind.startsWith('webgl') &&
                canvas.getAttribute('aria-label') === 'AR Eye Hunter gameplay canvas'
            ) {
                canvas.dataset.testWebglAcquisitions = String(Number(canvas.dataset.testWebglAcquisitions ?? 0) + 1);
            }
            return context;
        }
    });
}
