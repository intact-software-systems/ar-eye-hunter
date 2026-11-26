import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { GroupRef } from '@shared/api/group-types.ts';
import { readFullStackConfig } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const sharedWeb = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/', import.meta.url));
const pageUrl = '/@fs' + fileURLToPath(new URL('../../../examples/room-scoreboard/index.html', import.meta.url));

async function openEvent(page: Page, lobby: GroupRef, invitationSecret?: string) {
    await page.goto(pageUrl);
    return page.evaluateHandle(async ({ lobby, invitationSecret, sharedWeb, apiBaseUrl }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sharedWeb + 'rallar.ts');
        const { RallarRoomEvent }: typeof import('@shared-web/browser/rooms/events/rallar-room-event.ts') =
            await import(sharedWeb + 'rooms/events/rallar-room-event.ts');
        const { createRoomGuestSecret, redeemRoomGuestInvitation }: typeof import('@shared-web/browser/rooms/entry/redeem-guest-invitation.ts') =
            await import(sharedWeb + 'rooms/entry/redeem-guest-invitation.ts');
        rallar.configure({ apiBaseUrl });
        rallar.setDefaults({ applicationId: lobby.applicationId, workspaceId: lobby.workspaceId });
        if (invitationSecret) {
            const access = await redeemRoomGuestInvitation(lobby, { guestSecret: createRoomGuestSecret(), invitationSecret }, { requestId: crypto.randomUUID() });
            await rallar.auth.activateGuest({ room: lobby, access, username: 'Guest' });
            await rallar.connect();
            await rallar.rooms.join(lobby, { presenceOnly: true });
        } else {
            await rallar.auth.login({ username: 'admin', password: 'admin' });
            await rallar.connect();
            await rallar.rooms.createAndSwitch({ ...lobby, displayName: 'Pickup event', joinMode: 'invite-only', directoryListing: 'unlisted' });
        }
        const event = new RallarRoomEvent(rallar, lobby);
        await event.start();
        return { event, rallar, createRoomGuestSecret };
    }, { lobby, invitationSecret, sharedWeb, apiBaseUrl: config.apiBaseUrl });
}

test('a temporary player enters their assigned court, returns to the lobby and recovers a missed removal', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const lobby = { applicationId: 'club', workspaceId: crypto.randomUUID(), groupId: 'lounge' };
    const operator = await openEvent(page, lobby);
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
    try {
        const guest = await openEvent(guestPage, lobby, invitation);
        const guestId = await guest.evaluate(({ rallar }) => rallar.session()!.clientId);
        await guest.evaluate(async ({ event }, guestId) => {
            await event.act({ action: 'propose', players: [guestId], partyId: 'walkup' });
            if (event.getState().error) throw new Error(event.getState().error!);
            await event.enterCourt();
        }, guestId);
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
        await guestPage.close();
    }
});
