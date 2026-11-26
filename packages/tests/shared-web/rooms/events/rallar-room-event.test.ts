import { afterEach, expect, it, vi } from 'vitest';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';
import { ViewPushBrowser } from '../../api/view-push-browser.ts';

const lobby = { applicationId: 'games', workspaceId: 'park', groupId: 'lounge' };
const court = { ...lobby, groupId: 'court' };
const grant = { clientId: 'alice', username: 'Alice', sessionId: 'lobby-seat',
    accessToken: 'lobby-proof', expiresAtEpochMs: 14_400_001, guestRoom: lobby };
const courtAccess = { clientId: 'alice', sessionId: 'court-seat', issuedAtEpochMs: 1,
    expiresAtEpochMs: 14_400_001, accessToken: 'court-proof' };
const view: RoomEvent.View = {
    principalId: 'alice', lobby, closesAt: 14_400_000, revision: 3, closed: false,
    courts: [{ groupId: 'court', capacity: 4, occurrence: 1, availableSeats: 3 }],
    queue: null, proposals: [], offer: { groupId: 'court', occurrence: 1, offerRevision: 3, partyId: 'friends', deadline: 1000 }
};

function trial() {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    const rows = new Map<string, string>();
    const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
    let active: AuthSession = grant;
    const join = vi.fn<RallarRoomEvent.Browser['rooms']['join']>();
    const session = () => active;
    const push = new ViewPushBrowser(session);
    const browser: RallarRoomEvent.Browser = {
        session, ws: push.ws, messages: push.messages, auth: {
            onChange: () => () => {},
            activateGuest: async ({ room, access, username }) => { active = { ...access, guestRoom: room, username }; }
        },
        connect: vi.fn<RallarRoomEvent.Browser['connect']>(), rooms: { join }
    };
    return { browser, push, join, session, open: () => new RallarRoomEvent(browser, lobby, storage) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('recovers a court claim after a lost response, enters as the same player and returns using the saved lobby grant', async () => {
    const fixture = trial();
    let previous: { url: string; body: string } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer lobby-proof');
        if (init.method === 'GET') return Response.json(previous ? { ...view, offer: { ...view.offer, deadline: null } } : view);
        const claim = { url, body: String(init.body) };
        if (!previous) {
            previous = claim;
            throw new TypeError('claim response lost');
        }
        expect(claim.url === previous.url && claim.body === previous.body).toBe(true);
        return Response.json({ revision: 4, room: court, access: courtAccess });
    });
    const first = fixture.open();
    await first.start();
    await expect(first.enterCourt()).rejects.toThrow('claim response lost');
    first.stop();
    const retry = fixture.open();
    await retry.start();
    await retry.enterCourt();
    expect(fixture.session()).toMatchObject({ clientId: 'alice', guestRoom: court, accessToken: 'court-proof' });
    retry.stop();
    const restored = fixture.open();
    try {
        await restored.start();
        await restored.returnToLobby();
        expect(fixture.join.mock.calls.map(([selected]) => selected)).toEqual([court, lobby]);
        expect(fixture.session()).toMatchObject(grant);
    } finally { restored.stop(); }
});

it('recovers the new occurrence on WebSocket reconnect and makes zero recurring reads while idle', async () => {
    const fixture = trial();
    let reads = 0;
    let revision = 3;
    vi.stubGlobal('fetch', async () => { reads++; return Response.json({ ...view, revision }); });
    const event = fixture.open();
    try {
        vi.useFakeTimers();
        await event.start();
        expect(event.getState().view?.revision).toBe(3);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(reads).toBe(1);
        vi.useRealTimers();
        revision = 5;
        fixture.push.reopen();
        await expect.poll(() => event.getState().view?.revision).toBe(5);
    } finally { event.stop(); }
});

it('refuses an admission for a different principal or a different assigned court', async () => {
    const fixture = trial();
    const event = fixture.open();
    let returned = { room: court, access: { ...courtAccess, clientId: 'bob' } };
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => Response.json(init.method === 'GET' ? view : { revision: 4, ...returned }));
    try {
        await event.start();
        await expect(event.enterCourt()).rejects.toThrow(/admission/i);
        returned = { room: { ...court, groupId: 'other' }, access: courtAccess };
        await expect(event.enterCourt()).rejects.toThrow(/admission/i);
        expect(fixture.join).not.toHaveBeenCalled();
    } finally { event.stop(); }
});

it('reads an offer on its private WebSocket notice and ignores notices for another lobby', async () => {
    const fixture = trial();
    let revision = 5;
    let reads = 0;
    vi.stubGlobal('fetch', async () => { reads++; return Response.json({ ...view, revision }); });
    const event = fixture.open();
    const notify = (groupId: string) => {
        const envelope = newALBroadcastMessage({
            senderId: 'server', createdAtEpochMs: 100, route: newALRoute(AppTopics.viewInvalidated, 'event-change', 'all'),
            scope: 'all', typeId: AppTopics.viewInvalidated, resource: { resource: 'room-event', version: 1,
                changeId: 'change', groupId, scope: { applicationId: lobby.applicationId, workspaceId: lobby.workspaceId }, principalId: 'alice' }
        });
        fixture.push.deliver({ ...envelope, targets: { mode: 'broadcast', scope: 'principal', principalRef: {
            applicationId: lobby.applicationId, workspaceId: lobby.workspaceId, principalId: 'alice'
        } } });
    };
    try {
        await event.start();
        vi.useFakeTimers();
        revision++;
        notify('unrelated');
        await vi.advanceTimersByTimeAsync(2000);
        expect(reads).toBe(1);
        vi.useRealTimers();
        notify(lobby.groupId);
        await expect.poll(() => event.getState().view?.revision).toBe(6);
    } finally { event.stop(); }
});

it('sends the current court credential for director release and retains the lobby credential for private reads', async () => {
    const fixture = trial();
    const event = fixture.open();
    let released = false;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        const credential = new Headers(init.headers).get('authorization');
        if (init.method === 'GET') {
            expect(credential).toBe('Bearer lobby-proof');
            return Response.json({ ...view, offer: { ...view.offer, deadline: null } });
        }
        const command = JSON.parse(String(init.body));
        if (command.action === 'release') {
            expect(credential).toBe('Bearer court-proof');
            released = true;
            return Response.json({ revision: 5 });
        }
        expect(credential).toBe('Bearer lobby-proof');
        return Response.json({ revision: 4, room: court, access: courtAccess });
    });
    try {
        await event.start();
        await event.enterCourt();
        await event.act({ action: 'release', groupId: court.groupId, occurrence: 1, requeue: true });
        expect(released).toBe(true);
    } finally { event.stop(); }
});

it('discards a delayed claim response when a new offer has replaced the old grant in the same occurrence for the same player', async () => {
    const fixture = trial();
    let revision = 3;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        if (init.method === 'GET') {
            if (revision === 3) return Response.json({ ...view, offer: { ...view.offer, deadline: null } });
            return Response.json({ ...view, revision, offer: { ...view.offer, offerRevision: revision, deadline: null } });
        }
        Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
        revision++;
        return Response.json({ revision: 4, room: court, access: courtAccess });
    });
    const event = fixture.open();
    try {
        await event.start();
        await expect(event.enterCourt()).rejects.toThrow(/assignment/i);
        expect(fixture.join).not.toHaveBeenCalled();
        expect(fixture.session()).toEqual(grant);
    } finally { event.stop(); }
});

it('opens an authorized lobby without an event and observes subsequent event creation', async () => {
    const fixture = trial();
    let created = false;
    vi.stubGlobal('fetch', async () => Response.json(created ? view : null));
    const event = fixture.open();
    try {
        await event.start();
        expect(event.getState()).toMatchObject({ view: null, error: null });
        created = true;
        fixture.push.reopen();
        await expect.poll(() => event.getState().view?.lobby).toEqual(lobby);
    } finally { event.stop(); }
});
