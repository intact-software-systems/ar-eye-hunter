import { renderSVG } from 'uqr';
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
        roster.replaceChildren(...state.rooms.members.filter(member => member.status === 'active').map(member => {
            const guest = state.rooms.currentRoom?.members.find(row => row.principalId === member.principalId)?.guestLease;
            const displayName = guest?.displayName ??
                (state.friends.view?.contacts.find(person => person.principalId === member.principalId)?.displayName ||
                    member.displayName || member.username);
            const row = document.createElement('li');
            row.textContent = `${displayName} · ${member.isOnline ? 'here' : 'away'}${member.isOwner ? ' · room owner' : ''}`;
            if (state.ownsTown && guest) {
                const remove = document.createElement('button');
                remove.dataset.action = 'remove-guest';
                remove.dataset.principal = member.principalId;
                remove.textContent = 'Remove guest';
                row.append(remove);
            }
            return row;
        }));
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
