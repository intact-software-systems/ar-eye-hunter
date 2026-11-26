import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';

export function mountEventRoster(browser: RallarFacade, form: HTMLFormElement, output: HTMLElement): void {
    const controls = document.createElement('section');
    controls.setAttribute('aria-label', 'Event handover');
    output.after(controls);
    let stop: (() => void) | undefined;
    function clear(): void {
        stop?.();
        stop = undefined;
        output.replaceChildren();
        controls.replaceChildren();
    }
    window.addEventListener('pagehide', clear);
    form.onsubmit = event => {
        event.preventDefault();
        clear();
        const selected = browser.rooms.selected();
        if (!selected) {
            output.textContent = 'Enter a court before choosing its event lobby.';
            return;
        }
        const lobby = { applicationId: selected.applicationId, workspaceId: selected.workspaceId, groupId: String(new FormData(form).get('lobby')).trim() };
        const player = new RallarRoomEvent(browser, lobby);
        const roster = player.organizerView();
        function displayHandover(): void {
            const { view, busy, error } = player.getState();
            controls.replaceChildren();
            if (!view) return;
            const offer = view.handover;
            const rosterView = roster.getState().view;
            if (offer) {
                const receiving = offer.recipientId === view.principalId;
                const button = document.createElement('button');
                button.textContent = receiving ? 'Accept handover' : 'Cancel handover';
                button.disabled = busy;
                button.onclick = () => void player.act({ action: receiving ? 'accept-handover' : 'cancel-handover', offerId: offer.offerId });
                const deadline = document.createElement('p');
                deadline.textContent = 'Handover to ' + offer.recipientId + ' expires at ' + new Date(offer.expiresAt).toLocaleTimeString();
                controls.append(deadline, button);
            } else if (rosterView) {
                const candidates = rosterView.players.filter(member => member.principalId !== view.principalId);
                const label = document.createElement('label');
                label.textContent = 'Next organizer ';
                const select = document.createElement('select');
                for (const member of candidates) select.add(new Option(member.displayName, member.principalId));
                label.append(select);
                const button = document.createElement('button');
                button.textContent = 'Offer handover';
                button.disabled = busy || candidates.length === 0;
                button.onclick = () => void player.act({ action: 'offer-handover', recipientId: select.value });
                controls.append(label, button);
            }
            if (error) {
                const message = document.createElement('p');
                message.setAttribute('role', 'alert');
                message.textContent = error;
                controls.append(message);
            }
        }
        const unsubscribe = roster.onChange(({ view, error }) => {
            displayHandover();
            if (!view) {
                output.textContent = error ?? 'Loading roster…';
                return;
            }
            const names = new Map(view.players.map(player => [player.principalId, player.displayName]));
            const lines = view.courts.map(court => {
                const seats = court.seats.map(seat => {
                    const status = seat.deadline === null ? 'claimed' : 'claim by ' + new Date(seat.deadline).toLocaleTimeString();
                    return names.get(seat.principalId) + ' (' + seat.partyId + ', ' + status + ')';
                });
                return court.groupId + ' — ' + (seats.join(', ') || 'available');
            });
            view.queue.forEach((party, index) => lines.push((index + 1) + '. ' + party.id + ' — ' + party.players.map(id => names.get(id)).join(', ')));
            output.replaceChildren(...lines.map(line => {
                const paragraph = document.createElement('p');
                paragraph.textContent = line;
                return paragraph;
            }));
        });
        const unsubscribePlayer = player.onChange(displayHandover);
        stop = () => { unsubscribe(); unsubscribePlayer(); roster.stop(); player.stop(); };
        void Promise.all([player.start(), roster.start()]);
    };
}
