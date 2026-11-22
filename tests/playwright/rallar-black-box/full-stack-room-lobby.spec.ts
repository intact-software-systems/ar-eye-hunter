import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { StateScope } from '@shared/api/state-types.ts';
import { readFullStackConfig, type FullStackUser } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
const observerUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rooms/lobby/rallar-room-lobby.ts', import.meta.url));
const pageUrl = '/@fs' + fileURLToPath(new URL('../../../examples/room-scoreboard/index.html', import.meta.url));

async function signIn(page: Page, user: FullStackUser, scope: StateScope) {
    await page.goto(pageUrl);
    return page.evaluateHandle(async ({ username, password, apiBaseUrl, scope, sdkUrl, observerUrl }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
        const { RallarRoomLobby }: typeof import('@shared-web/browser/rooms/lobby/rallar-room-lobby.ts') = await import(observerUrl);
        rallar.configure({ apiBaseUrl });
        rallar.setDefaults(scope);
        await rallar.auth.login({ username, password });
        await rallar.connect();
        const lobby = new RallarRoomLobby(rallar, scope);
        await lobby.start();
        return { lobby, rooms: rallar.rooms };
    }, { username: user.username, password: user.password, apiBaseUrl: config.apiBaseUrl, scope, sdkUrl, observerUrl });
}

test('a player keeps a private seat in another room and recovers a missed return-window cancellation', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guestPage = await browser.newPage({ baseURL });
    const thirdPage = await browser.newPage({ baseURL });
    const scope = { applicationId: 'room-scoreboard', workspaceId: crypto.randomUUID() };
    const court = { ...scope, groupId: 'court' };
    const lounge = { ...scope, groupId: 'lounge' };
    try {
        const [owner, guest, third] = await Promise.all([
            signIn(page, config.userA, scope), signIn(guestPage, config.userB, scope), signIn(thirdPage, config.userC, scope)
        ]);
        await owner.evaluate(async ({ rooms }, room) => {
            await rooms.createAndSwitch({ ...room, displayName: 'Court', joinMode: 'open', maxMembers: 3,
                roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 } });
        }, court);
        await third.evaluate(async ({ rooms }, room) => {
            await rooms.createAndSwitch({ ...room, displayName: 'Lounge', joinMode: 'open' });
        }, lounge);
        await guest.evaluate(async ({ rooms }, room) => { await rooms.enter(room); }, court);
        const seat = () => guest.evaluate(({ lobby }) => lobby.getState().view?.seat);
        await expect.poll(seat).toEqual({ roomRef: court, status: 'present', deadlineEpochMs: null });
        await guest.evaluate(async ({ rooms }, room) => { await rooms.enter(room); }, lounge);
        await expect.poll(seat).toEqual({ roomRef: court, status: 'away', deadlineEpochMs: null });
        await third.evaluate(async ({ rooms }, room) => { await rooms.enter(room, { preserveCurrentMembership: true }); }, court);
        await expect.poll(seat).toEqual({ roomRef: court, status: 'away', deadlineEpochMs: expect.any(Number) });
        await guest.evaluate(async ({ rooms }, room) => { await rooms.enter(room); }, court);
        await expect.poll(seat).toEqual({ roomRef: court, status: 'present', deadlineEpochMs: null });
        await guest.evaluate(async ({ rooms }, room) => { await rooms.enter(room); }, lounge);
        await expect.poll(seat).toMatchObject({ status: 'away', deadlineEpochMs: expect.any(Number) });
        await guest.evaluate(({ lobby }) => lobby.stop());
        await third.evaluate(async ({ lobby }, room) => {
            await lobby.release(room);
            if (lobby.getState().error) throw new Error(lobby.getState().error!);
        }, court);
        await guest.evaluate(async ({ lobby }) => { await lobby.start(); });
        expect(await seat()).toEqual({ roomRef: court, status: 'away', deadlineEpochMs: null });
        expect(await guest.evaluate(({ rooms }) => rooms.selected())).toMatchObject(lounge);
    }
    finally {
        await Promise.all([guestPage.close(), thirdPage.close()]);
    }
});
