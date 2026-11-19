import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { GroupRef } from '@shared/api/group-types.ts';
import { PollAuthority } from '../../../examples/shared-deadline-poll/poll-authority.ts';
import { loginThroughUi, readFullStackConfig, uniqueSuffix } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const rallarUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
const viewUrl = '/@fs' + fileURLToPath(new URL('../../../examples/shared-deadline-poll/show-poll.ts', import.meta.url));

test('a delayed ballot and a returning browser share one room cutoff', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const roomRef = {
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        groupId: 'poll-' + uniqueSuffix()
    };
    const hostGrant = randomUUID();
    const guestGrant = randomUUID();
    const releaseVote = Promise.withResolvers<void>();
    const voteSent = Promise.withResolvers<void>();
    if (!baseURL) {
        throw new Error('The full-stack poll requires the SPA base URL.');
    }
    const poll = await startPollEndpoint(
        new URL(baseURL).origin,
        roomRef,
        new Map([
            [hostGrant, config.userA.username],
            [guestGrant, config.userB.username]
        ])
    );
    try {
        await Promise.all([
            page.clock.setSystemTime(Date.now() + 120_000),
            guest.clock.setSystemTime(Date.now() - 120_000)
        ]);
        await Promise.all([prepareMember(page, roomRef, true), prepareMember(guest, roomRef, false)]);
        await page.evaluate(async ({ rallarUrl, roomRef }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
            await rallar.rooms.createAndSwitch({
                displayName: 'Shared deadline poll',
                groupId: roomRef.groupId,
                joinMode: 'open'
            });
        }, { rallarUrl, roomRef });
        await Promise.all([mount(page, hostGrant), mount(guest, guestGrant)]);
        expect(await page.evaluate(() => Date.now()) - await guest.evaluate(() => Date.now())).toBeGreaterThan(230_000);
        await expect(page.getByText('Question preview')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Yes' })).toBeDisabled();
        await expect(page.getByText('Voting open')).toBeVisible({ timeout: 15_000 });
        await expect(guest.getByText('Voting open')).toBeVisible();
        const schedule = await page.locator('time').allTextContents();
        expect(schedule).toHaveLength(2);
        await expect(guest.locator('time')).toHaveText(schedule);
        await page.getByRole('button', { name: 'Yes' }).click();
        await expect(page.getByText('Yes 1 · No 0 · Your vote: accepted')).toBeVisible();
        await guest.route(poll.url, async (route) => {
            if (route.request().method() === 'POST') {
                voteSent.resolve();
                await releaseVote.promise;
            }
            await route.continue();
        });
        await guest.getByRole('button', { name: 'No' }).click();
        await voteSent.promise;
        await expect(page.getByText('Voting closed')).toBeVisible({ timeout: 25_000 });
        releaseVote.resolve();
        await expect(guest.getByText('Yes 1 · No 0 · Your vote: late')).toBeVisible();
        const lateEntry = await browser.newPage({ baseURL });
        try {
            await prepareMember(lateEntry, roomRef, true);
            await mount(lateEntry, hostGrant);
            await expect(lateEntry.locator('time')).toHaveText(schedule);
            await expect(lateEntry.getByText('Voting closed · Results')).toBeVisible();
            await expect(lateEntry.getByText('Yes 1 · No 0 · Your vote: accepted')).toBeVisible();
            await expect(lateEntry.getByRole('button', { name: 'Yes' })).toBeDisabled();
        }
        finally {
            await lateEntry.close();
        }
        await guest.reload();
        await mount(guest, guestGrant);
        await expect(guest.locator('time')).toHaveText(schedule);
        await expect(guest.getByText('Voting closed')).toBeVisible();
        await expect(guest.getByText('Yes 1 · No 0 · Your vote: late')).toBeVisible();
        await expect(guest.getByRole('button', { name: 'Yes' })).toBeDisabled();
    }
    finally {
        releaseVote.resolve();
        await guest.close();
        await poll.close();
    }

    async function mount(member: Page, grant: string): Promise<void> {
        await member.evaluate(async ({ viewUrl, rallarUrl, roomRef, endpoint, grant, apiBaseUrl }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
            rallar.configure({ apiBaseUrl });
            rallar.setDefaults(roomRef);
            const { showPoll }: typeof import('../../../examples/shared-deadline-poll/show-poll.ts') = await import(
                viewUrl
            );
            await showPoll({ root: document.querySelector('main')!, roomRef, endpoint, participantGrant: grant });
        }, { viewUrl, rallarUrl, roomRef, endpoint: poll.url, grant, apiBaseUrl: config.apiBaseUrl });
    }
});

async function prepareMember(page: Page, roomRef: GroupRef, host: boolean): Promise<void> {
    await loginThroughUi({ page, config, user: host ? config.userA : config.userB, suffix: uniqueSuffix() });
    await page.unroute('**/api/**');
    await page.goto(viewUrl.replace('show-poll.ts', 'index.html'));
    await page.evaluate(async ({ rallarUrl, apiBaseUrl, roomRef }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
        rallar.configure({ apiBaseUrl });
        rallar.setDefaults(roomRef);
        await rallar.connect();
    }, { rallarUrl, apiBaseUrl: config.apiBaseUrl, roomRef });
}

/** Loopback transport for a single poll. Only the two fixture participants receive poll-specific grants. */
async function startPollEndpoint(origin: string, roomRef: GroupRef, grants: ReadonlyMap<string, string>) {
    let poll: PollAuthority | undefined;
    const server = createServer(async (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'OPTIONS') {
            response.writeHead(204).end();
            return;
        }
        const authorization = request.headers.authorization;
        const principal = authorization?.startsWith('Bearer ') ? grants.get(authorization.slice(7)) : undefined;
        if (!principal || request.url !== '/poll') {
            response.writeHead(403).end();
            return;
        }
        if (!poll) {
            const startsAt = Date.now();
            poll = new PollAuthority(
                roomRef,
                { opensAtEpochMs: startsAt + 5_000, closesAtEpochMs: startsAt + 17_000 },
                Date.now
            );
        }
        let record: PollAuthority.Snapshot;
        if (request.method === 'GET') {
            record = poll.read(principal);
        }
        else if (request.method === 'POST') {
            let choice = '';
            for await (const chunk of request) {
                choice += chunk;
                if (choice.length > 3) {
                    response.writeHead(400).end();
                    return;
                }
            }
            if (choice !== 'yes' && choice !== 'no') {
                response.writeHead(400).end();
                return;
            }
            record = poll.vote(principal, choice);
        }
        else {
            response.writeHead(405).end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(record));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Poll needs a TCP port.');
    }
    return {
        url: `http://127.0.0.1:${address.port}/poll`,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}
