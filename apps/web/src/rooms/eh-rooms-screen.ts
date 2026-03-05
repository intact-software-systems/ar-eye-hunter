import { EhRoomLobby } from './eh-room-lobby';
import { getMiddleware } from '../app-context';
import { createRoomDriverWs } from './room-transport';

export class EhRoomsScreen extends HTMLElement {
    connectedCallback(): void {
        this.innerHTML = `<eh-room-lobby id="lobby"></eh-room-lobby>`;

        const lobby = this.querySelector('#lobby') as EhRoomLobby;
        const mw = getMiddleware();

        const driver = createRoomDriverWs(mw.session.sessionId);
        lobby.roomDriver = driver;

        // initial load
        void driver.listRooms();
    }
}

customElements.define('eh-rooms-screen', EhRoomsScreen);