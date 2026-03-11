import { NA, type RoomUiState, RoomUiStatus } from './room-ui-types';
import type { RoomDriver } from './room-transport';
import { mustEl } from '../utils/utils';

const InitialState: RoomUiState = {
    status: RoomUiStatus.Idle,
    rooms: [],
    selectedRoomId: NA,
    selectedRoomName: '',
    members: [],
    message: '',
};

export class EhRoomLobby extends HTMLElement {
    private driver: RoomDriver | undefined = undefined;
    private state: RoomUiState = InitialState;

    get roomDriver(): RoomDriver {
        if (!this.driver) {
            throw new Error('Room driver not set');
        }
        return this.driver;
    }

    set roomDriver(d: RoomDriver) {
        // allow reassignment
        this.driver?.dispose();
        this.driver = d;
        d.setStateSink((s) => this.setState(s));
    }

    connectedCallback(): void {
        this.render();
        this.wire();
    }

    disconnectedCallback(): void {
        this.driver?.dispose();
    }

    private emitRoomEvent(type: 'room:joined' | 'room:left' | 'room:members', detail: unknown): void {
        this.dispatchEvent(
            new CustomEvent(type, {
                detail,
                bubbles: true,
                composed: true,
            }),
        );
    }

    private setState(s: RoomUiState): void {
        const prevSelected = this.state.selectedRoomId;
        this.state = s;
        this.update();

        // Emit joined/left events based on selectedRoomId transitions.
        const nextSelected = s.selectedRoomId;
        if (prevSelected !== nextSelected) {
            if (prevSelected !== NA && nextSelected === NA) {
                this.emitRoomEvent('room:left', { roomId: prevSelected });
            }
            if (nextSelected !== NA) {
                this.emitRoomEvent('room:joined', { roomId: nextSelected, roomName: s.selectedRoomName });
            }
        }

        // Always emit members updates for the currently selected room.
        if (nextSelected !== NA) {
            this.emitRoomEvent('room:members', {
                roomId: nextSelected,
                members: s.members,
            });
        }
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Rooms</h2>

        <div class="row">
          <input id="roomName" type="text" placeholder="Room name" />
          <button id="createBtn">Create</button>
          <button id="refreshBtn">Refresh</button>
        </div>

        <div class="row">
          <select id="roomSelect"></select>
          <button id="joinBtn">Join</button>
          <button id="leaveBtn">Leave</button>
        </div>

        <div class="muted">
          <div>Selected: <strong id="selectedRoom">${NA}</strong></div>
          <div>Status: <strong id="statusText">Idle</strong></div>
        </div>

        <div class="card" style="margin-top:12px;">
          <h3>Members</h3>
          <div id="members"></div>
        </div>

        <div id="message" class="status"></div>
      </div>
    `;
    }

    private wire(): void {
        const createBtn = mustEl<HTMLButtonElement>(this, '#createBtn');
        const refreshBtn = mustEl<HTMLButtonElement>(this, '#refreshBtn');
        const joinBtn = mustEl<HTMLButtonElement>(this, '#joinBtn');
        const leaveBtn = mustEl<HTMLButtonElement>(this, '#leaveBtn');

        createBtn.addEventListener('click', () => void this.onCreate());
        refreshBtn.addEventListener('click', () => void this.driver?.listRooms());
        joinBtn.addEventListener('click', () => void this.onJoinSelected());
        leaveBtn.addEventListener('click', () => void this.driver?.leaveRoom());
    }

    private update(): void {
        const sel = mustEl<HTMLSelectElement>(this, '#roomSelect');
        const selectedRoom = mustEl<HTMLSpanElement>(this, '#selectedRoom');
        const statusText = mustEl<HTMLSpanElement>(this, '#statusText');
        const membersEl = mustEl<HTMLDivElement>(this, '#members');
        const messageEl = mustEl<HTMLDivElement>(this, '#message');

        // Update dropdown
        sel.innerHTML = this.state.rooms
            .map((r) => `<option value="${r.roomId}">${r.name} (${r.memberCount})</option>`)
            .join('');

        // Preserve selection if possible
        if (this.state.selectedRoomId !== NA) {
            sel.value = this.state.selectedRoomId;
        }

        selectedRoom.textContent =
            this.state.selectedRoomId === NA ? NA : `${this.state.selectedRoomName} (${this.state.selectedRoomId})`;

        statusText.textContent = this.state.status;

        // Members list
        if (this.state.members.length === 0) {
            membersEl.textContent = 'No members.';
        } else {
            membersEl.innerHTML = `
        <ul>
          ${this.state.members
                .map((m) => `<li>${m.username} ${m.isOwner ? '(owner)' : ''} ${m.isOnline ? '' : '(offline)'}</li>`)
                .join('')}
        </ul>
      `;
        }

        messageEl.textContent = this.state.message;
    }

    private async onCreate(): Promise<void> {
        const input = mustEl<HTMLInputElement>(this, '#roomName');
        const name = input.value.trim();
        if (name.length === 0) {
            this.setState({ ...this.state, message: 'Room name is required.' });
            return;
        }
        await this.driver?.createRoom(name);
        input.value = '';
    }

    private async onJoinSelected(): Promise<void> {
        const sel = mustEl<HTMLSelectElement>(this, '#roomSelect');
        const roomId = sel.value;
        if (!roomId || roomId.length === 0) return;
        await this.driver?.joinRoom(roomId);
    }
}

customElements.define('eh-room-lobby', EhRoomLobby);
