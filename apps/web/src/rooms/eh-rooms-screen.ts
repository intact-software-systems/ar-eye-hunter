import { WebRtcRoomAvAdapter } from '../av/webrtcRoomAvAdapter';
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

        const driver = createRoomDriverWs(mw);
        lobby.roomDriver = driver;

        const av = this.querySelector('#av') as HTMLElement;
        const avPanel = this.querySelector('#av') as any;
        let avAdapter: WebRtcRoomAvAdapter | undefined = undefined;

        lobby.addEventListener('room:joined', () => {
            // Show the panel when a room is selected/joined.
            av.style.display = '';

            // Wire the A/V UI to the existing WebRTC service (peer manager) from middleware.
            if (!avAdapter) {
                avAdapter = new WebRtcRoomAvAdapter(mw.middleware.webRtcQueueBox);
            }
            avPanel.roomAvAdapter = avAdapter;
        });

        lobby.addEventListener('room:left', () => {
            // Hide the panel when leaving a room.
            av.style.display = 'none';

            // Best-effort: leave A/V if joined.
            if (avAdapter && avAdapter.isJoined()) {
                void avAdapter.leaveAv();
            }
        });

        void driver.listRooms();
    }
}

customElements.define('eh-rooms-screen', EhRoomsScreen);