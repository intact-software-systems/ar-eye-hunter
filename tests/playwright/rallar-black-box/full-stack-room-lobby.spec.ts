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

for (const feature of ['lobby', 'director succession'] as const) {
    test(`an owner updates ordinary room metadata with ${feature} enabled`, async ({ page }) => {
        test.skip(!config.enabled, config.skipReason);
        const scope = { applicationId: 'club', workspaceId: crypto.randomUUID() };
        const room = { ...scope, groupId: 'court' };
        const host = await signIn(page, config.userA, scope);
        const result = await host.evaluate(async ({ rooms }, { room, feature }) => {
            await rooms.createAndSwitch({
                ...room, displayName: 'Court', joinMode: 'open', maxMembers: 2,
                ...(feature === 'lobby' && { roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 } })
            });
            if (feature === 'director succession') {
                const director = await rooms.readDirector(room);
                await rooms.changeDirector(room, {
                    operation: 'configure', expectedDirectorEpoch: director.appointment?.epoch ?? 0,
                    expectedRevision: 0, deputyPrincipalId: null
                }, crypto.randomUUID());
            }
            const updated = await rooms.updateMetadata(room, { courtLabel: 'Final' });
            return updated.group.metadata;
        }, { room, feature });
        expect(result.courtLabel).toBe('Final');
        if (feature === 'lobby') {
            expect(result.rallarRoomLobby).toMatchObject({ returnWindowMs: 120000, claimWindowMs: 60000 });
        } else {
            expect(result.rallarDirectorSuccession).toMatchObject({ deputyPrincipalId: null });
        }
    });
}

test('a returning participant recovers a registration cutoff shifted with the room program', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const scope = { applicationId: 'club', workspaceId: crypto.randomUUID() };
    const court = { ...scope, groupId: 'court' };
    const lounge = { ...scope, groupId: 'lounge' };
    const guestPage = await browser.newPage({ baseURL });
    try {
        const host = await signIn(page, config.userA, scope);
        const guest = await signIn(guestPage, config.userB, scope);
        await host.evaluate(({ rooms }, room) => rooms.createAndSwitch({
            ...room, displayName: 'Court', joinMode: 'open', maxMembers: 3,
            roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 }
        }), court);
        await guest.evaluate(async ({ rooms }, { court, lounge }) => {
            await rooms.enter(court);
            await rooms.createAndSwitch({ ...lounge, displayName: 'Lounge', joinMode: 'open' });
        }, { court, lounge });
        const start = await page.waitForFunction(async url => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(url);
            return rallar.deadlineAfter(120000) ?? 0;
        }, sdkUrl);
        const shifted = await host.evaluate(async ({ lobby, rooms }, { room, sdkUrl, startsAtEpochMs }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const director = await rallar.director.appoint(room);
            const control = { name: 'match', expectedDirectorEpoch: director.appointment!.epoch };
            const program = await rooms.publishSchedule(room, { ...control, expectedRevision: 0,
                phases: [{ phase: 'warmup', startsAtEpochMs: 0 }, { phase: 'play', startsAtEpochMs }]
            }, crypto.randomUUID());
            await lobby.setRegistrationBoundary(room, { expectedRevision: 0, expectedProgramRevision: program.revision,
                program: 'match', phase: 'play' });
            const paused = await rooms.pauseProgram(room, { ...control, expectedRevision: program.revision }, crypto.randomUUID());
            const resumed = await rooms.resumeProgram(room, { ...control, expectedRevision: paused.revision }, crypto.randomUUID());
            return resumed.phases[1]!.startsAtEpochMs;
        }, { room: court, sdkUrl, startsAtEpochMs: await start.jsonValue() });
        expect(shifted).toBeGreaterThan(await start.jsonValue());
        const registration = await guest.evaluate(async ({ rooms }, { room, sdkUrl, observerUrl }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const { RallarRoomLobby }: typeof import('@shared-web/browser/rooms/lobby/rallar-room-lobby.ts') = await import(observerUrl);
            const current = await rooms.enter(room, { preserveCurrentMembership: true });
            const snapshot = (await current.refresh()).snapshot()!;
            return RallarRoomLobby.registration(snapshot.group.metadata, rallar);
        }, { room: court, sdkUrl, observerUrl });
        expect(registration).toMatchObject({ boundary: { program: 'match', phase: 'play' }, atEpochMs: shifted });
    } finally {
        await guestPage.close();
    }
});

test('waiting players receive exclusive offers in order while visiting another room', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const bobPage = await browser.newPage({ baseURL });
    const chrisPage = await browser.newPage({ baseURL });
    const scope = { applicationId: 'club', workspaceId: crypto.randomUUID() };
    const court = { ...scope, groupId: 'court' };
    const lounge = { ...scope, groupId: 'lounge' };
    try {
        const [host, bob, chris] = await Promise.all([
            signIn(page, config.userA, scope), signIn(bobPage, config.userB, scope), signIn(chrisPage, config.userC, scope)
        ]);
        await host.evaluate(async ({ rooms }, ref) => {
            await rooms.createAndSwitch({ ...ref, displayName: 'Court', joinMode: 'open', maxMembers: 1,
                roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 } });
        }, court);
        await bob.evaluate(async ({ rooms }, ref) => {
            await rooms.createAndSwitch({ ...ref, displayName: 'Lounge', joinMode: 'open' });
        }, lounge);
        await chris.evaluate(async ({ rooms }, ref) => { await rooms.enter(ref); }, lounge);
        for (const player of [bob, chris]) {
            await player.evaluate(async ({ lobby }, ref) => { await lobby.wait(ref); }, court);
            expect(await player.evaluate(({ lobby }) => lobby.getState().view?.seat)).toEqual({
                roomRef: court, status: 'waiting', deadlineEpochMs: null
            });
        }
        await host.evaluate(async ({ lobby }, ref) => { await lobby.release(ref); }, court);
        await expect.poll(() => bob.evaluate(({ lobby }) => lobby.getState().view?.seat?.status)).toBe('offered');
        expect(await chris.evaluate(({ lobby }) => lobby.getState().view?.seat?.status)).toBe('waiting');
        await chris.evaluate(({ lobby }) => lobby.stop());
        await bob.evaluate(async ({ lobby }, ref) => { await lobby.release(ref); }, court);
        await chris.evaluate(async ({ lobby }) => { await lobby.start(); });
        expect(await chris.evaluate(({ lobby }) => lobby.getState().view?.seat)).toEqual({
            roomRef: court, status: 'offered', deadlineEpochMs: expect.any(Number)
        });
        expect(await chris.evaluate(({ rooms }) => rooms.selected())).toMatchObject(lounge);
        await chris.evaluate(async ({ rooms }, ref) => { await rooms.enter(ref); }, court);
        await expect.poll(() => chris.evaluate(({ lobby }) => lobby.getState().view?.seat)).toEqual({
            roomRef: court, status: 'present', deadlineEpochMs: null
        });
    } finally {
        await Promise.all([bobPage.close(), chrisPage.close()]);
    }
});

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
