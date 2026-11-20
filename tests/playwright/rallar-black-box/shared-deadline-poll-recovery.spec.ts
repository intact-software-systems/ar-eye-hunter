import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const viewUrl = '/@fs' + fileURLToPath(new URL('../../../examples/shared-deadline-poll/show-poll.ts', import.meta.url));
const roomRef = { applicationId: 'test', workspaceId: 'workspace', groupId: 'poll' };
const schedule = { opensAtEpochMs: 100, closesAtEpochMs: 200 };

test.beforeEach(async ({ page }) => {
    await page.route('**/poll-test', (route) => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await page.route('**/browser/rallar.ts*', (route) =>
        route.fulfill({
            contentType: 'text/javascript',
            body: `export const rallar = {
            async connect() {
                if (document.body.dataset.holdReconnect) {
                    document.body.dataset.reconnecting = 'true';
                    await new Promise(resolve => window.addEventListener('release-connect', resolve, { once: true }));
                }
                if (document.body.dataset.offline) throw new Error('Network unavailable');
                delete document.body.dataset.uncalibrated;
            },
            rooms: { async enter(room) { document.body.dataset.selected = room.groupId; } },
            compareDeadline(deadline) {
                if (document.body.dataset.uncalibrated) return 'unavailable';
                if (document.body.dataset.uncertain) return 'overlaps';
                return deadline === 100 ? 'at-or-after' : 'before';
            }
        };`
        }));
    await page.route('**/poll-snapshot', (route) =>
        route.fulfill({
            json: { roomRef, schedule, yes: 0, no: 0, closed: false, disposition: 'pending' }
        }));
    await page.goto('/poll-test');
    await page.evaluate(async ({ viewUrl, roomRef }) => {
        const { showPoll }: typeof import('../../../examples/shared-deadline-poll/show-poll.ts') = await import(
            viewUrl
        );
        const dispose = await showPoll({
            root: document.body,
            roomRef,
            endpoint: '/poll-snapshot',
            participantGrant: 'test'
        });
        window.addEventListener('leave-poll', dispose, { once: true });
    }, { viewUrl, roomRef });
    await expect(page.getByRole('button', { name: 'Yes' })).toBeEnabled();
});

test('a foreground poll recovers the final snapshot when calibration becomes available again', async ({ page }) => {
    await page.evaluate(() => {
        document.body.dataset.offline = 'true';
        document.body.dataset.uncalibrated = 'true';
    });
    await expect(page.getByRole('button', { name: 'Yes' })).toBeDisabled();
    await page.route('**/poll-snapshot', (route) =>
        route.fulfill({
            json: { roomRef, schedule, yes: 3, no: 1, closed: true, disposition: 'pending' }
        }));
    await page.evaluate(() => delete document.body.dataset.offline);
    await expect(page.getByText('Voting closed · Results')).toBeVisible();
    await expect(page.getByText('Yes 3 · No 1 · Your vote: pending')).toBeVisible();
});

test('a click crossing into an uncertain boundary sends no ballot', async ({ page }) => {
    const ballots: string[] = [];
    await page.route('**/poll-snapshot', async (route) => {
        if (route.request().method() === 'POST') {
            ballots.push(route.request().postData() ?? '');
        }
        await route.fallback();
    });
    await page.evaluate(() =>
        document.addEventListener('click', () => {
            document.body.dataset.uncertain = 'true';
        }, { capture: true, once: true })
    );
    await page.getByRole('button', { name: 'Yes' }).click();
    await expect(page.getByText('Voting boundary uncertain')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yes' })).toBeDisabled();
    expect(ballots).toEqual([]);
});

test('disposing a poll during reconnect preserves the next room selection', async ({ page }) => {
    await page.evaluate(() => {
        document.body.dataset.holdReconnect = 'true';
        document.body.dataset.uncalibrated = 'true';
    });
    await expect(page.locator('body')).toHaveAttribute('data-reconnecting', 'true');
    const selected = await page.evaluate(async () => {
        window.dispatchEvent(new Event('leave-poll'));
        document.body.dataset.selected = 'next-room';
        window.dispatchEvent(new Event('release-connect'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return document.body.dataset.selected;
    });
    expect(selected).toBe('next-room');
});

test('leaving during initial connection preserves the newly selected room and its controls', async ({ page }) => {
    const result = await page.evaluate(async ({ viewUrl, roomRef }) => {
        window.dispatchEvent(new Event('leave-poll'));
        const { showPoll } = await import(viewUrl);
        const selection = new AbortController();
        document.body.dataset.holdReconnect = 'true';
        const previous = showPoll({
            root: document.body, roomRef, endpoint: '/poll-snapshot', participantGrant: 'test',
            signal: selection.signal
        }).then(() => 'mounted', (error: DOMException) => error.name);
        selection.abort();
        document.body.dataset.selected = 'next-room';
        document.body.textContent = 'Next room';
        window.dispatchEvent(new Event('release-connect'));
        return { outcome: await previous, room: document.body.dataset.selected, view: document.body.textContent };
    }, { viewUrl, roomRef });
    expect(result).toEqual({ outcome: 'AbortError', room: 'next-room', view: 'Next room' });
});

test('a participant retries an unavailable room on entry and sees its revised deadline', async ({ page }) => {
    const destination = { ...roomRef, groupId: 'other' };
    await page.route('**/destination', route => route.fulfill({
        json: {
            roomRef: destination, schedule: { ...schedule, closesAtEpochMs: 60000 }, revision: 1,
            canExtend: false, closed: false, yes: 2, no: 1, disposition: 'accepted'
        }
    }));
    await page.route('**/destination', route => route.fulfill({ status: 503 }), { times: 1 });
    const entry = page.evaluate(async ({ viewUrl, destination }) => {
        window.dispatchEvent(new Event('leave-poll'));
        const { showPoll } = await import(viewUrl);
        await showPoll({ root: document.body, roomRef: destination, endpoint: '/destination', participantGrant: 'test' });
    }, { viewUrl, destination }).catch(error => String(error));
    await expect(page.getByRole('button', { name: 'Yes' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry room snapshot' }).click();
    expect(await entry).toBeUndefined();
    await expect(page.locator('time').last()).toHaveAttribute('datetime', '1970-01-01T00:01:00.000Z');
    await expect(page.getByText('Yes 2 · No 1 · Your vote: accepted')).toBeVisible();
});

test('leaving an unavailable room cancels its retry prompt', async ({ page }) => {
    await page.route('**/unreachable', route => route.abort('connectionrefused'));
    const entry = page.evaluate(async ({ viewUrl, roomRef }) => {
        window.dispatchEvent(new Event('leave-poll'));
        const selection = new AbortController();
        window.addEventListener('select-other-room', () => {
            selection.abort();
            document.body.textContent = 'Other room';
        }, { once: true });
        const { showPoll } = await import(viewUrl);
        try {
            await showPoll({
                root: document.body, roomRef, endpoint: '/unreachable', participantGrant: 'test', signal: selection.signal
            });
        }
        catch (error) {
            return error instanceof DOMException ? error.name : 'Unexpected error';
        }
    }, { viewUrl, roomRef });
    await expect(page.getByRole('button', { name: 'Retry room snapshot' })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('select-other-room')));
    expect(await entry).toBe('AbortError');
    await expect(page.locator('body')).toHaveText('Other room');
});

for (const scenario of [
    { name: 'lost receipt', stale: { disposition: 'pending' } },
    { name: 'lower Yes count', stale: { yes: 1, no: 2 } },
    { name: 'lower No count', stale: { yes: 3, no: 0 } },
    { name: 'reopened poll', stale: { closed: false } }
]) {
    test(`a returning voter rejects a ${scenario.name} at the same deadline revision`, async ({ page }) => {
        const accepted = {
            roomRef, schedule, revision: 1, canExtend: false, yes: 2, no: 1, closed: scenario.name === 'reopened poll', disposition: 'accepted'
        };
        let recovery: 'fresh' | 'stale' | 'closed' = 'fresh';
        await page.route('**/poll-snapshot', route => {
            const snapshot = recovery === 'stale' ? { ...accepted, ...scenario.stale } :
                { ...accepted, closed: accepted.closed || recovery === 'closed' };
            return route.fulfill({ json: snapshot });
        });
        await page.getByRole('button', { name: 'Yes' }).click();
        await expect(page.getByText('Yes 2 · No 1 · Your vote: accepted')).toBeVisible();
        recovery = 'stale';
        const staleRead = page.waitForResponse('**/poll-snapshot');
        await page.evaluate(() => {
            window.dispatchEvent(new Event('pagehide'));
            window.dispatchEvent(new Event('pageshow'));
        });
        await staleRead;
        // A second read proves the first response was processed while recovery was still pending.
        await page.waitForRequest('**/poll-snapshot', { timeout: 5000 });
        await expect(page.getByText('Recovering room poll')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Yes' })).toBeDisabled();
        recovery = 'closed';
        await expect(page.getByText('Voting closed · Results')).toBeVisible();
        await expect(page.getByText('Yes 2 · No 1 · Your vote: accepted')).toBeVisible();
    });
}
