import { renderGuestSharing } from './render-guest-sharing.ts';
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
        if (state.ownsTown) renderGuestSharing(sharing, state.invitation, state.busy);
        else sharing.replaceChildren();
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
