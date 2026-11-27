import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { isGuestInvitationVerifier } from '@shared/api/room-guests/invitation.ts';

import { forgetGuestVisit, readGuestVisit, type GuestVisit } from './guest-visit.ts';
import { chooseTownNickname } from './choose-town-nickname.ts';
import { enterTownInvitation } from './enter-town-invitation.ts';
import { previewTownInvitation } from './preview-town-invitation.ts';
import { townApiBaseUrl } from './town-server.ts';

export async function openGuestInvitation(root: HTMLElement, signal: AbortSignal): Promise<void> {
    configureApiClient({ apiBaseUrl: townApiBaseUrl });
    const fragment = new URLSearchParams(location.hash.slice(1));
    const room = fragment.get('room') ?? new URLSearchParams(location.search).get('room');
    const invitationSecret = fragment.get('invite');
    const valid = Boolean(room && room.trim().length && room.length <= 256 && isGuestInvitationVerifier(invitationSecret));
    root.innerHTML = `<main class="loading" hidden>
        <h1>Town invitation</h1>
        <p>Your town nickname is <output aria-label="Your nickname"></output>.</p>
        <button type="button" id="shuffle">Shuffle nickname</button>
        <p id="availability" role="status"></p><p role="alert"></p>
        <button type="button" class="primary" id="join" hidden>Join this town</button>
        <p><a>Play solo</a></p>
    </main>`;
    const panel = root.querySelector('main')!;
    const output = root.querySelector('output')!;
    const shuffle = root.querySelector<HTMLButtonElement>('#shuffle')!;
    const join = root.querySelector<HTMLButtonElement>('#join')!;
    const message = root.querySelector<HTMLElement>('[role=alert]')!;
    root.querySelector('a')!.href = import.meta.env.BASE_URL;

    let visit: GuestVisit | undefined;
    try {
        visit = room ? await readGuestVisit(room) : undefined;
        if (signal.aborted) return;
    }
    catch {
        if (signal.aborted) return;
        panel.hidden = false;
        message.textContent = 'Allow browser storage and reopen the invitation to keep your guest seat.';
        return;
    }
    output.value = visit?.nickname ?? chooseTownNickname();
    panel.hidden = false;
    shuffle.disabled = hasPendingGuestVisit(visit);
    shuffle.addEventListener('click', () => {
        output.value = chooseTownNickname(output.value);
    }, { signal });

    join.addEventListener('click', () => void enter(), { signal });
    if (visit && 'access' in visit) {
        void enter();
    }
    else if (valid && room && invitationSecret) {
        void previewTownInvitation({ room, invitationSecret, signal, join, message,
            availability: root.querySelector<HTMLElement>('#availability')! });
    }
    else {
        message.textContent = 'Ask the town owner for a fresh invitation.';
    }

    async function enter(): Promise<void> {
        join.disabled = true;
        shuffle.disabled = true;
        message.textContent = '';
        try {
            if (room) await enterTownInvitation({ room, invitationSecret: valid ? invitationSecret : null,
                nickname: output.value, visit, root, signal });
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            const failure = describeGuestEntryFailure(error instanceof ApiHttpError ? error : undefined, valid);
            if (room) visit = await readGuestVisit(room);
            if (failure.clearVisit) {
                visit = undefined;
                if (room) await forgetGuestVisit(room);
            }
            message.textContent = failure.message;
            join.hidden = !failure.retry;
        }
        finally {
            join.disabled = false;
            shuffle.disabled = hasPendingGuestVisit(visit);
        }
    }
}

/** A rejection ends the saved visit; a lost reply retries the same private seat. */
function describeGuestEntryFailure(error: ApiHttpError | undefined, validInvitation: boolean) {
    if (error?.mutationFailure?.code === 'group-full') {
        return { clearVisit: true, retry: true, message: 'Town is full. Try again when a seat opens.' };
    }
    if (error && [400, 401, 403, 404].includes(error.status)) {
        return { clearVisit: true, retry: validInvitation, message: 'Guest access has ended. Ask the owner for a fresh invitation.' };
    }
    return { clearVisit: false, retry: true, message: 'Could not reach your town. Try again.' };
}

function hasPendingGuestVisit(visit: GuestVisit | undefined): boolean {
    return visit !== undefined && 'guestSecret' in visit;
}
