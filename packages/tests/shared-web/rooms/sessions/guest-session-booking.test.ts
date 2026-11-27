import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { GuestSessionBooking } from '@shared-web/browser/rooms/sessions/guest-session-booking.ts';

afterEach(() => vi.unstubAllGlobals());

it('restores the browser proof and lost reservation request, then accepts a fresh decision after withdrawal', async () => {
    const room = { applicationId: 'club', workspaceId: 'north', groupId: 'session' };
    const requests: { url: string; guestSecret: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        requests.push({ url, guestSecret: JSON.parse(String(init.body)).guestSecret });
        if (requests.length === 1) throw new TypeError('lost response');
        return Response.json({ accepted: true });
    });
    await expect(new GuestSessionBooking(room).change('reserve', 1)).rejects.toThrow('lost response');
    const recovered = new GuestSessionBooking(room);
    await recovered.change('reserve', 1);
    await recovered.change('withdraw', 1);
    await recovered.change('reserve', 1);
    expect(requests[1]).toEqual(requests[0]);
    expect(new Set(requests.map(x => x.guestSecret)).size).toBe(1);
    expect(new Set(requests.map(x => x.url)).size).toBe(3);
    expect(requests[0].url.includes(requests[0].guestSecret)).toBe(false);
});

it('starts a new reservation after an authoritative rejection releases the retry identity', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
        requests.push(url);
        return requests.length === 1 ? Response.json({error: 'Room full'}, {status: 400}) : Response.json({accepted: true});
    });
    const booking = new GuestSessionBooking({applicationId: 'club', workspaceId: 'north', groupId: 'full-room'});
    await expect(booking.change('reserve', 1)).rejects.toThrow();
    await booking.change('reserve', 1);
    expect(requests[1]).not.toEqual(requests[0]);
});
