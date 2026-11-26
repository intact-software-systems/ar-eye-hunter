import { afterEach, expect, it, vi } from 'vitest';
import { TemporaryRoomCreation, previewRoomGuestInvitation } from '@shared-web/browser/rooms/entry/temporary-room-creation.ts';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';

const room = { applicationId: 'tournaments', workspaceId: 'weekend', groupId: 'court' };
const access = { clientId: 'player', sessionId: 'session', accessToken: 'bearer', issuedAtEpochMs: 1, expiresAtEpochMs: 14_400_001 };
const storage = new Map<string, string>();
const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); }
};
afterEach(() => { storage.clear(); vi.unstubAllGlobals(); });

it('recovers the original invitation, identity proof and creation request after a lost response and browser reload', async () => {
    let original: { url: string; body: string } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        if (!original) {
            original = { url, body: String(init.body) };
            throw new TypeError('response lost');
        }
        expect(url === original.url && init.body === original.body).toBe(true);
        return Response.json({ room, access });
    });
    await expect(new TemporaryRoomCreation(room, browserStorage).start({ displayName: 'Guest', capacity: 6 })).rejects.toThrow('response lost');
    const created = await new TemporaryRoomCreation(room, browserStorage).start({ displayName: 'Guest', capacity: 6 });
    expect(created.room).toEqual(room);
    expect(created.access).toEqual(access);
    const proof = JSON.parse(original!.body);
    expect(proof.invitationVerifier).toBe(await hashRoomInvitationSecret(created.invitationSecret));
    expect(proof.capacity).toBe(6);
    expect(proof.guestSecret === created.invitationSecret).toBe(false);
    expect(original!.url.includes(proof.guestSecret)).toBe(false);
    expect(original!.body.includes(created.invitationSecret)).toBe(false);
});

it('refuses a creation response from a different workspace', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ room: { ...room, workspaceId: 'other' }, access }));
    await expect(new TemporaryRoomCreation(room, browserStorage).start({})).rejects.toThrow(/room/i);
});

it('rejects an invitation preview claiming more free seats than capacity', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ displayName: 'Town', availableSeats: 5, capacity: 4 }));
    await expect(previewRoomGuestInvitation(room, 'ff'.repeat(32))).rejects.toThrow(/preview/i);
});

it('previews a room without a seat limit', async () => {
    const unlimited = { displayName: 'Town', availableSeats: null, capacity: null };
    vi.stubGlobal('fetch', async () => Response.json(unlimited));
    await expect(previewRoomGuestInvitation(room, 'ff'.repeat(32))).resolves.toEqual(unlimited);
});

it('allows a new creation after the server definitively denies recovery of an expired room', async () => {
    let firstPath: string | undefined;
    vi.stubGlobal('fetch', async (url: string) => {
        if (!firstPath) {
            firstPath = url;
            return new Response(null, { status: 403 });
        }
        expect(url).not.toBe(firstPath);
        return Response.json({ room, access });
    });
    const creation = new TemporaryRoomCreation(room, browserStorage);
    await expect(creation.start({})).rejects.toThrow();
    await expect(creation.start({})).resolves.toMatchObject({ room });
});

it('a late denial from another tab does not discard the proof for a newer pending game', async () => {
    let rejectOld: (() => void) | undefined;
    let calls = 0;
    let latestPath: string | undefined;
    vi.stubGlobal('fetch', async (url: string) => {
        calls++;
        if (calls === 1) return await new Promise<Response>(resolve => {
            rejectOld = () => resolve(new Response(null, { status: 403 }));
        });
        if (calls === 2) return Response.json({ room, access });
        if (calls === 3) {
            latestPath = url;
            throw new TypeError('response lost');
        }
        expect(url === latestPath).toBe(true);
        return Response.json({ room, access });
    });
    const firstTab = new TemporaryRoomCreation(room, browserStorage);
    const secondTab = new TemporaryRoomCreation(room, browserStorage);
    const old = firstTab.start({});
    await vi.waitFor(() => expect(rejectOld).toBeDefined());
    await secondTab.start({});
    secondTab.clear();
    await expect(secondTab.start({})).rejects.toThrow('response lost');
    rejectOld!();
    await expect(old).rejects.toThrow();
    await expect(secondTab.start({})).resolves.toMatchObject({ room });
});
