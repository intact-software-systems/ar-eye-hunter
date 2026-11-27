import type { GroupRef } from '@shared/api/group-types.ts';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { createRoomGuestSecret } from '@shared-web/browser/rooms/entry/redeem-guest-invitation.ts';
import { guestInvitationUrl } from './guest-visit.ts';

export async function issueTownInvitation(browser: RallarFacade, room: GroupRef, signal: AbortSignal) {
    const secret = createRoomGuestSecret();
    const snapshot = await browser.rooms.update({ roomRef: room, guestInvitationVerifier: await hashRoomInvitationSecret(secret), signal });
    return { secret, snapshot, link: guestInvitationUrl(room.groupId, secret) };
}
