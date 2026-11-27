import type { GroupRef } from '@shared/api/group-types.ts';
import { isRoomGuestAccess, type RoomGuestAccess } from '@shared/api/room-guests/invitation.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { browserCredentialStore } from '@shared-web/browser/auth/browser-credential-store.ts';
import { createRoomGuestSecret, redeemRoomGuestInvitation } from '@shared-web/browser/rooms/entry/redeem-guest-invitation.ts';

export async function openPickupInvitation(signal: AbortSignal) {
    const response = await fetch('./event.json', {cache:'no-store', signal});
    if (!response.ok) throw new Error('This event invitation is unavailable.');
    const settings = await response.json();
    if (typeof settings.invitationSecret !== 'string') throw new TypeError('Invalid event invitation.');
    const lobby = decodeExactGroupRef(settings.lobby, 'Invited event');
    const apiBaseUrl = settings.apiBaseUrl ?? location.origin;
    const key = 'pickup-event.' + JSON.stringify([apiBaseUrl, lobby.applicationId, lobby.workspaceId, lobby.groupId]);
    rallar.configure({ apiBaseUrl });
    rallar.setDefaults({ applicationId: lobby.applicationId, workspaceId: lobby.workspaceId });
    return { key, lobby, invitationSecret: settings.invitationSecret };
}

interface PickupJoin {
    readonly lobby: GroupRef;
    readonly key: string;
    readonly invitationSecret: string;
    readonly signal: AbortSignal;
}

export async function joinPickupLobby({ lobby, key, invitationSecret, signal }: PickupJoin): Promise<RoomGuestAccess> {
    const saved = await browserCredentialStore.read(key + '.seat');
    let access = saved ? JSON.parse(saved) : null;
    if (!isRoomGuestAccess(access)) {
        const secret = await browserCredentialStore.readOrCreate(key + '.secret', createRoomGuestSecret());
        const requestId = await browserCredentialStore.readOrCreate(key + '.request', crypto.randomUUID());
        access = await redeemRoomGuestInvitation(lobby, { invitationSecret, guestSecret: secret },
            { requestId, signal });
        await browserCredentialStore.write(key + '.seat', JSON.stringify(access));
    }
    await rallar.auth.activateGuest({room:lobby, access, username:'Pickup player'});
    await rallar.connect({signal});
    await rallar.rooms.join(lobby, {presenceOnly:true, signal, preserveCurrentMembership:true});
    return access;
}
