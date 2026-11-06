import { expect, type Page, type Response, type WebSocket } from '@playwright/test';
import {
    decodeArenaTournamentSnapshot,
    type ArenaTournamentSnapshot
} from '../../../packages/ar-eye-hunter/arena-tournament-snapshot.ts';
import {
    decodeArenaTournamentFrame,
    isArenaTournamentFrameMessage
} from '../../../packages/ar-eye-hunter/arena-tournament-stream.ts';
import type { TournamentArena } from '../../../packages/ar-eye-hunter/tournament-arena.ts';
import { decodeALMessage } from '../../../packages/shared/al-contracts/al-message-persistence-validation.ts';
import { jsonEquals } from '../../../packages/shared/repository/state-utils.ts';

/** Observes only the public HTTP response and WS frames received by this player's real page. */
export class TournamentFrameObserver {
    private anchor: ArenaTournamentSnapshot | null = null;
    private latest: ArenaTournamentSnapshot | null = null;
    private connection = 0;
    private socket: WebSocket | undefined;

    constructor(page: Page) {
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                this.anchor = null;
                this.latest = null;
            }
        });
        page.on('response', (response) => this.readAnchor(response));
        page.on('websocket', (socket) => {
            if (!new URL(socket.url()).pathname.startsWith('/api/ws/')) {
                return;
            }
            this.connection++;
            this.latest = null;
            this.socket = socket;
            socket.on('framereceived', ({ payload }) => this.readFrame(socket, payload));
        });
    }

    get generation(): number {
        return this.connection;
    }

    async playing(roomId: string): Promise<TournamentArena> {
        await expect.poll(() => this.latest?.binding.roomRef.groupId, {
            message: 'Expected a live native snapshot bound to the authorized room'
        }).toBe(roomId);
        const arena = this.latest?.state;
        if (!arena) {
            throw new Error('The observed native frame does not contain the playing arena');
        }
        return arena;
    }

    private async readAnchor(response: Response): Promise<void> {
        const path = new URL(response.url()).pathname;
        if (
            response.request().method() !== 'GET' || !/^\/api\/ar-eye\/rooms\/[^/]+\/tournament$/.test(path) ||
            !response.ok()
        ) {
            return;
        }
        const value = await response.json();
        if (value === null) {
            return;
        }
        const snapshot = decodeArenaTournamentSnapshot(value);
        if (!this.anchor || !jsonEquals(this.anchor.binding, snapshot.binding)) {
            this.latest = null;
        }
        this.anchor = snapshot;
    }

    private async readFrame(socket: WebSocket, payload: string | Buffer): Promise<void> {
        const anchor = this.anchor;
        if (!anchor || socket !== this.socket || socket.isClosed()) {
            return;
        }
        const raw = decodeALMessage(payload.toString()).right;
        if (!raw || !isArenaTournamentFrameMessage(raw, anchor.binding)) {
            return;
        }
        const snapshot = await decodeArenaTournamentFrame(JSON.parse(raw.payload.resource));
        if (
            socket === this.socket && !socket.isClosed() && this.anchor &&
            jsonEquals(this.anchor.binding, snapshot.binding) &&
            snapshot.attemptRevision >= this.anchor.attemptRevision &&
            snapshot.attemptRevision > (this.latest?.attemptRevision ?? -1)
        ) {
            this.latest = snapshot;
        }
    }
}
