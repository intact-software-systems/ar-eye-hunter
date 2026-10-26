import {
    expect,
    test,
    type Page,
    type Route
} from '@playwright/test';

import type { AuthSession } from '../../../packages/shared/api/api-config.ts';
import type { GroupDirectoryEntry } from '../../../packages/shared/api/group-directory/group-directory-types.ts';
import { createClientSnapshotFixture } from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';

const API_URL = 'http://127.0.0.1:8080';
const DIRECTORY_PATH = '/api/state/apps/ar-eye-hunter/workspaces/default/group-directory';
const EMPTY_GUIDANCE = 'Create an arena or join from another browser session.';

test('shows loading, a first-load failure, and an empty result after Refresh recovers', async ({ page }) => {
    const release = Promise.withResolvers<void>();
    let unavailable = true;
    await installDirectoryFixture(page, async (route) => {
        if (unavailable) {
            await release.promise;
            await route.fulfill({ status: 400, json: { error: 'Directory unavailable' } });
        }
        else {
            await route.fulfill({ json: { entries: [], nextCursor: null } });
        }
    });
    const operations = await signIn(page);
    await expect(operations.getByText(EMPTY_GUIDANCE)).toHaveCount(0);
    await expect(operations.getByText('Loading open arenas…')).toBeVisible();
    release.resolve();
    await expect(operations.getByText('Could not load open arenas', { exact: false })).toBeVisible();
    await expect(operations.getByText(EMPTY_GUIDANCE)).toHaveCount(0);
    unavailable = false;
    await operations.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(operations.getByText(EMPTY_GUIDANCE)).toBeVisible();
    await expect(operations.getByText('Could not load open arenas', { exact: false })).toHaveCount(0);
});

test('retains labelled rows after failure and refreshes capacity and admission copy', async ({ page }, testInfo) => {
    let unavailable = false;
    let entries = [directoryArena('Previously loaded', false)];
    await installDirectoryFixture(page, async (route) => {
        if (unavailable) {
            await route.fulfill({ status: 400, json: { error: 'Directory unavailable' } });
        }
        else {
            await route.fulfill({ json: { entries, nextCursor: null } });
        }
    });
    const operations = await signIn(page);
    const refresh = operations.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.click();
    await expect(operations.getByRole('button', { name: /Previously loaded.*Request to join/ })).toBeEnabled();
    unavailable = true;
    await refresh.click();
    await expect(operations.getByText('Last loaded arenas — refresh to check availability.')).toBeVisible();
    await expect(operations.getByRole('button', { name: /Previously loaded/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('retained-directory.png'), fullPage: true });
    unavailable = false;
    entries = [directoryArena('Available', false), directoryArena('At capacity', true)];
    await refresh.click();
    await expect(operations.getByRole('button', { name: /Previously loaded/ })).toHaveCount(0);
    await expect(operations.getByRole('button', { name: /Available.*Request to join/ })).toBeEnabled();
    await expect(operations.getByRole('button', { name: /At capacity.*Full/ })).toBeDisabled();
    await expect(operations.getByText('Last loaded arenas', { exact: false })).toHaveCount(0);
    await expect(operations.getByText('Could not load open arenas', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('recovered-directory.png'), fullPage: true });
});

test(
    'automatically discovers additions and removals while preserving the current arena selection',
    async ({ page }, testInfo) => {
        test.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture.');
        await page.clock.install();
        let entries: GroupDirectoryEntry[] = [];
        await page.route(`${API_URL}${DIRECTORY_PATH}?*`, async (route) => {
            await route.fulfill({ json: { entries, nextCursor: null } });
        });
        const operations = await signIn(page);
        await operations.getByRole('button', { name: 'New unlisted arena', exact: true }).click();
        const roomLink = operations.getByLabel('Room link', { exact: true });
        await expect(roomLink).toHaveValue(/#rallar-room\?/);
        const selectedRoomLink = await roomLink.inputValue();
        const appoint = operations.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        const startMatch = operations.getByRole('button', { name: '1m', exact: true });
        await expect(startMatch).toBeEnabled({ timeout: 20_000 });
        await expect(operations.getByText('Loading open arenas…')).toHaveCount(0);
        entries = [directoryArena('Arriving arena', false)];
        await page.clock.fastForward(30_000);
        await expect(operations.getByRole('button', { name: /Arriving arena.*Request to join/ })).toBeEnabled();
        await expect(roomLink).toHaveValue(selectedRoomLink);
        await expect(startMatch).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath('automatic-arena-discovery.png'), fullPage: true });
        entries = [];
        await page.clock.fastForward(30_000);
        await expect(operations.getByRole('button', { name: /Arriving arena/ })).toHaveCount(0);
        await expect(operations.getByText('Loading open arenas…')).toHaveCount(0);
        await expect(roomLink).toHaveValue(selectedRoomLink);
        await expect(startMatch).toBeEnabled();
    }
);

test('live sign-in exposes ETag, accepts a conditional read, and keeps normal Refresh usable', async ({ page }) => {
    test.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture on port 8080.');
    const loginResponse = page.waitForResponse((response) => response.url().includes('/api/auth/login/requests/'));
    const operations = await signIn(page);
    const session: AuthSession = await (await loginResponse).json();
    const conditional = await page.evaluate(async ({ session, url }) => {
        const headers = { Authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId };
        const first = await fetch(url, { headers });
        const etag = first.headers.get('ETag');
        if (!etag) {
            throw new Error('The directory did not expose its ETag to the browser.');
        }
        const second = await fetch(url, { headers: { ...headers, 'If-None-Match': etag } });
        return {
            firstStatus: first.status,
            secondStatus: second.status,
            etagMatches: second.headers.get('ETag') === etag,
            body: await second.text()
        };
    }, { session, url: `${API_URL}${DIRECTORY_PATH}?kind=room&q=eye%20hunter&limit=50` });
    expect(conditional).toEqual({ firstStatus: 200, secondStatus: 304, etagMatches: true, body: '' });
    for (let attempt = 0; attempt < 2; attempt++) {
        const refreshed = page.waitForResponse((response) => response.url().includes(DIRECTORY_PATH));
        await operations.getByRole('button', { name: 'Refresh', exact: true }).click();
        expect((await refreshed).ok()).toBe(true);
        await expect(operations.getByText('Loading open arenas…')).toHaveCount(0);
        await expect(operations.getByText('Could not load open arenas', { exact: false })).toHaveCount(0);
    }
});

test(
    'opts into peer latency, keeps unknown rooms usable, and restores ordinary ordering',
    async ({ page }, testInfo) => {
        const orders: (string | null)[] = [];
        await installDirectoryFixture(page, async (route) => {
            const order = new URL(route.request().url()).searchParams.get('order');
            orders.push(order);
            const slow = { ...directoryArena('A slow', false), peerRttMs: order === 'peer-rtt' ? 90 : null };
            const fast = { ...directoryArena('Z fast', false), peerRttMs: order === 'peer-rtt' ? 20 : null };
            const unmeasured = directoryArena('B unknown', false);
            await route.fulfill({
                json: {
                    entries: order === 'peer-rtt' ? [fast, slow, unmeasured] : [slow, unmeasured, fast],
                    nextCursor: null
                }
            });
        });
        const operations = await signIn(page);
        await operations.getByRole('button', { name: 'Refresh', exact: true }).click();
        const preference = operations.getByRole('checkbox', { name: 'Prefer lower peer latency' });
        await expect(preference).not.toBeChecked();
        await preference.check();
        await expect(operations.getByRole('button', { name: /Z fast.*20 ms peer RTT/ })).toBeEnabled();
        await expect(operations.getByRole('button', { name: /B unknown.*Peer latency unknown/ })).toBeEnabled();
        await expect(operations.locator('.room-row')).toHaveText([
            /Z fast/,
            /A slow/,
            /B unknown/
        ]);
        expect(orders.at(-1)).toBe('peer-rtt');
        await operations.getByRole('button', { name: /B unknown.*Peer latency unknown/ }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('peer-latency-directory.png'), fullPage: true });
        await preference.uncheck();
        await expect(operations.locator('.room-row')).toHaveText([/A slow/, /B unknown/, /Z fast/]);
        await expect(operations.getByText('Peer latency unknown', { exact: false })).toHaveCount(0);
        expect(orders.at(-1)).toBe('online-members');
    }
);

async function signIn(page: Page) {
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    const openOperations = page.getByRole('button', { name: 'Ops', exact: true });
    if (await openOperations.isVisible()) {
        await openOperations.click();
    }
    const operations = page.getByRole('region', { name: 'Arena operations' });
    await operations.getByLabel('Username', { exact: true }).fill('alice');
    await operations.getByLabel('Password', { exact: true }).fill('secret');
    await operations.getByRole('button', { name: 'Enter Arena', exact: true }).click();
    await expect(operations.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    return operations;
}

async function installDirectoryFixture(page: Page, directory: (route: Route) => Promise<void>): Promise<void> {
    const session: AuthSession = {
        username: 'alice',
        clientId: 'alice',
        sessionId: 'directory-browser-session',
        accessToken: 'directory-browser-token',
        expiresAtEpochMs: Date.now() + 3_600_000
    };
    const client = createClientSnapshotFixture({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId: session.clientId
    });
    await page.routeWebSocket(/\/api\/ws\//, () => {});
    await page.route(`${API_URL}/api/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === DIRECTORY_PATH) {
            return directory(route);
        }
        if (path === '/api/config') {
            return route.fulfill({
                json: {
                    apiBaseUrl: API_URL,
                    wsBaseUrl: 'ws://127.0.0.1:8080',
                    endpoints: { createWs: '/api/ws/:id' },
                    serverPeerId: 'directory-test-server'
                }
            });
        }
        if (path.startsWith('/api/auth/login/requests/')) {
            return route.fulfill({ json: session });
        }
        if (path.startsWith('/api/auth/ws-ticket/requests/')) {
            return route.fulfill({
                json: {
                    ticket: 'directory-test-ticket',
                    sessionId: session.sessionId,
                    expiresAtEpochMs: session.expiresAtEpochMs
                }
            });
        }
        if (path === '/api/webrtc/ice') {
            return route.fulfill({ json: { iceServers: [], expiresAtEpochMs: session.expiresAtEpochMs } });
        }
        if (path.endsWith('/groups') || path.endsWith('/clients')) {
            return route.fulfill({ json: [] });
        }
        if (path.includes('/clients/')) {
            return route.fulfill({ json: client });
        }
        return route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${path}` } });
    });
}

function directoryArena(name: string, isFull: boolean): GroupDirectoryEntry {
    return {
        groupRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: name },
        displayName: `AR Eye Hunter Arena: ${name}`,
        kind: 'room',
        joinMode: 'open',
        memberCount: isFull ? 2 : 1,
        onlineMemberCount: 1,
        maxMembers: 2,
        isFull,
        lifecycleState: 'forming',
        peerRttMs: null
    };
}
