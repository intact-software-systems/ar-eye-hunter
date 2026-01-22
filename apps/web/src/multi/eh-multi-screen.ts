import {ClientId, CreateGameRequest, GameId, GameModeType, JoinGameRequest, MakeMoveRequest,} from '@shared/mod.ts';
import {BoardMove, Cell, CpuDifficulty, GameResult, type GameState, Player,} from '@shared/mod.ts';

import {createGamesApi, NAString} from './apiClient.ts';

import type {CellClickDetail} from '../components/eh-ttt-board.ts';

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

function apiBaseUrl(): string {
    // Use VITE_API_BASE_URL in production (e.g. https://your-project.deno.dev)
    // In dev you can keep it empty + use Vite proxy for /api.
    const env = (import.meta as any).env;
    const raw = (env?.VITE_API_BASE_URL as string) || '';
    return raw.length > 0 ? raw : '';
}

function emptyState(): GameState {
    return {
        board: Array(9).fill(Cell.Empty),
        currentPlayer: Player.NA,
        result: GameResult.InProgress,
        // mode is not needed for rendering the board; but GameState requires it.
        // Your server will provide the real mode. For this placeholder "not connected" state,
        // we keep an explicit structure while avoiding null.
        mode: {type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Empty}, // see note below
    };
}

/**
 * NOTE:
 * If your `GameModeType.LocalHuman` enum is in @shared/mod, you can replace:
 *   mode: { type: GameModeType.LocalHuman }
 * Here I used `as any` only to avoid guessing how you export/import it in your actual repo layout.
 * If you want, paste your current @shared/mod exports and I’ll make this 100% strict (no `any`).
 */

type MultiUiState = {
    gameId: GameId | NAString;
    assignedPlayer: Player;
    serverState: GameState; // always defined; "not connected" uses explicit placeholder
    statusText: string;
    isPolling: boolean;
};

export class EhMultiScreen extends HTMLElement {
    private readonly clientId: ClientId = getOrCreateClientId();
    private readonly api = createGamesApi(apiBaseUrl());

    private ui: MultiUiState = {
        gameId: NAString.NA,
        assignedPlayer: Player.NA,
        serverState: emptyState(),
        statusText: 'Create a game or join an existing game.',
        isPolling: false,
    };

    private pollTimerId: number | NAString = NAString.NA;

    connectedCallback(): void {
        this.render();
        this.wire();
        this.updateView();
    }

    disconnectedCallback(): void {
        this.stopPolling();
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
          </div>
          <div>You: <strong id="playerText">${Player.NA}</strong></div>
          <div>Turn: <strong id="turnText">${Player.NA}</strong></div>
          <div>Sync: <strong id="syncText">stopped</strong></div>
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
        const board = mustEl<HTMLElement>(this, '#board');
        const copyIdBtn = mustEl<HTMLButtonElement>(this, '#copyIdBtn');

        createBtn.addEventListener('click', () => void this.onCreate());
        joinBtn.addEventListener('click', () => void this.onJoin(joinInput.value.trim()));
        leaveBtn.addEventListener('click', () => this.onLeave());

        copyIdBtn.addEventListener('click', () => void this.onCopyGameId());

        board.addEventListener('cell-click', (e: Event) => {
            const ce = e as CustomEvent<CellClickDetail>;
            void this.onCellClick(ce.detail.index);
        });
    }

    private updateView(): void {
        const gameIdText = mustEl<HTMLSpanElement>(this, '#gameIdText');
        const playerText = mustEl<HTMLSpanElement>(this, '#playerText');
        const turnText = mustEl<HTMLSpanElement>(this, '#turnText');
        const syncText = mustEl<HTMLSpanElement>(this, '#syncText');
        const statusEl = mustEl<HTMLDivElement>(this, '#status');
        const copyIdBtn = mustEl<HTMLButtonElement>(this, '#copyIdBtn');

        const hasGameId = this.ui.gameId !== NAString.NA;

        gameIdText.textContent = hasGameId ? this.ui.gameId : NAString.NA;
        playerText.textContent = this.ui.assignedPlayer;
        turnText.textContent = this.ui.serverState.currentPlayer;
        syncText.textContent = this.ui.isPolling ? 'polling' : 'stopped';

        copyIdBtn.disabled = !hasGameId;

        statusEl.textContent = this.ui.statusText;

        const board = mustEl<any>(this, '#board');
        board.state = this.ui.serverState;

        const canInteract =
            hasGameId &&
            this.ui.serverState.result === GameResult.InProgress &&
            this.ui.assignedPlayer !== Player.NA &&
            this.ui.serverState.currentPlayer === this.ui.assignedPlayer;

        board.locked = !canInteract;
    }

    private setStatus(text: string): void {
        this.ui = {...this.ui, statusText: text};
        this.updateView();
    }

    private startPolling(gameId: GameId): void {
        this.stopPolling();

        this.ui = {...this.ui, isPolling: true};
        this.updateView();

        this.pollTimerId = window.setInterval(async () => {
            if (this.ui.gameId === NAString.NA) {
                this.stopPolling();
                return;
            }

            try {
                const res = await this.api.getGame(gameId);
                this.ui = {...this.ui, serverState: res.state};

                if (res.state.result === GameResult.InProgress) {
                    const turn = res.state.currentPlayer;
                    if (turn === this.ui.assignedPlayer) {
                        this.ui = {...this.ui, statusText: `Your turn (${this.ui.assignedPlayer}).`};
                    } else {
                        this.ui = {...this.ui, statusText: `Waiting for opponent… (turn: ${turn})`};
                    }
                } else {
                    this.ui = {...this.ui, statusText: this.resultText(res.state.result)};
                }

                this.updateView();
            } catch (err) {
                this.setStatus(`Polling failed: ${(err as Error).message}`);
            }
        }, 1000);
    }

    private stopPolling(): void {
        if (this.pollTimerId !== NAString.NA) {
            clearInterval(this.pollTimerId);
            this.pollTimerId = NAString.NA;
        }
        if (this.ui.isPolling) {
            this.ui = {...this.ui, isPolling: false};
            this.updateView();
        }
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
            };

            this.updateView();
            this.startPolling(res.gameId);
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
            const res = await this.api.joinGame(gameId, req);

            this.ui = {
                ...this.ui,
                gameId: res.gameId,
                assignedPlayer: res.assignedPlayer,
                serverState: res.state,
                statusText: `Joined game ${res.gameId} as ${res.assignedPlayer}.`,
            };

            this.updateView();
            this.startPolling(res.gameId);
        } catch (err) {
            this.setStatus(`Join failed: ${(err as Error).message}`);
        }
    }

    private async onCellClick(index: number): Promise<void> {
        if (this.ui.gameId === NAString.NA) return;

        // Only allow if it’s your turn and game is active (board is also locked, but double-check here)
        if (this.ui.serverState.result !== GameResult.InProgress) return;
        if (this.ui.assignedPlayer === Player.NA) return;
        if (this.ui.serverState.currentPlayer !== this.ui.assignedPlayer) return;

        try {
            const req: MakeMoveRequest = {clientId: this.clientId, moveIndex: index};
            const res = await this.api.makeMove(this.ui.gameId, req);

            // Server is authoritative
            this.ui = {...this.ui, serverState: res.state};

            if (res.move === BoardMove.Failed) {
                this.ui = {...this.ui, statusText: 'Move rejected by server.'};
            } else if (res.state.result === GameResult.InProgress) {
                this.ui = {...this.ui, statusText: `Waiting for opponent… (turn: ${res.state.currentPlayer})`};
            } else {
                this.ui = {...this.ui, statusText: this.resultText(res.state.result)};
            }

            this.updateView();
        } catch (err) {
            this.setStatus(`Move failed: ${(err as Error).message}`);
        }
    }

    private onLeave(): void {
        this.stopPolling();
        this.ui = {
            gameId: NAString.NA,
            assignedPlayer: Player.NA,
            serverState: emptyState(),
            statusText: 'Left game. Create a game or join an existing game.',
            isPolling: false,
        };
        this.updateView();
    }

    private async onCopyGameId(): Promise<void> {
        if (this.ui.gameId === NAString.NA) {
            this.setStatus('No game id to copy.');
            return;
        }

        const text = this.ui.gameId;

        try {
            // Prefer Clipboard API
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                this.setStatus(`Copied game id: ${text}`);
                return;
            }

            // Fallback: hidden textarea + execCommand
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', 'true');
            ta.style.position = 'absolute';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();

            const ok = document.execCommand('copy');
            document.body.removeChild(ta);

            this.setStatus(ok ? `Copied game id: ${text}` : 'Copy failed.');
        } catch (err) {
            this.setStatus(`Copy failed: ${(err as Error).message}`);
        }
    }
}

customElements.define('eh-multi-screen', EhMultiScreen);
