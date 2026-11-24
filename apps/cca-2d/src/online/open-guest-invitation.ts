import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { createRoomGuestSecret, redeemRoomGuestInvitation } from '@shared-web/browser/rooms/entry/redeem-guest-invitation.ts';
import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { hashRoomInvitationSecret, isGuestInvitationVerifier } from '@shared/api/room-guests/invitation.ts';

import { readGuestVisit, saveGuestVisit, type GuestVisit } from './guest-visit.ts';
import { CCA_SCOPE, townApiBaseUrl } from './town-server.ts';

const nicknames = [
    'Captain Cabbage',
    'Count Crumb',
    'Dizzy Dumpling',
    'Doctor Drip',
    'Pickle Boots',
    'Professor Puddle',
    'Soggy Biscuit',
    'Wobbly Turnip'
];

export function openGuestInvitation(root: HTMLElement, signal: AbortSignal): void {
    configureApiClient({ apiBaseUrl: townApiBaseUrl });
    const fragment = new URLSearchParams(location.hash.slice(1));
    const room = fragment.get('room');
    const invitationSecret = fragment.get('invite');
    const valid = Boolean(room && room.trim().length && room.length <= 256 && isGuestInvitationVerifier(invitationSecret));
    root.innerHTML = `<main class="loading">
        <h1>Town invitation</h1>
        <p>Your town nickname is <output aria-label="Your nickname"></output>.</p>
        <button type="button" id="shuffle">Shuffle nickname</button>
        <p role="alert"></p>
        <button type="button" class="primary" id="join" hidden>Join this town</button>
        <p><a>Play solo</a></p>
    </main>`;
    const output = root.querySelector('output')!;
    const shuffle = root.querySelector<HTMLButtonElement>('#shuffle')!;
    const join = root.querySelector<HTMLButtonElement>('#join')!;
    const message = root.querySelector<HTMLElement>('[role=alert]')!;
    root.querySelector('a')!.href = import.meta.env.BASE_URL;

    let visit: GuestVisit | undefined;
    try {
        visit = readGuestVisit();
    }
    catch {
        message.textContent = 'Allow tab storage and reopen the invitation to keep your guest seat.';
        return;
    }
    if (room !== null && visit?.room !== room) {
        visit = undefined;
    }
    let index = visit ? nicknames.indexOf(visit.nickname) : -1;
    if (index < 0) {
        index = Math.floor(Math.random() * nicknames.length);
    }
    output.value = nicknames[index];
    shuffle.disabled = Boolean(visit && 'guestSecret' in visit);
    shuffle.addEventListener('click', () => {
        const offset = 1 + Math.floor(Math.random() * (nicknames.length - 1));
        index = (index + offset) % nicknames.length;
        output.value = nicknames[index];
    }, { signal });

    join.addEventListener('click', () => void enter(), { signal });
    if (visit && 'access' in visit) {
        void enter();
    }
    else if (valid) {
        join.hidden = false;
    }
    else {
        message.textContent = 'Ask the town owner for a fresh invitation.';
    }

    async function enter(): Promise<void> {
        join.disabled = true;
        shuffle.disabled = true;
        message.textContent = '';
        try {
            if ((!visit || !('access' in visit)) && room && invitationSecret && valid) {
                const invitationVerifier = await hashRoomInvitationSecret(invitationSecret);
                const previous = visit && 'guestSecret' in visit ? visit : undefined;
                const pending = previous?.invitationVerifier === invitationVerifier ? previous : {
                    room, invitationVerifier, nickname: output.value,
                    requestId: crypto.randomUUID(), guestSecret: previous?.guestSecret ?? createRoomGuestSecret()
                };
                saveGuestVisit(pending);
                visit = pending;
                const access = await redeemRoomGuestInvitation({ ...CCA_SCOPE, groupId: room }, {
                    invitationSecret, guestSecret: pending.guestSecret, displayName: pending.nickname
                }, { requestId: pending.requestId, signal });
                if (signal.aborted) {
                    return;
                }
                visit = { room, nickname: pending.nickname, access };
                saveGuestVisit(visit);
            }
            if (!visit || !('access' in visit)) {
                return;
            }
            const snapshot = await findStateGroup(visit.room, CCA_SCOPE, {
                authSession: { ...visit.access, username: visit.nickname }, signal
            });
            if (signal.aborted) {
                return;
            }
            const diagnostics = new URLSearchParams(location.search).get('diagnostics') === '1';
            history.replaceState(history.state, '', location.pathname + (diagnostics ? '?diagnostics=1' : ''));
            const { openGuestMatch } = await import('./open-guest-match.ts');
            if (!signal.aborted) {
                openGuestMatch({ root, visit, snapshot, pageSignal: signal });
            }
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            const code = error instanceof ApiHttpError ? error.mutationFailure?.code : undefined;
            if (code === 'group-full') {
                visit = undefined;
                saveGuestVisit(undefined);
                message.textContent = 'Town is full. Try again when a seat opens.';
                join.hidden = false;
            }
            else if (error instanceof ApiHttpError && [400, 401, 403, 404].includes(error.status)) {
                visit = undefined;
                saveGuestVisit(undefined);
                message.textContent = 'Guest access has ended. Ask the owner for a fresh invitation.';
                join.hidden = !valid;
            }
            else {
                message.textContent = 'Could not reach your town. Try again.';
                join.hidden = false;
            }
        }
        finally {
            join.disabled = false;
            shuffle.disabled = Boolean(visit && 'guestSecret' in visit);
        }
    }
}
