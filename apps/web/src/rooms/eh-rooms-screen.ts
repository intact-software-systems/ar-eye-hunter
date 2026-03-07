import { EhRoomLobby } from './eh-room-lobby';
import { getMiddleware } from '../app-context';
import { createRoomDriverWs } from './room-transport';

export class EhRoomsScreen extends HTMLElement {
    connectedCallback(): void {
        this.innerHTML = `
            <eh-room-lobby id="lobby"></eh-room-lobby>
            <eh-room-av-panel id="av" style="display:none"></eh-room-av-panel>
        `;

        const lobby = this.querySelector('#lobby') as EhRoomLobby;
        const mw = getMiddleware();

        const driver = createRoomDriverWs(mw.session.sessionId);
        lobby.roomDriver = driver;

        const av = this.querySelector('#av') as HTMLElement;

        lobby.addEventListener('room:joined', () => {
            // Show the panel when a room is selected/joined.
            av.style.display = '';
            // NOTE: adapter wiring will be done here once the RTC service per room is available.
        });

        lobby.addEventListener('room:left', () => {
            // Hide the panel when leaving a room.
            av.style.display = 'none';
        });

        void driver.listRooms();
    }
}

customElements.define('eh-rooms-screen', EhRoomsScreen);