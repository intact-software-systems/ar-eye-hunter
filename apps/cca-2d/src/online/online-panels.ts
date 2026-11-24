import { renderSVG } from 'uqr';

import type { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import type { FriendPerson } from '@shared/api/friends/friends-view.ts';
import type { MatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';

import type { OnlineSession } from './online-session.ts';

export function renderRoom(root: HTMLElement, state: OnlineSession.State): void {
    const room = state.rooms.currentRoomRef;
    if (!room) {
        if (root.dataset.room !== '') {
            root.dataset.room = '';
            root.innerHTML =
                `<h2>Bring your friends</h2><p>Create a town and share its code, or join someone already here.</p><button data-action="create" class="primary">Create town</button><form id="join-town"><label>Town code<input name="room" required></label><button>Join town</button></form>`;
        }
        return;
    }
    if (root.dataset.room !== room.groupId) {
        root.dataset.room = room.groupId;
        root.innerHTML =
            `<h2>Your town lobby</h2><label>Room code<input id="room-code" readonly></label><div id="guest-sharing"></div><ul id="roster"></ul><div id="match-controls"></div><button data-action="leave">Leave town</button>`;
        const input = root.querySelector<HTMLInputElement>('#room-code');
        if (input) {
            input.value = room.groupId;
        }
    }
    const sharing = root.querySelector<HTMLElement>('#guest-sharing');
    if (sharing) {
        renderGuestSharing(sharing, state);
    }
    const roster = root.querySelector('#roster');
    if (roster) {
        roster.innerHTML = state.rooms.members.filter((member) => member.status === 'active').map((member) =>
            `<li>${
                toLobbyHtml(
                    state.friends.view?.contacts.find((person) => person.principalId === member.principalId)
                        ?.displayName || member.displayName || member.username
                )
            } · ${member.isOnline ? 'here' : 'away'}${member.isOwner ? ' · room owner' : ''}</li>`
        ).join('');
    }
}

function renderGuestSharing(root: HTMLElement, state: OnlineSession.State): void {
    if (!state.ownsTown) {
        root.replaceChildren();
        return;
    }
    let button = root.querySelector<HTMLButtonElement>('button');
    if (!button) {
        button = document.createElement('button');
        button.dataset.action = 'invite-guests';
        root.append(button);
    }
    button.disabled = state.busy;
    button.textContent = state.invitation ? 'Replace invitation' : 'Invite guests';
    let details = root.querySelector('section');
    if (!state.invitation) {
        details?.remove();
        return;
    }
    if (details?.querySelector('input')?.value === state.invitation.href) {
        return;
    }
    if (!details) {
        details = document.createElement('section');
        root.append(details);
    }
    details.innerHTML = `<label>Guest invitation link<input readonly></label><img alt="Scan to join this town" width="200" height="200"><p>Friends can scan this code or open the link for 15 minutes.</p>`;
    const link = details.querySelector('input')!;
    link.value = state.invitation.href;
    link.addEventListener('focus', () => link.select());
    const qr = renderSVG(state.invitation.href, { border: 4 });
    details.querySelector('img')!.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
}

export function renderMatchmaking(root: HTMLElement, resource: AuthenticatedResource.State<MatchmakingSnapshot>): void {
    const state = resource.view?.state;
    const disabled = resource.busy || resource.retryPending ? 'disabled' : '';
    let detail = '<p>Loading matchmaking…</p>';
    if (state?.status === 'idle' || state?.status === 'ended') {
        detail = `<p>${
            state.status === 'ended' ? toLobbyHtml(state.reason.replaceAll('-', ' ')) : 'Find another mischief maker.'
        }</p><button data-action="find" class="primary" ${disabled}>Find players</button>`;
    }
    if (state?.status === 'searching') {
        detail =
            `<p role="status">Looking for players…</p><button data-action="cancel-search" ${disabled}>Cancel search</button>`;
    }
    if (state?.status === 'confirming') {
        const confirmed = state.players.find((player) => player.principalId === resource.view?.principalId)?.confirmed;
        detail = `<p role="status">Players found! ${
            state.players.filter((player) => player.confirmed).length
        }/${state.players.length} confirmed.</p><button data-action="confirm" ${disabled} ${
            confirmed ? 'disabled' : ''
        }>${
            confirmed
                ? 'Waiting for friends'
                : 'Confirm match'
        }</button><button data-action="cancel-search" ${disabled}>Decline match</button>`;
    }
    if (state?.status === 'matched') {
        detail =
            `<p role="status">Your group is ready.</p><button data-action="enter-match" class="primary" ${disabled}>Enter matched town</button>`;
    }
    root.innerHTML = `<h2>Find players</h2>${detail}<p role="alert">${toLobbyHtml(resource.error ?? '')}</p>${
        resource.retryPending
            ? `<button data-action="retry-matchmaking-action" ${
                resource.busy ? 'disabled' : ''
            }>Retry matchmaking action</button>`
            : ''
    }<button data-action="retry-search" ${disabled}>Refresh matchmaking</button>`;
}

export function renderFriends(root: HTMLElement, state: OnlineSession.State): void {
    if (!root.childElementCount) {
        root.innerHTML =
            `<h2>Friends</h2><form id="add-friend"><label>Friend username<input name="friend" required maxlength="64"></label><button>Send friend request</button></form><div id="friend-results"></div>`;
    }
    const results = root.querySelector('#friend-results');
    if (!results) {
        return;
    }
    const { view, busy, error, retryPending } = state.friends;
    const friends =
        view?.contacts.map((person) => toFriendHtml(person, Boolean(state.rooms.currentRoomRef))).join('') ?? '';
    const invitations = view?.invitations.map((invite) => {
        const sender = view.contacts.find((person) => person.principalId === invite.senderPrincipalId);
        return `<li>${
            toLobbyHtml(sender?.displayName || 'A friend')
        } invited you.<button data-action="open-invitation" data-invitation="${
            toLobbyHtml(invite.invitationId)
        }">Open invitation</button><button data-action="dismiss" data-invitation="${
            toLobbyHtml(invite.invitationId)
        }">Dismiss</button></li>`;
    }).join('') ?? '';
    results.innerHTML = `<p role="alert">${toLobbyHtml(error ?? '')}</p><ul>${
        friends || '<li>No friends yet.</li>'
    }</ul><ul>${invitations}</ul><button data-action="visibility">${
        view?.shareOnline ? 'Hide online status' : 'Share online status with friends'
    }</button><button data-action="refresh-social">Refresh friends</button>${
        retryPending
            ? '<button data-action="retry-friend-action">Retry friend action</button>'
            : ''
    }`;
    for (const button of root.querySelectorAll('button')) {
        button.disabled = busy || (retryPending && button.dataset.action !== 'retry-friend-action');
    }
}

function toFriendHtml(person: FriendPerson, hasRoom: boolean): string {
    const principal = toLobbyHtml(person.principalId);
    let actions: [action: string, label: string][];
    switch (person.status) {
        case 'incoming':
            actions = [['accept', 'Accept'], ['decline', 'Decline']];
            break;
        case 'outgoing':
            actions = [['cancel-friend', 'Cancel request']];
            break;
        case 'blocked':
            actions = [['unblock', 'Unblock']];
            break;
        case 'friend':
            actions = hasRoom ? [['invite', 'Invite to town'], ['remove', 'Remove']] : [['remove', 'Remove']];
    }
    if (person.status !== 'blocked') {
        actions.push(['block', 'Block']);
    }
    return `<li class="friend"><strong>${
        toLobbyHtml(person.displayName || person.username)
    }</strong><span>${person.status} · ${person.presence}</span><div class="button-row">${
        actions.map(([action, label]) =>
            `<button data-action="${action}" data-principal="${principal}">${label}</button>`
        ).join('')
    }</div></li>`;
}

function toLobbyHtml(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}
