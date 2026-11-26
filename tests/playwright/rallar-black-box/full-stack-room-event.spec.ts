import { controlRoomConnection } from './control-room-connection.ts';
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { GroupRef } from '@shared/api/group-types.ts';
import { readFullStackConfig } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const sharedWeb = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/', import.meta.url));
const pageUrl = '/@fs' + fileURLToPath(new URL('../../../examples/room-scoreboard/index.html', import.meta.url));

async function openEvent(page: Page, lobby: GroupRef, entry: 'create' | 'return' | { invitationSecret: string } | { username: string; password: string }) {
    await page.goto(pageUrl);
    return page.evaluateHandle(async ({ lobby, entry, sharedWeb, apiBaseUrl }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sharedWeb + 'rallar.ts');
        const { RallarRoomEvent }: typeof import('@shared-web/browser/rooms/events/rallar-room-event.ts') =
            await import(sharedWeb + 'rooms/events/rallar-room-event.ts');
        const { createRoomGuestSecret, redeemRoomGuestInvitation }: typeof import('@shared-web/browser/rooms/entry/redeem-guest-invitation.ts') =
            await import(sharedWeb + 'rooms/entry/redeem-guest-invitation.ts');
        rallar.configure({ apiBaseUrl });
        rallar.setDefaults({ applicationId: lobby.applicationId, workspaceId: lobby.workspaceId });
        if (typeof entry === 'object' && 'invitationSecret' in entry) {
            const access = await redeemRoomGuestInvitation(lobby, { guestSecret: createRoomGuestSecret(), invitationSecret: entry.invitationSecret }, { requestId: crypto.randomUUID() });
            await rallar.auth.activateGuest({ room: lobby, access, username: 'Guest' });
            await rallar.connect();
            await rallar.rooms.join(lobby, { presenceOnly: true });
        } else {
            await rallar.auth.login(typeof entry === 'object' ? entry : { username: 'admin', password: 'admin' });
            await rallar.connect();
            if (entry === 'create') {
                await rallar.rooms.createAndSwitch({ ...lobby, displayName: 'Pickup event', joinMode: 'invite-only', directoryListing: 'unlisted' });
            } else {
                if (typeof entry === 'object') await rallar.rooms.acceptInvite(lobby);
                await rallar.rooms.join(lobby, { presenceOnly: true });
            }
        }
        const event = new RallarRoomEvent(rallar, lobby);
        await event.start();
        return { event, rallar, createRoomGuestSecret };
    }, { lobby, entry, sharedWeb, apiBaseUrl: config.apiBaseUrl });
}

test('temporary friends consent to one party, independently enter their court and recover a missed removal', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const lobby = { applicationId: 'club', workspaceId: crypto.randomUUID(), groupId: 'lounge' };
    const operator = await openEvent(page, lobby, 'create');
    const invitation = await operator.evaluate(async ({ event, rallar, createRoomGuestSecret }, { lobby, invitationModule }) => {
        const { hashRoomInvitationSecret }: typeof import('@shared/api/room-guests/invitation.ts') = await import(invitationModule);
        const secret = createRoomGuestSecret();
        const verifier = await hashRoomInvitationSecret(secret);
        await rallar.rooms.update({ roomRef: lobby, guestInvitationVerifier: verifier });
        await event.act({ action: 'create', courts: [{ groupId: 'first', capacity: 2 }, { groupId: 'second', capacity: 2 }],
            closesAt: Date.now() + 120_000 });
        if (event.getState().error) throw new Error(event.getState().error!);
        return secret;
    }, { lobby, invitationModule: '/@fs' + fileURLToPath(new URL('../../../packages/shared/api/room-guests/invitation.ts', import.meta.url)) });
    const guestPage = await browser.newPage({ baseURL });
    const friendPage = await browser.newPage({ baseURL });
    try {
        const guest = await openEvent(guestPage, lobby, { invitationSecret: invitation });
        const guestId = await guest.evaluate(({ rallar }) => rallar.session()!.clientId);
        const friend = await openEvent(friendPage, lobby, { invitationSecret: invitation });
        const friendId = await friend.evaluate(({ rallar }) => rallar.session()!.clientId);
        await guest.evaluate(({ event }, players) => event.act({ action: 'propose', players, partyId: 'friends' }), [guestId, friendId]);
        await expect.poll(() => friend.evaluate(({ event }) => event.getState().view?.proposals[0]?.id)).toBe('friends');
        expect(await guest.evaluate(({ event }) => event.getState().view?.offer)).toBeNull();
        await friend.evaluate(async ({ event }) => {
            const proposal = event.getState().view!.proposals[0];
            await event.act({ action: 'accept', partyId: proposal.id, proposalRevision: proposal.proposalRevision });
            if (event.getState().error) throw new Error(event.getState().error!);
        });
        await expect.poll(() => guest.evaluate(({ event }) => event.getState().view?.offer?.groupId)).toBe('first');
        await guest.evaluate(({ event }) => event.enterCourt());
        expect(await friend.evaluate(({ rallar }) => rallar.rooms.selected()?.groupId)).toBe('lounge');
        await friend.evaluate(({ event }) => event.enterCourt());
        expect(await friend.evaluate(({ rallar }) => [rallar.session()!.clientId, rallar.rooms.selected()?.groupId])).toEqual([friendId, 'first']);
        await expect.poll(() => guest.evaluate(({ rallar }) => rallar.rooms.selected()?.groupId)).toBe('first');
        expect(await guest.evaluate(({ rallar }) => rallar.session()!.clientId)).toBe(guestId);
        await guest.evaluate(({ event }) => event.returnToLobby());
        await expect.poll(() => guest.evaluate(({ rallar }) => rallar.rooms.selected()?.groupId)).toBe('lounge');
        await guestPage.context().setOffline(true);
        await guest.evaluate(({ rallar }) => rallar.disconnect());
        await operator.evaluate(({ event }) => event.act({ action: 'release', groupId: 'first', occurrence: 1, requeue: true }));
        await guestPage.context().setOffline(false);
        await guest.evaluate(({ rallar }) => rallar.connect().then(() => undefined));
        await expect.poll(() => guest.evaluate(({ event }) => event.getState().view?.offer?.occurrence)).toBe(2);
        await guest.evaluate(({ event }) => event.stop());
        await operator.evaluate(({ event }, targetId) => event.act({ action: 'remove', targetId }), guestId);
        await guest.evaluate(({ event }) => event.start());
        await expect.poll(() => guest.evaluate(({ event }) => event.getState().view)).toBeNull();
        await expect.poll(() => guest.evaluate(({ event }) => event.getState().error)).toContain('403');
    } finally {
        await Promise.all([guestPage.close(), friendPage.close()]);
    }
});

test('a signed-in player re-enters their claimed court from a second browser', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const lobby = { applicationId: 'club', workspaceId: crypto.randomUUID(), groupId: 'lounge' };
    const first = await openEvent(page, lobby, 'create');
    const assignment = await first.evaluate(async ({ event, rallar }) => {
        await event.act({ action: 'create', courts: [{ groupId: 'court', capacity: 1 }], closesAt: Date.now() + 120_000 });
        await event.act({ action: 'propose', players: [rallar.session()!.clientId], partyId: 'solo' });
        await event.enterCourt();
        return event.getState().view?.offer;
    });
    expect(assignment).toMatchObject({ groupId: 'court', deadline: null });

    await first.evaluate(({ rallar }) => rallar.disconnect());
    const returningPage = await browser.newPage({ baseURL });
    try {
        const returning = await openEvent(returningPage, lobby, 'return');
        expect(await returning.evaluate(({ event }) => event.getState().view?.offer)).toEqual(assignment);
        await returning.evaluate(({ event }) => event.enterCourt());
        expect(await returning.evaluate(({ rallar }) => rallar.rooms.selected()?.groupId)).toBe('court');
        expect(await returning.evaluate(({ event }) => event.getState().view?.offer)).toEqual(assignment);
    } finally {
        await returningPage.close();
    }
});

test('a guest opening a court alert sees the current allocation and can requeue after expiry', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const lobby = { applicationId: 'club', workspaceId: crypto.randomUUID(), groupId: 'pickup' };
    const operator = await openEvent(page, lobby, 'create');
    const invitationSecret = await operator.evaluate(async ({ event, rallar, createRoomGuestSecret }, { lobby, invitationModule }) => {
        const { hashRoomInvitationSecret }: typeof import('@shared/api/room-guests/invitation.ts') = await import(invitationModule);
        const secret = createRoomGuestSecret();
        await rallar.rooms.update({ roomRef: lobby, guestInvitationVerifier: await hashRoomInvitationSecret(secret) });
        await event.act({ action: 'create', courts: [{ groupId: 'east', capacity: 1 }], closesAt: Date.now() + 120_000 });
        return secret;
    }, { lobby, invitationModule: '/@fs' + fileURLToPath(new URL('../../../packages/shared/api/room-guests/invitation.ts', import.meta.url)) });
    const guest = await browser.newPage({ baseURL });
    try {
        await guest.route('**/event.json', route => route.fulfill({ json: { lobby, invitationSecret, apiBaseUrl: config.apiBaseUrl } }));
        const exampleUrl = '/@fs' + fileURLToPath(new URL('../../../examples/pickup-event/index.html', import.meta.url));
        await guest.goto(exampleUrl);
        await guest.getByRole('button', { name: 'Join event' }).click();
        await guest.getByRole('button', { name: 'Join queue' }).click();
        await expect(guest.getByRole('button', { name: 'Enter east' })).toBeVisible();
        const alert = { type:'rallar-court-ready', lobby, offerRevision:2, tag:'a'.repeat(32) };
        const launch = exampleUrl + '#' + new URLSearchParams({courtAlert:JSON.stringify(alert)});
        await guest.goto(launch);
        await guest.reload();
        await expect(guest.getByRole('button', { name: 'Enter east' })).toBeVisible();
        await operator.evaluate(({ event }) => event.act({action:'release',groupId:'east',occurrence:1,requeue:false}));
        await expect(guest.getByRole('status')).toContainText('Your earlier offer has expired.');
        await guest.getByRole('button', {name:'Join queue'}).click();
        await expect(guest.getByRole('button', {name:'Enter east'})).toBeVisible();
    } finally { await guest.close(); }
});

test('organizer follows the other court from their own court and recovers a missed expiry', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const lobby = { applicationId: 'club', workspaceId: crypto.randomUUID(), groupId: 'pickup' };
    const connection = await controlRoomConnection(page, config.apiBaseUrl);
    const host = await openEvent(page, lobby, 'create');
    const invitation = await host.evaluate(async ({ event, rallar, createRoomGuestSecret }, { lobby, invitationModule }) => {
        const { hashRoomInvitationSecret }: typeof import('@shared/api/room-guests/invitation.ts') = await import(invitationModule);
        const secret = createRoomGuestSecret();
        await rallar.rooms.update({ roomRef: lobby, guestInvitationVerifier: await hashRoomInvitationSecret(secret) });
        await event.act({ action: 'create', courts: [{ groupId: 'north', capacity: 1 }, { groupId: 'south', capacity: 2 }],
            closesAt: Date.now() + 120_000, claimWindowMs: 12_000 });
        await event.act({ action: 'propose', partyId: 'operator', players: [rallar.session()!.clientId] });
        await event.enterCourt();
        return secret;
    }, { lobby, invitationModule: '/@fs' + fileURLToPath(new URL('../../../packages/shared/api/room-guests/invitation.ts', import.meta.url)) });
    const playerPage = await browser.newPage({ baseURL });
    const waitingPage = await browser.newPage({ baseURL });
    try {
        const player = await openEvent(playerPage, lobby, { invitationSecret: invitation });
        const waiting = await openEvent(waitingPage, lobby, { invitationSecret: invitation });
        await page.getByLabel('Event lobby').fill(lobby.groupId);
        await page.getByRole('button', { name: 'Watch event' }).click();
        const roster = page.getByRole('region', { name: 'Organizer roster' });
        await expect(roster).toContainText('north');
        await player.evaluate(async ({ event, rallar }) => {
            await event.act({ action: 'propose', partyId: 'runners', players: [rallar.session()!.clientId] });
            await event.enterCourt();
        });
        await expect(roster).toContainText('runners');
        await waiting.evaluate(({ event, rallar }) => event.act({ action: 'propose', partyId: 'waiting-player', players: [rallar.session()!.clientId] }));
        await expect(roster).toContainText('waiting-player');
        await connection.disconnect();
        await expect.poll(() => waiting.evaluate(({ event }) => event.getState().view?.offer), { timeout: 25_000 }).toBeNull();
        await connection.reconnect();
        await expect(roster).not.toContainText('waiting-player');
        await expect(roster).toContainText('runners');
        expect(await host.evaluate(({ rallar }) => rallar.rooms.selected()?.groupId)).toBe('north');
    } finally {
        await Promise.all([playerPage.close(), waitingPage.close()]);
    }
});

test('accepting handover on a second court recovers control after the original organizer disconnects', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const lobby = { applicationId: 'club', workspaceId: crypto.randomUUID(), groupId: 'pickup' };
    const connection = await controlRoomConnection(page, config.apiBaseUrl);
    const original = await openEvent(page, lobby, 'create');
    const recipientPage = await browser.newPage({ baseURL });
    try {
        await original.evaluate(({ rallar }, { lobby, recipient }) => rallar.rooms.invite(lobby, recipient), { lobby, recipient: config.userB.clientId });
        const recipient = await openEvent(recipientPage, lobby, { username: config.userB.username, password: config.userB.password });
        await original.evaluate(({ event }) => event.act({ action: 'create', courts: [
            { groupId: 'north', capacity: 1 }, { groupId: 'south', capacity: 1 }
        ], closesAt: Date.now() + 180_000 }));
        for (const player of [original, recipient]) {
            await player.evaluate(async ({ event, rallar }) => {
                const id = rallar.session()!.clientId;
                await event.act({ action: 'propose', partyId: id, players: [id] });
                await event.enterCourt();
            });
        }
        const court = { ...lobby, groupId: 'north' };
        const clock = await original.evaluate(async ({ rallar }, court) => {
            const director = await rallar.director.appoint(court);
            await rallar.rooms.changeClock(court, { operation: 'start', expectedDirectorEpoch: director.appointment!.epoch,
                expectedRevision: 0, name: 'match', durationMs: 120_000 }, crypto.randomUUID());
            return rallar.rooms.readClock(court, 'match');
        }, court);
        expect(clock).toMatchObject({ revision: 1, status: 'running' });
        for (const client of [page, recipientPage]) {
            await client.getByLabel('Event lobby').fill(lobby.groupId);
            await client.getByRole('button', { name: 'Watch event' }).click();
        }
        const roster = page.getByRole('region', { name: 'Organizer roster' });
        await expect(roster).toContainText('south');
        await page.getByLabel('Next organizer').selectOption(config.userB.clientId);
        await page.getByRole('button', { name: 'Offer handover' }).click();
        const accept = recipientPage.getByRole('button', { name: 'Accept handover' });
        await expect(accept).toBeVisible();
        await connection.disconnect();
        await accept.click();
        const nextRoster = recipientPage.getByRole('region', { name: 'Organizer roster' });
        await expect(nextRoster).toContainText('north');
        await expect(nextRoster).toContainText('south');
        expect(await recipient.evaluate(({ rallar }) => rallar.rooms.selected()?.groupId)).toBe('south');
        await connection.reconnect();
        await expect(roster).not.toContainText('south');
        expect(await original.evaluate(({ rallar }, court) => rallar.rooms.readClock(court, 'match'), court)).toEqual(clock);
        await original.evaluate(({ event }) => event.act({ action: 'close' }));
        await expect.poll(() => original.evaluate(({ event }) => event.getState().error)).toBeTruthy();
        expect(await recipient.evaluate(async ({ event }) => {
            await event.refresh();
            return event.getState().view?.closed;
        })).toBe(false);
    } finally { await recipientPage.close(); }
});
