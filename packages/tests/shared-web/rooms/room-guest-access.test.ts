import { afterEach, expect, it, vi } from 'vitest';

import { redeemRoomGuestInvitation } from '@shared-web/browser/rooms/room-guest-access.ts';

const room = { applicationId: 'app', workspaceId: 'ws', groupId: 'town' };
const options = { requestId: 'a-stable-request-id-12345' };
const proof = { invitationSecret: 'ca'.repeat(32), guestSecret: 'be'.repeat(32), displayName: 'Pickle Boots' };
const admission = {
    clientId: 'guest-principal', sessionId: 'guest-session', accessToken: 'guest-bearer',
    issuedAtEpochMs: 1_000, expiresAtEpochMs: 14_401_000
};

afterEach(() => vi.unstubAllGlobals());

it('redeems without account credentials, keeping both secrets out of the URL', async () => {
    let requestUrl = '';
    let sent: RequestInit | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        requestUrl = url;
        sent = init;
        return Response.json(admission);
    });
    await expect(redeemRoomGuestInvitation(room, proof, options)).resolves.toEqual(admission);
    expect(requestUrl).toBe('/api/state/apps/app/workspaces/ws/groups/town/guests/requests/a-stable-request-id-12345');
    expect(new Headers(sent?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(sent?.body))).toEqual(proof);
});

it('rejects an incomplete admission instead of persisting an unusable credential', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ...admission, sessionId: '' }));
    await expect(redeemRoomGuestInvitation(room, proof, options)).rejects.toThrow(/guest/i);
});
