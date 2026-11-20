import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { GroupRef } from '@shared/api/group-types.ts';
import { PollAuthority } from '../../../examples/shared-deadline-poll/poll-authority.ts';
import { loginThroughUi, readFullStackConfig, uniqueSuffix } from './full-stack-helpers.ts';

declare global {
    interface Window {
        receivePollBallot(
            value: { msgId: string; expiresAtMs?: number; senderId: string; choice: PollAuthority.Choice; }
        ): Promise<void>;
        loseBallotRtcRoute(): Promise<void>;
    }
}

const enforcementOffsetMs = -2_000;
const config = readFullStackConfig();
const rallarUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
const viewUrl = '/@fs' + fileURLToPath(new URL('../../../examples/shared-deadline-poll/show-poll.ts', import.meta.url));

test('a delayed ballot and a returning browser share one room cutoff', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const spectator = await browser.newPage({ baseURL });
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
        await Promise.all([
            prepareMember(page, roomRef, true),
            prepareMember(guest, roomRef, false),
            prepareMember(spectator, roomRef, false)
        ]);
        await page.evaluate(async ({ rallarUrl, roomRef }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
            await rallar.rooms.createAndSwitch({
                displayName: 'Shared deadline poll',
                groupId: roomRef.groupId,
                joinMode: 'open'
            });
        }, { rallarUrl, roomRef });
        await Promise.all([mount(page, hostGrant), mount(guest, guestGrant), mount(spectator, guestGrant)]);
        expect(await page.evaluate(() => Date.now()) - await guest.evaluate(() => Date.now())).toBeGreaterThan(230_000);
        await expect(page.getByText('Question preview')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Yes' })).toBeDisabled();
        await expectUncertainBoundary(spectator, 'opening');
        await expect(page.getByText('Voting open')).toBeVisible({ timeout: 15_000 });
        await expect(guest.getByText('Voting open')).toBeVisible();
        const schedule = await page.locator('time').allTextContents();
        expect(schedule).toHaveLength(2);
        await expect(guest.locator('time')).toHaveText(schedule);
        await expect(spectator.getByText('Yes 0 · No 0 · Your vote: pending')).toBeVisible();
        await spectator.route(poll.url, (route) => route.abort('failed'), { times: 1 });
        let ballotAttempts = 0;
        await page.route(poll.url, async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            ballotAttempts++;
            if (ballotAttempts === 2) {
                const receipt = await route.fetch();
                expect(await receipt.json()).toMatchObject({ yes: 1, no: 0, disposition: 'accepted' });
            }
            await route.abort('failed');
        });
        await page.getByRole('button', { name: 'Yes' }).click();
        await expect(page.getByText('The authority has no receipt yet for your vote.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'No', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Retry Yes' }).click();
        await expect(page.getByText('Yes 1 · No 0 · Your vote: accepted')).toBeVisible();
        expect(ballotAttempts).toBe(2);
        await expect(page.getByRole('button', { name: 'Yes', exact: true })).toBeDisabled();
        await guest.route(poll.url, async (route) => {
            if (route.request().method() === 'POST') {
                voteSent.resolve();
                await releaseVote.promise;
            }
            await route.continue();
        });
        await guest.getByRole('button', { name: 'No' }).click();
        await voteSent.promise;
        await expectUncertainBoundary(spectator, 'closing');
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        await expect(page.getByText('Recovering room poll')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Yes' })).toBeDisabled();
        await expect(spectator.getByText('Final results unavailable · Retrying')).toBeVisible({ timeout: 25_000 });
        await expect(spectator.getByText('Yes 1 · No 0 · Your vote: pending')).toBeVisible();
        await expect(spectator.getByText('Voting closed · Results')).toBeVisible();
        releaseVote.resolve();
        await expect(guest.getByText('Yes 1 · No 0 · Your vote: late')).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await expect(page.getByText('Voting closed · Results')).toBeVisible();
        await expect(page.getByText('Yes 1 · No 0 · Your vote: accepted')).toBeVisible();
        await expect(page.locator('time')).toHaveText(schedule);
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
        await spectator.close();
        await guest.close();
        await poll.close();
    }

    async function mount(member: Page, grant: string): Promise<void> {
        await member.evaluate(async ({ viewUrl, rallarUrl, roomRef, endpoint, grant, apiBaseUrl, authority }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
            rallar.configure({ apiBaseUrl });
            rallar.setDefaults(roomRef);
            const { showPoll }: typeof import('../../../examples/shared-deadline-poll/show-poll.ts') = await import(
                viewUrl
            );
            await showPoll({
                root: document.querySelector('main')!,
                roomRef,
                endpoint,
                participantGrant: grant,
                authority
            });
        }, {
            viewUrl,
            rallarUrl,
            roomRef,
            endpoint: poll.url,
            grant,
            apiBaseUrl: config.apiBaseUrl,
            authority: { maxAuthorityOffsetMs: Math.abs(enforcementOffsetMs) }
        });
    }
});

for (const disposition of ['accepted', 'late'] as const) {
    test(`fallback ballot is ${disposition} at authority receipt`, async ({ page, browser, baseURL }) => {
        test.skip(!config.enabled, config.skipReason);
        const voter = await browser.newPage({ baseURL });
        const roomRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: 'ballot-' + uniqueSuffix()
        };
        let receiptTime = 99;
        const schedule = { opensAtEpochMs: 90, closesAtEpochMs: 100 };
        const poll = new PollAuthority(roomRef, schedule, () => receiptTime);
        try {
            await Promise.all([prepareMember(page, roomRef, true), prepareMember(voter, roomRef, false)]);
            await page.evaluate(async ({ rallarUrl, roomRef }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
                await rallar.rooms.createAndSwitch({
                    groupId: roomRef.groupId,
                    joinMode: 'open',
                    displayName: 'Ballots'
                });
            }, { rallarUrl, roomRef });
            const voterSession = await voter.evaluate(async ({ rallarUrl, roomRef }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
                await rallar.rooms.enter(roomRef);
                return rallar.session()!.sessionId;
            }, { rallarUrl, roomRef });
            const arrivals: { msgId: string; expiresAtMs: number; }[] = [];
            await page.exposeFunction('receivePollBallot', (arrival: {
                msgId: string;
                expiresAtMs: number;
                senderId: string;
                choice: PollAuthority.Choice;
            }) => {
                expect(arrival.senderId).toBe(voterSession);
                arrivals.push(arrival);
                poll.vote(config.userB.username, arrival.choice);
            });
            await page.evaluate(async ({ rallarUrl, roomRef }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
                const room = await rallar.rooms.enter(roomRef);
                room.message<PollAuthority.Choice>('ballot').onWs(async (choice, message) => {
                    if (message.roomId !== roomRef.groupId || (choice !== 'yes' && choice !== 'no')) {
                        return;
                    }
                    await window.receivePollBallot({
                        msgId: message.raw.id.msgId,
                        expiresAtMs: message.raw.constraints?.expiresAtMs,
                        senderId: message.senderId,
                        choice
                    });
                });
            }, { rallarUrl, roomRef });
            await voter.exposeFunction('loseBallotRtcRoute', () => {
                if (disposition === 'late') {
                    receiptTime = schedule.closesAtEpochMs;
                }
            });
            const original = await voter.evaluate(async ({ rallarUrl, roomRef }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
                const room = await rallar.rooms.enter(roomRef);
                const channel = room.message<PollAuthority.Choice>('ballot');
                const manager = (await rallar.connect()).middleware.webRtcOverlayMulticastManager;
                const enqueue = manager.enqueueLegIfAbsent;
                const sent: { msgId: string; expiresAtMs: number | undefined; }[] = [];
                manager.enqueueLegIfAbsent = async function (message, gap) {
                    if (message.payload.typeId !== 'room.ballot.v1') {
                        return await enqueue.call(this, message, gap);
                    }
                    sent.push({ msgId: message.id.msgId, expiresAtMs: message.constraints?.expiresAtMs });
                    await window.loseBallotRtcRoute();
                    return {
                        verdict: { kind: 'unroutable', reason: 'no-route', detail: 'Fixture RTC route loss' },
                        message,
                        entries: [],
                        trackedReceiptAlgo: 'none'
                    };
                };
                try {
                    for (const choice of ['yes', 'no'] as const) {
                        const handle = await channel.send(choice, { strategy: 'rtc-with-ws-fallback', ttlMs: 30_000 });
                        await handle.wait({
                            until: ['queued', 'accepted', 'acknowledged', 'transport-accepted'],
                            timeoutMs: 5_000
                        });
                    }
                }
                finally {
                    manager.enqueueLegIfAbsent = enqueue;
                }
                return sent;
            }, { rallarUrl, roomRef });
            expect(original).toHaveLength(2);
            for (const ballot of original) {
                expect(ballot.expiresAtMs).toEqual(expect.any(Number));
            }
            await expect.poll(() => arrivals.map(({ msgId, expiresAtMs }) => ({ msgId, expiresAtMs }))).toEqual(
                original
            );
            expect(poll.read(config.userB.username)).toMatchObject({
                schedule,
                disposition,
                yes: disposition === 'accepted' ? 1 : 0,
                no: 0
            });
        }
        finally {
            await voter.close();
        }
    });
}

async function expectUncertainBoundary(page: Page, boundary: 'opening' | 'closing'): Promise<void> {
    await expect.poll(() =>
        page.evaluate(async ({ rallarUrl, boundary }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(rallarUrl);
            const [opening, closing] = document.querySelectorAll('main time');
            const cutoff = Date.parse((boundary === 'opening' ? opening : closing).getAttribute('datetime')!);
            const plain = rallar.compareDeadline(cutoff);
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('main button'));
            return {
                plain,
                uncertain: document.querySelector('main')?.textContent?.includes('Voting boundary uncertain'),
                disabled: buttons.length === 2 && buttons.every((button) => button.disabled)
            };
        }, { rallarUrl, boundary }), { timeout: 20_000, intervals: [100] }).toEqual({
            plain: boundary === 'opening' ? 'at-or-after' : 'before',
            uncertain: true,
            disabled: true
        });
}

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
    const authorityNow = () => Date.now() + enforcementOffsetMs;
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
            const startsAt = authorityNow();
            poll = new PollAuthority(
                roomRef,
                { opensAtEpochMs: startsAt + 9_000, closesAtEpochMs: startsAt + 24_000 },
                authorityNow
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
