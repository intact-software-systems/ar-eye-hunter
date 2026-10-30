import {
    expect,
    test,
    type Page
} from '@playwright/test';

import { renewRoomAfterDelayedCallbacks } from '../delayed-room-heartbeat.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';
import { readSceneCanvasMetrics } from './relic-scene-observations.ts';

// Includes review animation, automatic continuation, and delivery of the next authoritative state.
const automaticReviewTransitionTimeoutMs = 30_000;

test(
    'diagnoses a mismatched WebSocket host at login and recovers after configuration repair',
    async ({ page }, testInfo) => {
        test.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the local full-stack server.');
        const transportAttempts: string[] = [];
        page.on('request', (request) => {
            if (request.url().includes('/api/auth/ws-ticket/requests/')) {
                transportAttempts.push('ticket');
            }
        });
        page.on('websocket', (socket) => {
            if (new URL(socket.url()).pathname.startsWith('/api/ws/')) {
                transportAttempts.push('socket');
            }
        });
        await page.route('**/api/config', async (route) => {
            const response = await route.fetch();
            await route.fulfill({
                response,
                json: { ...await response.json(), wsBaseUrl: 'ws://unrelated.example.test' }
            });
        });
        await page.goto('/');
        await page.getByLabel('Username', { exact: true }).fill('alice');
        await page.getByLabel('Password', { exact: true }).fill('secret');
        await page.getByRole('button', { name: 'Enter', exact: true }).click();
        const diagnostic = page.getByText(
            'WebSocket host "unrelated.example.test" does not match API host "127.0.0.1:5175". ' +
                'Check RALLAR_API_BASE_URL and RALLAR_WS_BASE_URL.',
            { exact: true }
        ).first();
        await expect(diagnostic).toBeVisible();
        await diagnostic.scrollIntoViewIfNeeded();
        await expect(diagnostic).toBeInViewport();
        expect(transportAttempts).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath('websocket-host-mismatch.png'), fullPage: true });

        await page.unroute('**/api/config');
        await page.reload();
        await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'New Room', exact: true }).click();
        await expect(page.getByLabel('Room link', { exact: true })).toHaveValue(/#rallar-room\?/);
        await expect(diagnostic).toHaveCount(0);
        expect(transportAttempts).toContain('ticket');
        expect(transportAttempts).toContain('socket');
        await page.getByLabel('Room link', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('websocket-host-recovered.png'), fullPage: true });
    }
);

test(
    'recovers a private expedition after delayed browser callbacks and can still begin play',
    async ({ page }, testInfo) => {
        test.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the paired Relic server.');
        await page.clock.install();
        await page.goto('/');
        await registerPrivateHunter(page, 'delayed-heartbeat');
        await page.getByRole('button', { name: 'New invite-only room', exact: true }).click();
        const roomLink = page.getByLabel('Room link', { exact: true });
        await expect(roomLink).toHaveValue(/#rallar-room\?/);
        const selected = await roomLink.inputValue();
        await renewRoomAfterDelayedCallbacks(page, selected);
        await expect(roomLink).toHaveValue(selected);
        await expect(page.locator('.lobby-party-row')).toHaveCount(0);
        await page.getByRole('button', { name: /Join as/ }).click();
        await expect(page.locator('.lobby-party-row')).toHaveCount(1);
        await page.locator('.lobby-begin-btn').click();
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await roomLink.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('delayed-heartbeat-expedition.png'), fullPage: true });
    }
);

test(
    'finishes sharing a code room when cached presence expires during previous-room cleanup',
    async ({ page }, testInfo) => {
        test.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the paired Relic server.');
        await page.clock.install();
        await page.goto('/');
        await registerPrivateHunter(page, 'code-recovery');
        await page.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        const roomLink = page.getByLabel('Room link', { exact: true });
        await expect(roomLink).toHaveValue(/#rallar-room\?/);
        const previousLink = await roomLink.inputValue();
        await expect(page.getByRole('button', { name: 'New code room', exact: true })).toBeEnabled();

        const leavePending = Promise.withResolvers<void>();
        const releaseLeave = Promise.withResolvers<void>();
        const leaveDelivered = Promise.withResolvers<void>();
        const recoveryPending = Promise.withResolvers<void>();
        const releaseRecovery = Promise.withResolvers<void>();
        const groupsPath = '/api/state/apps/rallar-server/workspaces/default/groups';
        await page.route('**/groups/*/members/*/requests/*', async (route) => {
            const response = await route.fetch();
            expect(response.status()).toBe(403);
            leavePending.resolve();
            await releaseLeave.promise;
            await route.fulfill({ response });
            leaveDelivered.resolve();
        });
        await page.route((url) => url.pathname === groupsPath, async (route) => {
            recoveryPending.resolve();
            await releaseRecovery.promise;
            await route.continue();
        });
        try {
            await page.getByRole('button', { name: 'New code room', exact: true }).click();
            await leavePending.promise;
            // Expire the browser cache while the created room remains live on the server.
            await page.clock.fastForward(65_000);
            await recoveryPending.promise;
            releaseLeave.resolve();
            await leaveDelivered.promise;
            // The cache read recovers one browser-clock second after the cleanup refusal arrives.
            await page.clock.runFor(1_000);
            releaseRecovery.resolve();
            await page.clock.setSystemTime(new Date());
            await page.clock.resume();
            await expect(roomLink).not.toHaveValue(previousLink);
            await expect(roomLink).toHaveValue(/joinCode=/);
            await expect(page.locator('.lobby-party-row')).toHaveCount(0);
            await page.getByRole('button', { name: /Join as/ }).click();
            await expect(page.locator('.lobby-party-row')).toHaveCount(1);
            await roomLink.scrollIntoViewIfNeeded();
            await page.screenshot({ path: testInfo.outputPath('code-room-cache-recovered.png'), fullPage: true });
        }
        finally {
            releaseLeave.resolve();
            releaseRecovery.resolve();
        }
    }
);

test('retains a manual private destination through signed-out reload and cancellation', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Room reference', { exact: true }).fill('private-expedition');
    await page.getByLabel('Room code', { exact: true }).fill('private-code');
    await page.getByRole('button', { name: 'Enter room', exact: true }).click();
    await expect(page.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Room reference', { exact: true })).toHaveValue('private-expedition');
    await page.getByRole('button', { name: 'Cancel room entry', exact: true }).click();
    await page.reload();
    await expect(page.getByText('Sign in to enter this room.', { exact: true })).toHaveCount(0);
});

test('rejects a private link for another application without admitting a room', async ({ page }) => {
    const admissions: string[] = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/join')) {
            admissions.push(request.url());
        }
    });
    await page.goto(
        '/#rallar-room?applicationId=ar-eye-hunter&workspaceId=default&groupId=wrong-app&joinCode=private-code'
    );
    await expect(page.getByRole('alert')).toContainText('different application or workspace');
    expect(admissions).toEqual([]);
});

test(
    'switches accounts through Logout and keeps the replacement expedition after reload',
    async ({ page }, testInfo) => {
        test.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        const browserErrors: string[] = [];
        page.on('pageerror', (error) => browserErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') {
                browserErrors.push(message.text());
            }
        });
        await page.goto('/');
        const previousUsername = await registerPrivateHunter(page, 'previous');
        await expect(page.locator('.profile-row strong')).toHaveText(previousUsername);
        await expect(page.getByRole('button', { name: 'New unlisted room', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        const roomLink = page.getByLabel('Room link', { exact: true });
        await expect(roomLink).toHaveValue(/#rallar-room\?/);
        const previousRoomLink = await roomLink.inputValue();

        await page.getByRole('button', { name: 'Logout', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'New Room', exact: true })).toHaveCount(0);
        await expect(roomLink).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('auth.session') === null)).toBe(true);

        const replacementUsername = await registerPrivateHunter(page, 'replacement');
        await expect(page.locator('.profile-row strong')).toHaveText(replacementUsername);
        await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'New Room', exact: true }).click();
        await expect(roomLink).toHaveValue(/#rallar-room\?/);
        await expect(roomLink).not.toHaveValue(previousRoomLink);
        const replacementRoomLink = await roomLink.inputValue();
        await page.reload();
        await expect(page.locator('.profile-row strong')).toHaveText(replacementUsername);
        await expect(roomLink).toHaveValue(replacementRoomLink);
        await expect(page.getByRole('button', { name: /Join as/ })).toBeVisible();
        await expect(page.locator('canvas.relic-scene')).toBeVisible();
        await expect.poll(() => readSceneCanvasMetrics(page)).toMatchObject({ ready: true, hasRenderedFrame: true });
        await page.getByRole('button', { name: /Join as/ }).click();
        await expect(page.locator('.lobby-party-row')).toHaveCount(1);
        await page.locator('.lobby-begin-btn').click();
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await page.getByRole('button', { name: 'First-person view', exact: true }).click();
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode).toBe('first-person');
        await page.getByRole('button', { name: 'Overview view', exact: true }).click();
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode).toBe('overview');
        await page.locator('.profile-row strong').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('replacement-account-expedition.png'), fullPage: true });
        expect(browserErrors).toEqual([]);
    }
);

roomBrowserTest(
    'shares a code expedition, plays together, and returns after code rotation',
    { annotation: [{ type: 'room-journey', description: 'entry' }, { type: 'room-journey', description: 'recovery' }] },
    async ({ browser, page: hostPage, guest: guestPage }, testInfo) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        roomBrowserTest.setTimeout(180_000);
        const outsider = await browser.newContext();
        try {
            const outsiderPage = await outsider.newPage();
            await hostPage.goto('/');
            await registerPrivateHunter(hostPage, 'host');
            await expect(hostPage.getByRole('button', { name: 'New code room', exact: true })).toBeVisible();
            await hostPage.getByRole('button', { name: 'New code room', exact: true }).click();
            await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
            const link = await hostPage.getByLabel('Room link', { exact: true }).inputValue();
            await outsiderPage.goto('/');
            await registerPrivateHunter(outsiderPage, 'outsider');
            await expect(outsiderPage.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled();
            await expect(outsiderPage.locator('button.room-row')).toHaveCount(0);
            await outsiderPage.goto('about:blank');
            await roomBrowserTest.step('room-journey:entry', async () => {
                await guestPage.goto(link);
                await expect(guestPage.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
                await registerPrivateHunter(guestPage, 'guest');
                await playPrivateExpedition(hostPage, guestPage);
            });
            await hostPage.getByRole('button', { name: 'Rotate room code', exact: true }).click();
            await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue(link);
            await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
            const currentLink = await hostPage.getByLabel('Room link', { exact: true }).inputValue();
            const fields = new URLSearchParams(new URL(currentLink).hash.slice('#rallar-room?'.length));
            const groupId = fields.get('groupId');
            const joinCode = fields.get('joinCode');
            if (!groupId || !joinCode) {
                throw new Error('The generated private-room link must contain its reference and code.');
            }
            await hostPage.screenshot({ path: testInfo.outputPath('relic-host.png'), fullPage: true });
            // The host's assertions are complete; release its software WebGL renderer before reload.
            await hostPage.goto('about:blank');
            await roomBrowserTest.step('room-journey:recovery', async () => {
                await guestPage.reload();
                await expect(guestPage.locator('.turn-plan-status .panel-label')).toHaveText('Round 2');
                await guestPage.getByRole('button', { name: 'Submit Plan' }).click();
                await expect(guestPage.locator('.turn-plan-status')).toContainText('Plan locked');
            });
            await guestPage.screenshot({ path: testInfo.outputPath('relic-guest.png'), fullPage: true });
            await guestPage.goto('about:blank');
            await outsiderPage.goto(link);
            await expect(outsiderPage.getByRole('alert')).toContainText('Room entry was denied');
            await outsiderPage.getByLabel('Room code', { exact: true }).fill(joinCode);
            await outsiderPage.getByRole('button', { name: 'Enter room', exact: true }).click();
            await expect(outsiderPage.getByText(`Entered ${groupId}.`, { exact: true })).toBeVisible();
        }
        finally {
            await outsider.close();
        }
    }
);

roomBrowserTest(
    'plays a two-hunter expedition through visible move, escape, and matching finale controls',
    { annotation: { type: 'room-journey', description: 'repeat-play' } },
    async ({ page: host, guest }, testInfo) => {
        // Seven transitions retain their 30 s limits; setup, screenshots, reload, and both clients need additional time.
        roomBrowserTest.setTimeout(7 * automaticReviewTransitionTimeoutMs + 240_000);
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        await host.goto('/');
        const hostUsername = await registerPrivateHunter(host, 'finale-host');
        await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        const link = host.getByLabel('Room link', { exact: true });
        await expect(link).toHaveValue(/#rallar-room\?/);
        const roomLink = await link.inputValue();
        const roomId = new URLSearchParams(new URL(roomLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!roomId) {
            throw new Error('The shared expedition must have a scoped room reference.');
        }
        await guest.goto(roomLink);
        const guestUsername = await registerPrivateHunter(guest, 'finale-guest');
        await playPrivateExpedition(host, guest);
        for (const [index, destination] of ['Hallway', 'Trap Room', 'Monster Lair', 'Exit'].entries()) {
            for (const hunter of [host, guest]) {
                await expect(hunter.locator('.turn-plan-status .panel-label')).toHaveText(`Round ${index + 2}`);
                await hunter.locator('.action-picker').getByRole('button', { name: /^Move/ }).click();
                await hunter.locator('.target-choice-grid').getByRole('button', { name: new RegExp(`^${destination}`) })
                    .click();
            }
            await submitBothPlans(host, guest);
            await expect(host.locator('.turn-plan-status .panel-label')).toHaveText(`Round ${index + 3}`, {
                timeout: automaticReviewTransitionTimeoutMs
            });
            await expect(guest.locator('.turn-plan-status .panel-label')).toHaveText(`Round ${index + 3}`, {
                timeout: automaticReviewTransitionTimeoutMs
            });
        }
        for (const hunter of [host, guest]) {
            await hunter.locator('.action-picker').getByRole('button', { name: /^Escape/ }).click();
        }
        await submitBothPlans(host, guest);
        for (const hunter of [host, guest]) {
            await expect(hunter.locator('.victory-panel')).toBeVisible({ timeout: automaticReviewTransitionTimeoutMs });
            await expect(hunter.locator('.final-score-row')).toHaveCount(2);
            await expect(hunter.locator('.final-score-tag.success')).toHaveText(['escaped', 'escaped']);
            await expect(hunter.locator('.error-panel')).toHaveCount(0);
        }
        await expect(guest.locator('.victory-panel h2')).toHaveText(
            await host.locator('.victory-panel h2').innerText()
        );
        await expect(guest.locator('.final-score-row')).toHaveText(
            await host.locator('.final-score-row').allInnerTexts(),
            { useInnerText: true }
        );
        await host.screenshot({ path: testInfo.outputPath('relic-host-finale.png'), fullPage: true });
        await guest.screenshot({ path: testInfo.outputPath('relic-guest-finale.png'), fullPage: true });
        await roomBrowserTest.step('room-journey:repeat-play', async () => {
            const startAgain = host.getByRole('button', { name: 'Start next expedition', exact: true });
            await expect(startAgain).toBeDisabled();
            await host.getByRole('button', { name: 'Play again', exact: true }).click();
            await expect(startAgain).toBeDisabled();
            await guest.getByRole('button', { name: 'Play again', exact: true }).click();
            await expect(startAgain).toBeEnabled();
            await guest.reload();
            await expect(guest.locator('.victory-panel')).toBeVisible();
            await expect(guest.getByRole('button', { name: 'Cancel ready', exact: true })).toBeEnabled();
            await guest.getByRole('button', { name: 'Cancel ready', exact: true }).click();
            await expect(startAgain).toBeDisabled();
            await guest.getByRole('button', { name: 'Play again', exact: true }).click();
            await expect(startAgain).toBeEnabled();
            await expect(host.locator('.final-score-row')).toHaveCount(2);
            await expect(guest.locator('.victory-panel')).toBeVisible();
            await startAgain.click();
            await expect(host.locator('.victory-panel')).toBeHidden();
            await expect(guest.locator('.victory-panel')).toBeHidden();
            for (const hunter of [host, guest]) {
                await expect(hunter.locator('.turn-plan-status .panel-label')).toHaveText('Round 1');
                await hunter.locator('.action-picker').getByRole('button', { name: /^Search/ }).click();
            }
            await submitBothPlans(host, guest);
            await expect(host.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', {
                timeout: automaticReviewTransitionTimeoutMs
            });
            await expect(guest.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', {
                timeout: automaticReviewTransitionTimeoutMs
            });
            await expect(host.locator('.profile-row strong')).toHaveText(hostUsername);
            await expect(guest.locator('.profile-row strong')).toHaveText(guestUsername);
            await expect(link).toHaveValue(roomLink);
            await expect(host.locator('.room-row.active')).toHaveAttribute('data-room-id', roomId);
            await expect(guest.locator('.room-row.active')).toHaveAttribute('data-room-id', roomId);
        });
    }
);

roomBrowserTest(
    'replaces a saved room with an invitation and enforces revocation before admission',
    async ({ page: hostPage, guest: guestPage }) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        await hostPage.goto('/');
        await registerPrivateHunter(hostPage, 'invite-host');
        await hostPage.getByRole('button', { name: 'New code room', exact: true }).click();
        await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
        await guestPage.goto(await hostPage.getByLabel('Room link', { exact: true }).inputValue());
        await registerPrivateHunter(guestPage, 'invite-guest');
        await expect(guestPage.getByRole('button', { name: /Join as/ })).toBeVisible();
        const principal = await guestPage.getByLabel('Your account reference', { exact: true }).inputValue();
        await hostPage.getByRole('button', { name: 'New invite-only room', exact: true }).click();
        const linkField = hostPage.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        await expect(linkField).not.toHaveValue(/joinCode=/);
        const link = await linkField.inputValue();
        const groupId = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
        await guestPage.goto(link);
        await expect(guestPage.getByRole('alert')).toContainText('Room entry was denied');
        await hostPage.getByLabel('Account reference', { exact: true }).fill(principal);
        await hostPage.getByRole('button', { name: 'Invite account', exact: true }).click();
        await hostPage.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
        await expect(hostPage.getByRole('button', { name: 'Revoke invitation', exact: true })).toHaveCount(0);
        await guestPage.getByRole('button', { name: 'Retry room entry', exact: true }).click();
        await expect(guestPage.getByRole('alert')).toContainText('Room entry was denied');
        await hostPage.getByRole('button', { name: 'Invite account', exact: true }).click();
        await expect(hostPage.getByRole('button', { name: 'Revoke invitation', exact: true })).toHaveCount(1);
        await hostPage.goto('about:blank');
        await guestPage.getByRole('button', { name: 'Retry room entry', exact: true }).click();
        await expect(guestPage.getByText(`Entered ${groupId}.`, { exact: true })).toBeVisible();
        await expect(guestPage.locator('.lobby-party-row')).toHaveCount(0);
        await guestPage.reload();
        await expect(guestPage.getByText(`Entered ${groupId}.`, { exact: true })).toBeVisible();
        await expect(guestPage.getByRole('button', { name: /Join as/ })).toBeVisible();
    }
);

roomBrowserTest(
    'shares an unlisted expedition and keeps participants when the host hides it',
    async ({ page: host, guest }, testInfo) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        await host.goto('/');
        await registerPrivateHunter(host, 'unlisted-host');
        await expect(host.getByRole('button', { name: 'New unlisted room', exact: true })).toBeVisible();
        await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        await expect(host.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        const link = await host.getByLabel('Room link', { exact: true }).inputValue();
        expect(link).toContain('#rallar-room?');
        expect(link).not.toContain('joinCode=');
        const roomName = await host.locator('.room-row.active span').innerText();
        await guest.goto('/');
        await registerPrivateHunter(guest, 'unlisted-guest');
        await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guest.locator('.room-row').filter({ hasText: roomName })).toHaveCount(0);
        await host.route('**/groups/*/requests/*', async (route) => {
            if (route.request().method() === 'PUT' && route.request().postDataJSON().directoryListing) {
                await route.fulfill({ status: 403, json: { error: 'Listing unavailable' } });
            }
            else {
                await route.continue();
            }
        });
        await host.getByRole('button', { name: 'List room', exact: true }).click();
        await expect(host.getByRole('alert')).toContainText('Could not change room listing');
        await expect(host.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        await host.unroute('**/groups/*/requests/*');
        await host.getByRole('button', { name: 'List room', exact: true }).click();
        await expect(host.getByRole('button', { name: 'Unlist room', exact: true })).toBeEnabled();
        await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guest.locator('.room-row').filter({ hasText: roomName })).toHaveCount(1);
        await host.getByRole('button', { name: 'Unlist room', exact: true }).click();
        await expect(host.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guest.locator('.room-row').filter({ hasText: roomName })).toHaveCount(0);
        await guest.goto(link);
        await expect(guest.getByRole('button', { name: /Join as/ })).toBeVisible();
        await host.getByRole('button', { name: 'List room', exact: true }).click();
        await host.getByRole('button', { name: 'Unlist room', exact: true }).click();
        await playPrivateExpedition(host, guest);
        await guest.screenshot({ path: testInfo.outputPath('unlisted-expedition-participating.png'), fullPage: true });
    }
);

roomBrowserTest(
    'recovers recent expeditions without joining the activity and persists Forget',
    async ({ page: host, guest }, testInfo) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        await host.goto('/');
        await registerPrivateHunter(host, 'recent-host');
        await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        const linkField = host.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        const firstLink = await linkField.inputValue();
        const firstRef = new URLSearchParams(new URL(firstLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!firstRef) {
            throw new Error('The first expedition must have a scoped share reference.');
        }
        await guest.goto(firstLink);
        await registerPrivateHunter(guest, 'recent-guest');
        const history = guest.getByRole('region', { name: 'Recent rooms', exact: true });
        await expect(history.getByRole('button', { name: `Return to ${firstRef}`, exact: true })).toBeVisible();
        await host.getByRole('button', { name: 'New code room', exact: true }).click();
        await expect(linkField).not.toHaveValue(firstLink);
        await expect(linkField).toHaveValue(/joinCode=/, { timeout: 30_000 });
        const secondLink = await linkField.inputValue();
        const secondRef = new URLSearchParams(new URL(secondLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!secondRef) {
            throw new Error('The second expedition must have a scoped share reference.');
        }
        // Sharing is complete; release the host scene before the guest switches rooms.
        await host.goto('about:blank');
        await guest.goto(secondLink);
        await expect(guest.getByText(`Entered ${secondRef}.`, { exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: `Return to ${firstRef}`, exact: true })).toBeVisible();
        await guest.reload();
        await expect(guest.getByText(`Entered ${secondRef}.`, { exact: true })).toBeVisible();
        const admissionPath = `**/groups/${firstRef}/join/requests/*`;
        await guest.route(
            admissionPath,
            (route) => route.fulfill({ status: 403, json: { error: 'Room no longer available' } })
        );
        await history.getByRole('button', { name: `Return to ${firstRef}`, exact: true }).click();
        await expect(guest.getByRole('alert')).toContainText('Room entry was denied');
        await guest.unroute(admissionPath);
        await history.getByRole('button', { name: `Return to ${firstRef}`, exact: true }).click();
        await expect(guest.getByText(`Entered ${firstRef}.`, { exact: true })).toBeVisible();
        await expect(guest.getByLabel('Room code', { exact: true })).toHaveValue('');
        await expect(guest.locator('.lobby-party-row')).toHaveCount(0);
        await expect(guest.getByRole('button', { name: /Join as/ })).toBeVisible();
        await history.getByRole('button', { name: `Forget ${secondRef}`, exact: true }).click();
        await expect(history.getByRole('button', { name: `Return to ${secondRef}`, exact: true })).toHaveCount(0);
        await expect(guest.getByText(`Entered ${firstRef}.`, { exact: true })).toBeVisible();
        await guest.reload();
        await expect(history.getByRole('button', { name: `Return to ${firstRef}`, exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: `Return to ${secondRef}`, exact: true })).toHaveCount(0);
        await expect(guest.locator('.lobby-party-row')).toHaveCount(0);
        await expect(guest.getByRole('button', { name: /Join as/ })).toBeVisible();
        await history.scrollIntoViewIfNeeded();
        await guest.screenshot({ path: testInfo.outputPath('recent-expedition-recovery.png'), fullPage: true });
    }
);

test(
    'recovers from an unavailable temporary expedition through Recent rooms and creates another room',
    async ({ page }, testInfo) => {
        test.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        await page.goto('/');
        await registerPrivateHunter(page, 'temporary-host');
        const created = page.waitForResponse((response) =>
            response.request().method() === 'POST' && /\/groups\/(?:[^/]+\/)?requests\//.test(response.url())
        );
        await page.getByRole('button', { name: 'New Room', exact: true }).click();
        const response = await created;
        expect(response.ok()).toBe(true);
        expect(response.request().postDataJSON().retention).toEqual({ mode: 'temporary', reconnectGraceMs: 600_000 });
        expect((await response.json()).group.metadata.rallarRetention).toEqual({
            mode: 'temporary',
            reconnectGraceMs: 600_000,
            emptyPresenceFingerprint: null
        });
        await expect(page.getByLabel('Room link', { exact: true })).toHaveValue(/#rallar-room\?/);
        await page.screenshot({ path: testInfo.outputPath('temporary-expedition-created.png'), fullPage: true });
        const linkField = page.getByLabel('Room link', { exact: true });
        const firstLink = await linkField.inputValue();
        const reference = new URLSearchParams(new URL(firstLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!reference) {
            throw new Error('The temporary room must have a scoped share reference.');
        }
        const history = page.getByRole('region', { name: 'Recent rooms', exact: true });
        await expect(history.getByRole('button', { name: `Return to ${reference}`, exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'New Room', exact: true }).click();
        await expect(linkField).not.toHaveValue(firstLink);
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        const currentLink = await linkField.inputValue();
        const currentName = await page.locator('.room-row.active span').innerText();
        const createBody = response.request().postDataJSON();
        const authorization = await response.request().headerValue('authorization');
        if (!authorization) {
            throw new Error('The owner room mutation must be authenticated.');
        }
        // The public owner API arranges unavailability; it does not simulate seven days or physical purge.
        const archived = await page.request.put(
            response.url().replace(/\/groups\/.*$/, `/groups/${reference}/requests/${crypto.randomUUID()}`),
            {
                headers: {
                    authorization,
                    'x-client-id': await response.request().headerValue('x-client-id') ?? '',
                    'x-session-id': await response.request().headerValue('x-session-id') ?? ''
                },
                data: {
                    status: 'archived',
                    actorPrincipalId: createBody.actorPrincipalId,
                    actorSessionId: createBody.actorSessionId
                }
            }
        );
        expect(archived.ok(), await archived.text()).toBe(true);
        expect((await archived.json()).group.status).toBe('archived');
        await history.getByRole('button', { name: `Return to ${reference}`, exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('Room entry was denied');
        await expect(page.getByText(`Entered ${reference}.`, { exact: true })).toHaveCount(0);
        await expect(linkField).toHaveValue(currentLink);
        await expect(page.locator('.room-row.active span')).toHaveText(currentName);
        await expect(page.locator('.lobby-party-row')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Join as/ })).toBeVisible();
        await page.getByRole('alert').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('temporary-expedition-unavailable.png'), fullPage: true });
        await page.getByRole('button', { name: 'Cancel room entry', exact: true }).click();
        await page.getByRole('button', { name: 'New Room', exact: true }).click();
        await expect(linkField).not.toHaveValue(currentLink);
        await expect(linkField).not.toHaveValue(firstLink);
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        await expect(page.locator('.room-row.active')).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('temporary-expedition-recovered.png'), fullPage: true });
    }
);

async function registerPrivateHunter(page: Page, role: string): Promise<string> {
    const suffix = crypto.randomUUID();
    const username = `${role}-${suffix}`;
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Display name', { exact: true }).fill(role);
    await page.getByLabel('Password', { exact: true }).fill(`private-room-${suffix}`);
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeVisible();
    return username;
}

async function playPrivateExpedition(host: Page, guest: Page): Promise<void> {
    await expect(guest.getByRole('button', { name: /Join as/ })).toBeVisible();
    await expect(guest.locator('.lobby-party-row')).toHaveCount(0);
    await host.getByRole('button', { name: /Join as/ }).click();
    await guest.getByRole('button', { name: /Join as/ }).click();
    await expect(host.locator('.lobby-party-row')).toHaveCount(2);
    await expect(guest.locator('.lobby-party-row')).toHaveCount(2);
    await host.locator('.lobby-begin-btn').click();
    for (const hunter of [host, guest]) {
        await expect(hunter.locator('.action-picker').getByRole('button', { name: /^Search/ }))
            .toHaveAttribute('aria-pressed', 'true');
    }
    await expect(guest.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
    await host.getByRole('button', { name: 'Submit Plan' }).click();
    await guest.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(host.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', {
        timeout: automaticReviewTransitionTimeoutMs
    });
    await expect(guest.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', {
        timeout: automaticReviewTransitionTimeoutMs
    });
}

async function submitBothPlans(host: Page, guest: Page): Promise<void> {
    await host.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(host.locator('.turn-plan-status')).toContainText('Plan locked');
    await expect(guest.locator('.turn-plan-counters')).toContainText('1 locked');
    await guest.getByRole('button', { name: 'Submit Plan' }).click();
}
