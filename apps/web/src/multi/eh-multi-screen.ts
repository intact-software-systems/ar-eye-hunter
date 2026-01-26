import type {ClientId, CreateGameRequest, GameId, JoinGameRequest, MakeMoveRequest,} from '@shared/mod.ts';
import {
    Cell,
    CpuDifficulty,
    GameModeType,
    GameResult,
    type GameState,
    Player,
    type WsClientMessage,
    WsClientMsgType,
    type WsServerMessage,
    WsServerMsgType,
} from '@shared/mod.ts';

import {createGamesApi, NAString} from './apiClient.ts';
import type {CellClickDetail} from '../components/eh-ttt-board.ts';

/* ======================================================
   Utilities (no nulls)
   ====================================================== */

function mustEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    return el as T;
}

function getOrCreateClientId(): ClientId {
    const key = 'clientId';
    const existing = localStorage.getItem(key);
    if (existing && existing.length > 0) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
}

function emptyState(): GameState {
    return {
        board: Array(9).fill(Cell.Empty),
        currentPlayer: Player.NA,
        result: GameResult.InProgress,
        mode: {type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Empty},
    };
}

enum PendingMove {
    None = 'None',
    Waiting = 'Waiting',
}

enum WsConnKind {
    None = 'None',
    Connecting = 'Connecting',
    Open = 'Open',
}

type WsConn =
    | { kind: WsConnKind.None }
    | { kind: WsConnKind.Connecting; ws: WebSocket }
    | { kind: WsConnKind.Open; ws: WebSocket };

function readGameIdFromHash(): string {
    // hash: "#/multi?gameId=abc"
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const qIndex = raw.indexOf('?');
    if (qIndex < 0) return '';
    const query = raw.slice(qIndex + 1);
    const params = new URLSearchParams(query);
    const v = params.get('gameId');
    return v ? v : '';
}

async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }

        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/* ======================================================
   Component
   ====================================================== */

type MultiUiState = {
    gameId: GameId | NAString;
    assignedPlayer: Player;
    serverState: GameState; // always present (placeholder when not connected)
    statusText: string;
    pendingMove: PendingMove;
    wsConn: WsConn;
};

export class EhMultiScreen extends HTMLElement {
    private readonly clientId: ClientId = getOrCreateClientId();
    private readonly api = createGamesApi();

    private ui: MultiUiState = {
        gameId: NAString.NA,
        assignedPlayer: Player.NA,
        serverState: emptyState(),
        statusText: 'Create a game or join an existing game.',
        pendingMove: PendingMove.None,
        wsConn: {kind: WsConnKind.None},
    };

    connectedCallback(): void {
        this.render();
        this.wire();
        this.prefillFromShareLink();
        this.updateView();
    }

    disconnectedCallback(): void {
        this.closeWs();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Two-player (server)</h2>

        <div class="row">
          <button id="createBtn">Create game</button>

          <input id="joinInput" type="text" placeholder="Game ID to join" />
          <button id="joinBtn">Join</button>

          <button id="leaveBtn">Leave</button>
        </div>

        <div class="row muted">
          <div>
            Game ID: <strong id="gameIdText">${NAString.NA}</strong>
            <button id="copyIdBtn" style="margin-left:8px;">Copy</button>
            <button id="shareBtn" style="margin-left:8px;">Share link</button>
          </div>
          <div>You: <strong id="playerText">${Player.NA}</strong></div>
          <div>Turn: <strong id="turnText">${Player.NA}</strong></div>
          <div>WS: <strong id="wsText">closed</strong></div>
        </div>

        <eh-ttt-board id="board"></eh-ttt-board>

        <div id="status" class="status"></div>
      </div>
    `;
    }

    private wire(): void {
        const createBtn = mustEl<HTMLButtonElement>(this, '#createBtn');
        const joinBtn = mustEl<HTMLButtonElement>(this, '#joinBtn');
        const leaveBtn = mustEl<HTMLButtonElement>(this, '#leaveBtn');
        const joinInput = mustEl<HTMLInputElement>(this, '#joinInput');

        const copyIdBtn = mustEl<HTMLButtonElement>(this, '#copyIdBtn');
        const shareBtn = mustEl<HTMLButtonElement>(this, '#shareBtn');

        const board = mustEl<HTMLElement>(this, '#board');

        createBtn.addEventListener('click', () => void this.onCreate());
        joinBtn.addEventListener('click', () => void this.onJoin(joinInput.value.trim()));
        leaveBtn.addEventListener('click', () => this.onLeave());

        copyIdBtn.addEventListener('click', () => void this.onCopyGameId());
        shareBtn.addEventListener('click', () => void this.onShareLink());

        board.addEventListener('cell-click', (e: Event) => {
            const ce = e as CustomEvent<CellClickDetail>;
            void this.onCellClick(ce.detail.index);
        });
    }

    private prefillFromShareLink(): void {
        const joinInput = mustEl<HTMLInputElement>(this, '#joinInput');
        const sharedId = readGameIdFromHash();
        if (sharedId.length > 0) {
            joinInput.value = sharedId;
            this.setStatus('Game ID prefilled from share link. Click Join.');
        }
    }

    private updateView(): void {
        const gameIdText = mustEl<HTMLSpanElement>(this, '#gameIdText');
        const playerText = mustEl<HTMLSpanElement>(this, '#playerText');
        const turnText = mustEl<HTMLSpanElement>(this, '#turnText');
        const wsText = mustEl<HTMLSpanElement>(this, '#wsText');
        const statusEl = mustEl<HTMLDivElement>(this, '#status');

        const copyIdBtn = mustEl<HTMLButtonElement>(this, '#copyIdBtn');
        const shareBtn = mustEl<HTMLButtonElement>(this, '#shareBtn');

        const hasGameId = this.ui.gameId !== NAString.NA;

        gameIdText.textContent = hasGameId ? this.ui.gameId : NAString.NA;
        playerText.textContent = this.ui.assignedPlayer;
        turnText.textContent = this.ui.serverState.currentPlayer;

        wsText.textContent = this.ui.wsConn.kind === WsConnKind.Open ? 'open' : 'closed';

        copyIdBtn.disabled = !hasGameId;
        shareBtn.disabled = !hasGameId;

        statusEl.textContent = this.ui.statusText;

        const board = mustEl<any>(this, '#board');
        board.state = this.ui.serverState;

        const canInteract =
            hasGameId &&
            this.ui.wsConn.kind === WsConnKind.Open &&
            this.ui.pendingMove === PendingMove.None &&
            this.ui.serverState.result === GameResult.InProgress &&
            this.ui.assignedPlayer !== Player.NA &&
            this.ui.serverState.currentPlayer === this.ui.assignedPlayer;

        board.locked = !canInteract;
    }

    private setStatus(text: string): void {
        this.ui = {...this.ui, statusText: text};
        this.updateView();
    }

    /* ======================================================
       WS management
       ====================================================== */

    private openWs(gameId: GameId): void {
        this.closeWs();

        const ws = new WebSocket(this.api.wsUrl);

        this.ui = {...this.ui, wsConn: {kind: WsConnKind.Connecting, ws}};
        this.updateView();

        ws.addEventListener('open', () => {
            this.ui = {...this.ui, wsConn: {kind: WsConnKind.Open, ws}};
            this.updateView();

            const hello: WsClientMessage = {
                type: WsClientMsgType.Hello,
                clientId: this.clientId,
                gameId,
            };
            ws.send(JSON.stringify(hello));
            this.setStatus('Open. Waiting for updates…');
        });

        ws.addEventListener('message', (ev) => {
            const raw = typeof ev.data === 'string' ? ev.data : '';
            const parsed = this.safeParseServerMessage(raw);

            if (parsed.kind === 'Invalid') {
                this.setStatus('Received invalid WS message.');
                return;
            }

            this.handleServerMessage(parsed.msg);
        });

        ws.addEventListener('close', () => {
            this.ui = {...this.ui, wsConn: {kind: WsConnKind.None}};
            this.setStatus('WebSocket closed.');
            this.updateView();
        });

        ws.addEventListener('error', () => {
            this.ui = {...this.ui, wsConn: {kind: WsConnKind.None}};
            this.setStatus('WebSocket error.');
            this.updateView();
        });
    }

    private closeWs(): void {
        if (this.ui.wsConn.kind === WsConnKind.Open) {
            try {
                this.ui.wsConn.ws.close();
            } catch {
                // ignore
            }
        }
        this.ui = {...this.ui, wsConn: {kind: WsConnKind.None}, pendingMove: PendingMove.None};
        this.updateView();
    }

    private safeParseServerMessage(raw: string): { kind: 'Ok'; msg: WsServerMessage } | { kind: 'Invalid' } {
        try {
            const msg = JSON.parse(raw) as WsServerMessage;
            return {kind: 'Ok', msg};
        } catch {
            return {kind: 'Invalid'};
        }
    }

    private handleServerMessage(msg: WsServerMessage): void {
        // Ignore messages not matching the current game
        if (this.ui.gameId === NAString.NA) return;
        if (msg.gameId !== this.ui.gameId) return;

        switch (msg.type) {
            case WsServerMsgType.Welcome: {
                this.ui = {
                    ...this.ui,
                    serverState: msg.state,
                    pendingMove: PendingMove.None,
                    statusText: this.inProgressText(msg.state),
                };
                this.updateView();
                return;
            }

            case WsServerMsgType.StateUpdate: {
                const nextStatus =
                    msg.state.result === GameResult.InProgress
                        ? this.inProgressText(msg.state)
                        : this.resultText(msg.state.result);

                this.ui = {
                    ...this.ui,
                    serverState: msg.state,
                    pendingMove: PendingMove.None,
                    statusText: nextStatus,
                };
                this.updateView();
                return;
            }

            case WsServerMsgType.Error: {
                this.ui = {
                    ...this.ui,
                    pendingMove: PendingMove.None,
                    statusText: `Server error: ${msg.message}`,
                };
                this.updateView();
                return;
            }
        }
    }

    private inProgressText(state: GameState): string {
        if (this.ui.assignedPlayer === Player.NA) return 'Waiting for player assignment…';
        if (state.currentPlayer === this.ui.assignedPlayer) return `Your turn (${this.ui.assignedPlayer}).`;
        return `Waiting for opponent… (turn: ${state.currentPlayer})`;
    }

    private resultText(result: GameResult): string {
        switch (result) {
            case GameResult.XWins:
                return 'Game over: X wins!';
            case GameResult.OWins:
                return 'Game over: O wins!';
            case GameResult.Draw:
                return 'Game over: Draw!';
            case GameResult.InProgress:
            default:
                return 'Game in progress.';
        }
    }

    /* ======================================================
       Actions
       ====================================================== */

    private async onCreate(): Promise<void> {
        try {
            const req: CreateGameRequest = {clientId: this.clientId};
            const res = await this.api.createGame(req);

            this.ui = {
                ...this.ui,
                gameId: res.gameId,
                assignedPlayer: res.assignedPlayer,
                serverState: res.state,
                statusText: `Game created. Share ID with opponent: ${res.gameId}`,
                pendingMove: PendingMove.None,
            };

            this.updateView();
            this.openWs(res.gameId);
        } catch (err) {
            this.setStatus(`Create failed: ${(err as Error).message}`);
        }
    }

    private async onJoin(gameId: string): Promise<void> {
        if (gameId.length === 0) {
            this.setStatus('Enter a game id to join.');
            return;
        }

        try {
            const req: JoinGameRequest = {clientId: this.clientId};
            const res = await this.api.joinGame(gameId as GameId, req);

            this.ui = {
                ...this.ui,
                gameId: res.gameId,
                assignedPlayer: res.assignedPlayer,
                serverState: res.state,
                statusText: `Joined game ${res.gameId} as ${res.assignedPlayer}.`,
                pendingMove: PendingMove.None,
            };

            this.updateView();
            this.openWs(res.gameId);
        } catch (err) {
            this.setStatus(`Join failed: ${(err as Error).message}`);
        }
    }

    private async onCellClick(index: number): Promise<void> {
        if (this.ui.gameId === NAString.NA) return;
        if (this.ui.wsConn.kind !== WsConnKind.Open) return;
        if (this.ui.wsConn.ws.readyState !== WebSocket.OPEN) {
            this.setStatus('WebSocket not open yet. Please wait…');
            return;
        }

        // Must be your turn
        if (this.ui.serverState.result !== GameResult.InProgress) return;
        if (this.ui.assignedPlayer === Player.NA) return;
        if (this.ui.serverState.currentPlayer !== this.ui.assignedPlayer) return;

        // Mark pending to avoid double-send
        this.ui = {...this.ui, pendingMove: PendingMove.Waiting};
        this.updateView();

        const req: MakeMoveRequest = {clientId: this.clientId, moveIndex: index};

        const msg: WsClientMessage = {
            type: WsClientMsgType.MakeMove,
            clientId: req.clientId,
            gameId: this.ui.gameId,
            moveIndex: req.moveIndex,
        };

        try {
            this.ui.wsConn.ws.send(JSON.stringify(msg));
            // We’ll clear pending when the server broadcasts StateUpdate (or Error).
        } catch (e) {
            this.ui = {...this.ui, pendingMove: PendingMove.None};
            this.setStatus('Failed to send move over WebSocket.');
            console.error(e);
        }
    }

    private onLeave(): void {
        this.closeWs();

        this.ui = {
            gameId: NAString.NA,
            assignedPlayer: Player.NA,
            serverState: emptyState(),
            statusText: 'Left game. Create a game or join an existing game.',
            pendingMove: PendingMove.None,
            wsConn: {kind: WsConnKind.None},
        };

        const joinInput = mustEl<HTMLInputElement>(this, '#joinInput');
        joinInput.value = '';

        this.updateView();
    }

    /* ======================================================
       Copy / Share
       ====================================================== */

    private async onCopyGameId(): Promise<void> {
        if (this.ui.gameId === NAString.NA) {
            this.setStatus('No game id to copy.');
            return;
        }
        const ok = await copyToClipboard(this.ui.gameId);
        this.setStatus(ok ? `Copied game id: ${this.ui.gameId}` : 'Copy failed.');
    }

    private buildShareUrl(gameId: string): string {
        const base = `${location.origin}${location.pathname}`;
        const encoded = encodeURIComponent(gameId);
        return `${base}#/multi?gameId=${encoded}`;
    }

    private async onShareLink(): Promise<void> {
        if (this.ui.gameId === NAString.NA) {
            this.setStatus('No game id to share.');
            return;
        }
        const url = this.buildShareUrl(this.ui.gameId);
        const ok = await copyToClipboard(url);
        this.setStatus(ok ? 'Share link copied to clipboard.' : 'Copy failed.');
    }
}

customElements.define('eh-multi-screen', EhMultiScreen);