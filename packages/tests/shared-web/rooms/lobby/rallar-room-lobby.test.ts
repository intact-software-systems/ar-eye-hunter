import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';
import { RallarRoomLobby } from '@shared-web/browser/rooms/lobby/rallar-room-lobby.ts';
import type { RoomLobby, RoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { ViewPushBrowser } from '../../api/view-push-browser.ts';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
afterEach(() => vi.unstubAllGlobals());

const scope = { applicationId: 'courts', workspaceId: 'league' };
const roomRef = { ...scope, groupId: 'A' };
const session = { clientId: 'alice', username: 'alice', sessionId: 'session-alice', accessToken: 'test', expiresAtEpochMs: 9999999999999 };

it('recovers a missed held-seat deadline across socket reconnect and rejects another account’s view', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let view: RoomLobbyAccountView = { scope, principalId: 'alice', seat: { roomRef, status: 'away', deadlineEpochMs: null } };
    const reads: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
        reads.push(url);
        return Response.json(view);
    });
    const push = new ViewPushBrowser(() => session);
    const owner = new RallarRoomLobby({
        session: () => session, ws: push.ws, messages: push.messages, auth: { onChange: () => () => {} }
    }, scope);
    try {
        vi.useFakeTimers();
        try {
            await owner.start();
            expect(reads).toEqual(['http://api.test/api/room-lobbies/apps/courts/workspaces/league']);
            expect(owner.getState().view).toEqual(view);
            await vi.advanceTimersByTimeAsync(300000);
            expect(reads).toHaveLength(1);
        }
        finally {
            vi.useRealTimers();
        }
        view = { ...view, seat: { roomRef, status: 'away', deadlineEpochMs: 120100 } };
        push.reopen();
        await expect.poll(() => owner.getState().view?.seat?.deadlineEpochMs).toBe(120100);
        view = { ...view, principalId: 'bob' };
        await owner.refresh();
        expect(owner.getState().view).toBeNull();
        expect(owner.getState().error).toMatch(/account/i);
    }
    finally {
        owner.stop();
    }
});


it('accepts a private release acknowledgement and recovers the account view', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let responseRoomRef = roomRef;
    let writes = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
            writes++;
            expect(JSON.parse(String(init.body)).roomLobby).toEqual({ operation: 'release' });
            return Response.json({ roomRef: responseRoomRef });
        }
        return Response.json({ scope, principalId: session.clientId, seat: null });
    });
    const push = new ViewPushBrowser(() => session);
    const owner = new RallarRoomLobby({
        session: () => session, ws: push.ws, messages: push.messages, auth: { onChange: () => () => {} }
    }, scope);
    try {
        await owner.start();
        await owner.release(roomRef);
        expect(writes).toBe(1);
        expect(owner.getState().error).toBeNull();
        responseRoomRef = { ...roomRef, groupId: 'different' };
        await owner.release(roomRef);
        expect(owner.getState().error).toMatch(/another room/i);
    }
    finally { owner.stop(); }
});


it('waits from another room and receives an exclusive offer without entering', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let view: RoomLobbyAccountView = { scope, principalId: session.clientId, seat: null };
    let writes = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
            expect(JSON.parse(String(init.body)).roomLobby).toEqual({ operation: 'wait', joinCode: 'court-code' });
            writes++;
            view = { ...view, seat: { roomRef, status: 'waiting', deadlineEpochMs: null } };
            return Response.json({ roomRef });
        }
        return Response.json(view);
    });
    const push = new ViewPushBrowser(() => session);
    const owner = new RallarRoomLobby({
        session: () => session, ws: push.ws, messages: push.messages, auth: { onChange: () => () => {} }
    }, scope);
    try {
        await owner.start();
        await owner.wait(roomRef, { joinCode: 'court-code' });
        expect(owner.getState().view?.seat?.status).toBe('waiting');
        view = { ...view, seat: { roomRef, status: 'offered', deadlineEpochMs: 60000 } };
        push.reopen();
        await expect.poll(() => owner.getState().view?.seat).toEqual(view.seat);
        expect(writes).toBe(1);
    }
    finally { owner.stop(); }
});


it('reads a public registration revision using the calibrated uncertainty window', () => {
    const registration = { revision: 2, atEpochMs: 500 };
    const metadata = { rallarRoomLobbyRegistration: registration };
    const authority = { maxAuthorityOffsetMs: 12 };
    for (const [comparison, status] of [
        ['before', 'open'], ['overlaps', 'uncertain'], ['at-or-after', 'closed'], ['unavailable', 'unavailable']
    ] as const) {
        const clock: Pick<RallarConnectionOperations, 'compareDeadline'> = {
            compareDeadline: (deadline, bound) => deadline === registration.atEpochMs && bound?.maxAuthorityOffsetMs === authority.maxAuthorityOffsetMs
                ? comparison : 'unavailable'
        };
        expect(RallarRoomLobby.registration(metadata, clock, authority)).toEqual({ ...registration, status });
    }
    const uncalibrated = { compareDeadline: () => 'unavailable' as const };
    expect(RallarRoomLobby.registration({}, uncalibrated)).toBeNull();
    expect(RallarRoomLobby.registration({ rallarRoomLobbyRegistration: { revision: 3, atEpochMs: null } }, uncalibrated)?.status).toBe('open');
});

it('sends a revision-bound cutoff update and validates the returned room snapshot', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let publishedPhase: string | null = 'play';
    const writes: RoomLobby.Mutation[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
            writes.push(JSON.parse(String(init.body)).roomLobby);
            const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: [] });
            const metadata = publishedPhase === null ? {} : { rallarRoomLobbyRegistration: { revision: 3, atEpochMs: null,
                boundary: { program: 'match', phase: publishedPhase } } };
            return Response.json({ ...snapshot, group: { ...snapshot.group, metadata } });
        }
        return Response.json({ scope, principalId: session.clientId, seat: null });
    });
    const push = new ViewPushBrowser(() => session);
    const owner = new RallarRoomLobby({
        session: () => session, ws: push.ws, messages: push.messages, auth: { onChange: () => () => {} }
    }, scope);
    try {
        await owner.start();
        await owner.setRegistrationCutoff(roomRef, { expectedRevision: 1, atEpochMs: 1200 });
        expect(writes).toEqual([{ operation: 'set-registration-cutoff', expectedRevision: 1, atEpochMs: 1200 }]);
        const boundary = { program: 'match', phase: 'play', expectedRevision: 2, expectedProgramRevision: 5 };
        await owner.setRegistrationBoundary(roomRef, boundary);
        expect(writes.at(-1)).toEqual({ operation: 'set-registration-boundary', ...boundary });
        expect(owner.getState().error).toBeNull();
        await owner.setRegistrationBoundary(roomRef, { ...boundary, expectedRevision: 3 });
        expect(owner.getState().error).toBeNull();
        for (publishedPhase of [null, 'halftime']) {
            await owner.setRegistrationBoundary(roomRef, boundary);
            expect(owner.getState().error).toMatch(/acknowledge/i);
        }
    }
    finally { owner.stop(); }
});

it('uses the published program cursor to confirm an elapsed phase without clock calibration', () => {
    const boundary = { program: 'match', phase: 'play' };
    const metadata = { rallarRoomLobbyRegistration: { revision: 1, atEpochMs: 100, boundary },
        rallarRoomClocks: [{ name: 'match', revision: 3, status: 'program-paused', elapsedThroughEpochMs: 120,
            phases: [{ phase: 'play', startsAtEpochMs: 100 }] }] };
    const compareDeadline = () => 'unavailable' as const;
    expect(RallarRoomLobby.registration(metadata, { compareDeadline })).toEqual({ ...metadata.rallarRoomLobbyRegistration, status: 'closed' });
});
