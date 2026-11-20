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
