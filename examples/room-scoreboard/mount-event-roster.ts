import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';

export function mountEventRoster(browser: RallarFacade, form: HTMLFormElement, output: HTMLElement): void {
    let stop: (() => void) | undefined;
    function clear(): void {
        stop?.();
        stop = undefined;
        output.replaceChildren();
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
        const roster = new RallarRoomEvent(browser, lobby).organizerView();
        const unsubscribe = roster.onChange(({ view, error }) => {
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
        stop = () => { unsubscribe(); roster.stop(); };
        void roster.start();
    };
}
