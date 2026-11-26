import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { createRoomGuestSecret, redeemRoomGuestInvitation } from '@shared-web/browser/rooms/entry/redeem-guest-invitation.ts';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';
import { guestVisitUrl, saveGuestVisit, type GuestVisit } from './guest-visit.ts';
import { GRUMPY_TOWN_SCOPE } from './town-server.ts';

interface EnterTownInvitationInput {
    readonly room: string;
    readonly invitationSecret: string | null;
    readonly nickname: string;
    readonly visit: GuestVisit | undefined;
    readonly root: HTMLElement;
    readonly signal: AbortSignal;
}

export async function enterTownInvitation(input: EnterTownInvitationInput): Promise<void> {
    const { room, invitationSecret, nickname, root, signal } = input;
    let visit = input.visit;
    if ((!visit || !('access' in visit)) && invitationSecret) {
        const invitationVerifier = await hashRoomInvitationSecret(invitationSecret);
        const previous = visit && 'guestSecret' in visit ? visit : undefined;
        const pending = previous?.invitationVerifier === invitationVerifier ? previous : {
            room, invitationVerifier, nickname,
            requestId: crypto.randomUUID(), guestSecret: previous?.guestSecret ?? createRoomGuestSecret()
        };
        await saveGuestVisit(pending);
        const access = await redeemRoomGuestInvitation({ ...GRUMPY_TOWN_SCOPE, groupId: room }, {
            invitationSecret, guestSecret: pending.guestSecret, displayName: pending.nickname
        }, { requestId: pending.requestId, signal });
        if (signal.aborted) {
            return;
        }
        visit = { room, nickname: pending.nickname, access };
        await saveGuestVisit(visit);
    }
    if (!visit || !('access' in visit)) {
        return;
    }
    const snapshot = await findStateGroup(visit.room, GRUMPY_TOWN_SCOPE, {
        authSession: { ...visit.access, username: visit.nickname }, signal
    });
    if (signal.aborted) {
        return;
    }
    const diagnostics = new URLSearchParams(location.search).get('diagnostics') === '1';
    const returnUrl = guestVisitUrl(visit.room);
    if (diagnostics) returnUrl.searchParams.set('diagnostics', '1');
    history.replaceState(history.state, '', returnUrl);
    const { openGuestMatch } = await import('./open-guest-match.ts');
    if (!signal.aborted) {
        openGuestMatch({ root, visit, snapshot, pageSignal: signal });
    }
}
