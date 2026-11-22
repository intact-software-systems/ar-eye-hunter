import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFullStackConfig, type FullStackUser } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const url = '/@fs' + fileURLToPath(new URL('../../../examples/room-scoreboard/index.html', import.meta.url));

interface CourtParticipants {
    readonly page: Page;
    readonly guest: Page;
    readonly otherCourtOwner: Page;
    readonly court: string;
}

async function enterCourts({ page, guest, otherCourtOwner, court }: CourtParticipants) {
    for (const [screen, user, action, groupId] of [
        [otherCourtOwner, config.userA, 'Create room', court + '-other'],
        [page, config.userA, 'Create room', court],
        [guest, config.userB, 'Enter room', court]
    ] as const) {
        await screen.goto(url);
        await submitCourtEntry(screen, user, action, groupId);
    }
}

async function submitCourtEntry(screen: Page, user: FullStackUser, action: 'Create room' | 'Enter room', groupId: string) {
    await screen.getByLabel('Username').fill(user.username);
    await screen.getByLabel('Password').fill(user.password);
    await screen.getByLabel('Room', { exact: true }).fill(groupId);
    await screen.getByRole('button', { name: action }).click();
    await expect(screen.getByRole('heading', { name: groupId, exact: true })).toBeVisible();
}

test('a guest watches the same director renew the room lease', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    try {
        await page.goto(url);
        await page.evaluate(async ({ sdkUrl, room }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            rallar.setDefaults({
                applicationId: room.applicationId,
                workspaceId: room.workspaceId,
                groupPresence: { leaseMs: 30_000, renewalIntervalMs: 2_000, requestTimeoutMs: 3_000, retryMs: 1_000 }
            });
        }, { sdkUrl, room });
        await submitCourtEntry(page, config.userA, 'Create room', court);
        await guest.goto(url);
        await submitCourtEntry(guest, config.userB, 'Enter room', court);
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await expect(page.getByRole('button', { name: 'Start 10 minutes' })).toBeEnabled();
        const configured = await page.evaluate(async ({ sdkUrl, room }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const expectedDirectorEpoch = rallar.director.status(room).appointment!.epoch;
            return rallar.rooms.changeDirector(room, {
                operation: 'configure', expectedDirectorEpoch, expectedRevision: 0, deputyPrincipalId: null
            }, crypto.randomUUID());
        }, { sdkUrl, room });
        const watch = await guest.evaluateHandle(async ({ sdkUrl, room }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const leases: number[] = [];
            const stop = rallar.rooms.watchDirector(room, ({ status, value }) => {
                const lease = value?.succession?.directorLeaseExpiresAtEpochMs;
                if (status === 'current' && lease != null) leases.push(lease);
            });
            return { leases, stop };
        }, { sdkUrl, room });
        try {
            await expect.poll(() => watch.evaluate(state => state.leases.length)).toBeGreaterThan(0);
            const firstLease = await watch.evaluate(state => state.leases[0]!);
            await page.waitForResponse(response => {
                const path = new URL(response.url()).pathname;
                return path.includes('/groups/' + court + '/sessions/') && path.includes('/heartbeat/requests/') &&
                    response.request().method() === 'POST' && response.ok();
            });
            const renewed = await guest.evaluate(async ({ sdkUrl, room }) => {
                const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
                return rallar.rooms.readDirector(room);
            }, { sdkUrl, room });
            expect(renewed.appointment).toEqual(configured.appointment);
            expect(renewed.succession?.revision).toBe(configured.succession?.revision);
            const renewedLease = renewed.succession?.directorLeaseExpiresAtEpochMs;
            expect(renewedLease).toBeGreaterThan(firstLease);
            await expect.poll(() => watch.evaluate(state => state.leases.at(-1)), {
                timeout: 15_000,
                message: 'The guest watch must deliver the renewed lease while the same director stays connected'
            }).toBeGreaterThanOrEqual(renewedLease!);
        } finally {
            await watch.evaluate(state => state.stop());
        }
    } finally {
        await guest.close();
    }
});

test('an owner appoints a present participant and both browsers recover the same paused clock', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const otherCourtOwner = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    try {
        await enterCourts({ page, guest, otherCourtOwner, court });
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await page.getByRole('button', { name: 'Start 10 minutes' }).click();
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        const shown = await guest.getByLabel('Period clock').textContent();
        const target = await guest.evaluate(async path => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(path);
            const session = rallar.session()!;
            return { targetPrincipalId: session.clientId, targetSessionId: session.sessionId };
        }, sdkUrl);
        await page.evaluate(async ({ sdkUrl, room, target }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const expectedDirectorEpoch = rallar.director.status(room).appointment!.epoch;
            await rallar.rooms.changeDirector(room, { operation: 'configure', expectedDirectorEpoch, expectedRevision: 0,
                reconnectWindowMs: 30000, deputyWindowMs: 30000, deputyPrincipalId: target.targetPrincipalId }, crypto.randomUUID());
            await rallar.rooms.changeDirector(room, { operation: 'appoint', expectedDirectorEpoch, ...target }, crypto.randomUUID());
        }, { sdkUrl, room, target });
        await expect(guest.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
        await expect(guest.getByLabel('Period clock')).toHaveText(shown!);
        await guest.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(page.locator('#phase')).toHaveText('Running');
    } finally {
        await Promise.all([guest.close(), otherCourtOwner.close()]);
    }
});

test('a director returning from another court recovers the player who claimed and the preserved period', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const otherCourtOwner = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    try {
        await enterCourts({ page, guest, otherCourtOwner, court });
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await page.getByRole('button', { name: 'Start 10 minutes' }).click();
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        const frozen = await guest.getByLabel('Period clock').innerText();
        const load = (screen: Page) => screen.evaluateHandle(async path => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(path);
            return rallar;
        }, sdkUrl);
        const [organizer, player] = await Promise.all([load(page), load(guest)]);
        const epoch = await organizer.evaluate(async (sdk, room) => {
            const expectedDirectorEpoch = sdk.director.status(room).appointment!.epoch;
            await sdk.rooms.changeDirector(room, { operation: 'configure', expectedDirectorEpoch, expectedRevision: 0,
                reconnectWindowMs: 200, deputyWindowMs: 30000, deputyPrincipalId: null }, crypto.randomUUID());
            await sdk.rooms.enter({ ...room, groupId: room.groupId + '-other' }, { preserveCurrentMembership: true });
            return expectedDirectorEpoch;
        }, room);
        const until = await player.evaluate(async (sdk, ref) => (await sdk.rooms.readDirector(ref)).succession?.loss?.reconnectUntilEpochMs, room);
        expect(typeof until).toBe('number');
        await guest.waitForFunction(cutoff => Date.now() >= cutoff, until!);
        const claimed = await player.evaluate(async (sdk, { room, epoch }) =>
            sdk.rooms.changeDirector(room, { operation: 'claim-player', expectedDirectorEpoch: epoch }, crypto.randomUUID()), { room, epoch });
        expect(claimed.appointment?.epoch).toBe(epoch + 1);
        const recovered = await organizer.evaluate(async (sdk, ref) => {
            await sdk.rooms.enter(ref, { preserveCurrentMembership: true });
            return sdk.rooms.readDirector(ref);
        }, room);
        expect(recovered.appointment).toEqual(claimed.appointment);
        await expect(guest.getByLabel('Period clock')).toHaveText(frozen);
        await guest.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
    } finally {
        await Promise.all([guest.close(), otherCourtOwner.close()]);
    }
});

test('a returning participant recovers halftime and its paused clock together after visiting another court', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const otherCourtOwner = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    try {
        await enterCourts({ page, guest, otherCourtOwner, court });
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await page.getByRole('button', { name: 'Start 10 minutes' }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court + '-other');
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Ready');
        await page.getByRole('button', { name: 'Advance to halftime' }).click();
        await expect(page.getByLabel('Current period')).toHaveText('halftime');
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(page.locator('#phase')).toHaveText('Paused');
        const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
        const balance = await page.evaluate(async ({ sdkUrl, court }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
            const before = await rallar.rooms.readTimeline(room, 'match');
            if (before?.status !== 'paused') throw new Error('Expected paused halftime');
            const extension = { name: 'match', durationMs: 30_000, expectedRevision: before.revision,
                expectedDirectorEpoch: rallar.director.status(room).appointment!.epoch };
            const requestId = crypto.randomUUID();
            const accepted = await rallar.rooms.extendTimeline(room, extension, requestId);
            const replay = await rallar.rooms.extendTimeline(room, extension, requestId);
            return { before, accepted, replay };
        }, { sdkUrl, court });
        expect(balance.before.remainingMs).toBeGreaterThanOrEqual(120_000);
        expect(balance.before.remainingMs).toBeLessThanOrEqual(180_000);
        const updated = { ...balance.before, revision: balance.before.revision + 1, remainingMs: balance.before.remainingMs + 30_000 };
        expect(balance.accepted).toEqual(updated);
        expect(balance.replay).toEqual(updated);
        await expect(guest.locator('#phase')).toHaveText('Ready');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court);
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        await expect(guest.getByLabel('Current period')).toHaveText('halftime');
        const recovered = await guest.evaluate(async ({ sdkUrl, court }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            return rallar.rooms.readTimeline({ applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court }, 'match');
        }, { sdkUrl, court });
        expect(recovered).toEqual(updated);
        const seconds = Math.ceil(updated.remainingMs / 1000);
        await expect(guest.getByLabel('Period clock')).toHaveText(Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
        await expect(guest.getByRole('button', { name: 'Resume' })).toBeDisabled();
        // A scoreboard has no director relay. Its referee may resume after relay heartbeats would be stale.
        await expect.poll(() => page.evaluate(async ({ sdkUrl, court }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const director = rallar.director.status({ applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court });
            return director.active && director.isDirector && !director.isFresh;
        }, { sdkUrl, court }), { timeout: 30_000 }).toBe(true);
        await page.getByRole('button', { name: 'Resume' }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
    }
    finally {
        await Promise.all([guest.close(), otherCourtOwner.close()]);
    }
});

test('a director can recover a clock-only court and explicitly advance its existing clock', async ({ page }) => {
    test.skip(!config.enabled, config.skipReason);
    const court = 'court-' + crypto.randomUUID();
    await page.goto(url);
    await page.getByLabel('Username').fill(config.userA.username);
    await page.getByLabel('Password').fill(config.userA.password);
    await page.getByLabel('Room', { exact: true }).fill(court);
    await page.getByRole('button', { name: 'Create room' }).click();
    await page.getByRole('button', { name: 'Take clock control' }).click();
    await expect(page.getByRole('button', { name: 'Start 10 minutes' })).toBeEnabled();
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    const remainingMs = await page.evaluate(async ({ sdkUrl, court }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
        const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
        const expectedDirectorEpoch = rallar.director.status(room).appointment!.epoch;
        const command = { name: 'match', expectedDirectorEpoch };
        await rallar.rooms.changeClock(room, { ...command, operation: 'start', expectedRevision: 0, durationMs: 90_000 }, crypto.randomUUID());
        const paused = await rallar.rooms.changeClock(room, { ...command, operation: 'pause', expectedRevision: 1 }, crypto.randomUUID());
        if (paused.status !== 'paused') throw new Error('Expected a paused clock');
        return paused.remainingMs;
    }, { sdkUrl, court });
    await page.getByRole('button', { name: 'Switch court' }).click();
    await page.getByRole('button', { name: 'Enter room' }).click();
    await expect(page.locator('#phase')).toHaveText('Paused');
    const seconds = Math.ceil(remainingMs / 1000);
    await expect(page.getByLabel('Period clock')).toHaveText(Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
    await page.getByRole('button', { name: 'Advance to halftime' }).click();
    await expect(page.getByLabel('Current period')).toHaveText('halftime');
    await expect(page.locator('#phase')).toHaveText('Running');
});

test('a returning participant recovers the paused program and the director can retry resume', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const otherCourtOwner = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    try {
        await enterCourts({ page, guest, otherCourtOwner, court });
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await expect(page.getByRole('button', { name: 'Start 10 minutes' })).toBeEnabled();
        const director = await page.evaluateHandle(async path => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(path);
            return rallar;
        }, sdkUrl);
        const next = await page.waitForFunction(sdk => sdk.deadlineAfter(600000) ?? 0, director);
        const name = 'program';
        const expectedDirectorEpoch = await director.evaluate((sdk, ref) => sdk.director.status(ref).appointment!.epoch, room);
        const command = { name, expectedDirectorEpoch };
        await director.evaluate(async (sdk, { room, command, next }) => sdk.rooms.publishSchedule(room, {
            ...command, expectedRevision: 0, phases: [{ phase: 'play', startsAtEpochMs: 0 }, { phase: 'break', startsAtEpochMs: next }]
        }, crypto.randomUUID()), { room, command, next: await next.jsonValue() });
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court + '-other');
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.getByRole('heading', { name: court + '-other', exact: true })).toBeVisible();
        const paused = await director.evaluate(async (sdk, { room, command }) =>
            sdk.rooms.pauseProgram(room, { ...command, expectedRevision: 1 }, crypto.randomUUID()), { room, command });
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court);
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.getByRole('heading', { name: court, exact: true })).toBeVisible();
        const recovered = await guest.evaluate(async ({ room, name, sdkUrl }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const schedule = await rallar.rooms.readSchedule(room, name);
            return { schedule, position: schedule && rallar.schedulePosition(schedule) };
        }, { room, name, sdkUrl });
        expect(recovered.schedule).toEqual(paused);
        await expect(guest.getByLabel('Court program')).toHaveText('play · Paused');
        expect(recovered.position).toMatchObject({ status: 'paused', current: { phase: 'play' },
            remainingMs: paused.phases[1]!.startsAtEpochMs - paused.elapsedThroughEpochMs });
        const id = crypto.randomUUID();
        const resume = () => director.evaluate(async (sdk, { room, command, id }) =>
            sdk.rooms.resumeProgram(room, { ...command, expectedRevision: 2 }, id), { room, command, id });
        const resumed = await resume();
        expect(await resume()).toEqual(resumed);
        expect(resumed.revision).toBe(3);
        const pausedDurationMs = resumed.elapsedThroughEpochMs - paused.elapsedThroughEpochMs;
        expect(pausedDurationMs).toBeGreaterThan(0);
        const shiftedStart = paused.phases[1]!.startsAtEpochMs + pausedDurationMs;
        await expect(guest.getByLabel('Court program')).toHaveText(
            'play · Next: break at ' + new Date(shiftedStart).toISOString()
        );
    } finally {
        await Promise.all([guest.close(), otherCourtOwner.close()]);
    }
});

test('a guest returning after the old boundary recovers the revised schedule and crosses its new boundary locally', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const otherCourtOwner = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    try {
        await enterCourts({ page, guest, otherCourtOwner, court });
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await expect(page.getByRole('button', { name: 'Start 10 minutes' })).toBeEnabled();
        const sdk = await page.evaluateHandle(async sdkUrl => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            return rallar;
        }, sdkUrl);
        const calibratedStart = await page.waitForFunction(rallar => rallar.deadlineAfter(12_000) ?? 0, sdk);
        const original = await page.evaluate(async ({ court, sdkUrl, startsAtEpochMs }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
            const phases = [{ phase: 'halftime', startsAtEpochMs: 0 },
                { phase: 'second-half', startsAtEpochMs }];
            return rallar.rooms.publishSchedule(room, { name: 'program', expectedRevision: 0, phases,
                expectedDirectorEpoch: rallar.director.status(room).appointment!.epoch }, crypto.randomUUID());
        }, { court, sdkUrl, startsAtEpochMs: await calibratedStart.jsonValue() });
        await expect(guest.getByLabel('Court program')).toContainText('halftime');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court + '-other');
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.getByRole('heading', { name: court + '-other', exact: true })).toBeVisible();
        const revisedStart = original.phases[1].startsAtEpochMs + 10_000;
        await page.evaluate(async ({ court, sdkUrl, original, revisedStart }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
            await rallar.rooms.publishSchedule(room, { name: 'program', expectedRevision: original.revision,
                expectedDirectorEpoch: rallar.director.status(room).appointment!.epoch,
                phases: [original.phases[0], { phase: 'second-half', startsAtEpochMs: revisedStart }] }, crypto.randomUUID());
        }, { court, sdkUrl, original, revisedStart });
        await expect.poll(() => page.evaluate(async ({ sdkUrl, at }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            return rallar.compareDeadline(at);
        }, { sdkUrl, at: original.phases[1].startsAtEpochMs }), { timeout: 20_000 }).toBe('at-or-after');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court);
        await guest.getByRole('button', { name: 'Enter room' }).click();
        const program = guest.getByLabel('Court program');
        await expect(program).toHaveText('halftime · Next: second-half at ' + new Date(revisedStart).toISOString());
        const snapshotReads: string[] = [];
        guest.on('request', request => {
            if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/groups/' + court)) {
                snapshotReads.push(request.url());
            }
        });
        await expect(program).toHaveText('second-half', { timeout: 15_000 });
        expect(snapshotReads).toEqual([]);
    }
    finally {
        await Promise.all([guest.close(), otherCourtOwner.close()]);
    }
});
