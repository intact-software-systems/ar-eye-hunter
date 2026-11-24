import { describe, expect, it } from 'vitest';
import { readRoomGuestCredential, toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';

const room = { applicationId: 'town', workspaceId: 'dev', groupId: 'square' };
const secret = 'c1'.repeat(32);

describe('room guest credentials', () => {
    it('recovers a stable scoped identity on reload and separates same-named rooms', async () => {
        const first = await toRoomGuestCredential(room, secret);
        const otherRoom = await toRoomGuestCredential({ ...room, workspaceId: 'stage' }, secret);
        const anotherGuest = await toRoomGuestCredential(room, 'da'.repeat(32));
        expect(first).toEqual(await toRoomGuestCredential(room, secret));
        expect(first.clientId).not.toBe(otherRoom.clientId);
        expect(first.sessionId).not.toBe(otherRoom.sessionId);
        expect(first.clientId).not.toBe(anotherGuest.clientId);
        expect(first.sessionId).not.toBe(first.clientId);
        expect(await readRoomGuestCredential(first.accessToken)).toEqual({
            roomRef: room, clientId: first.clientId, sessionId: first.sessionId
        });
    });

    it('rejects invalid guest entropy and unrelated or malformed credentials', async () => {
        await expect(toRoomGuestCredential(room, 'x'.repeat(64))).rejects.toThrow();
        for (const token of ['', 'account-token', 'guest.v1.%%%%', 'guest.v1.e30']) {
            expect(await readRoomGuestCredential(token)).toBeUndefined();
        }
    });
});
