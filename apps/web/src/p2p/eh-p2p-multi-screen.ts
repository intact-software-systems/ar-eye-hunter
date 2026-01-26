import {
    GameResult,
    type GameState,
    P2pRole,
    Player,
} from '@shared/mod.ts';

import {
    emptyState,
    myPlayerFromRole,
    applyLocalMove,
    applyRemoteMove,
    ProtocolDecision,
    RejectionReason,
    P2pMsgType,
    parseP2pMsg,
    stateHash,
    makeMoveMsg,
    makeResyncRequestMsg,
    makeStateSyncMsg,
    validateStateSync,
    type P2pMoveMsg,
    type P2pResetMsg,
    type P2pHelloMsg,
    type P2pResyncRequestMsg,
    type P2pStateSyncMsg,
} from './p2pProtocol.ts';

import {P2pSignalingClient, SignalingStateKind} from './signalingClient.ts';
import {WebRtcSession, WebRtcSessionStatus} from './webrtcSession.ts';

import type {CellClickDetail} from '../components/eh-ttt-board.ts';

/* ======================================================
   Utilities
   ====================================================== */

function mustEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    return el as T;
}

function getOrCreateClientId(): string {
    const key = 'clientId';
    const existing = localStorage.getItem(key);
    if (existing && existing.length > 0) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
}

// function emptyState(): GameState {
//     return {
//         board: Array(9).fill(Cell.Empty),
//         currentPlayer: Player.X,
//         result: GameResult.InProgress,
//         mode: { type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Empty },
//     };
// }

function readSessionIdFromHash(): string {
    // hash: "#/p2p?sessionId=abc"
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const qIndex = raw.indexOf('?');
    if (qIndex < 0) return '';
    const query = raw.slice(qIndex + 1);
    const params = new URLSearchParams(query);
    const v = params.get('sessionId');
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
   UI state
   ====================================================== */

enum NAString {
    NA = 'NA',
}

type UiState = {
    sessionId: string | NAString;
    role: P2pRole | NAString;
    rtcStatus: WebRtcSessionStatus;
    statusText: string;

    game: GameState;
};

export class EhP2pMultiScreen extends HTMLElement {
    private readonly clientId = getOrCreateClientId();

    private signaling: P2pSignalingClient = new P2pSignalingClient();
    private rtc: WebRtcSession | undefined = undefined;

    private ui: UiState = {
        sessionId: NAString.NA,
        role: NAString.NA,
        rtcStatus: WebRtcSessionStatus.Idle,
        statusText: 'Create a session or join an existing session.',
        game: emptyState(),
    };

    connectedCallback(): void {
        this.render();
        this.wire();
        this.prefillFromShareLink();
        this.updateView();
    }

    disconnectedCallback(): void {
        this.cleanup();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>P2P Multiplayer (WebRTC)</h2>
        <p class="muted">
          Uses API for signaling, then sends moves over a WebRTC data channel.
        </p>

        <div class="row">
          <button id="createBtn">Create session</button>

          <input id="joinInput" type="text" placeholder="Session ID to join" />
          <button id="joinBtn">Join</button>

          <button id="leaveBtn">Leave</button>
          <button id="resetBtn">Reset</button>
        </div>

        <div class="row muted">
          <div>
            Session: <strong id="sessionText">${NAString.NA}</strong>
            <button id="copyBtn" style="margin-left:8px;">Copy</button>
            <button id="shareBtn" style="margin-left:8px;">Share link</button>
          </div>

          <div>Role: <strong id="roleText">${NAString.NA}</strong></div>
          <div>WebRTC: <strong id="rtcText">Idle</strong></div>
        </div>

        <eh-ttt-board id="board"></eh-ttt-board>
        <div id="status" class="status"></div>
      </div>
    `;
    }

    private wire(): void {
        const createBtn = mustEl<HTMLButtonElement>(this, '#createBtn');
        const joinBtn = mustEl<HTMLButtonElement>(this, '#joinBtn');
        const joinInput = mustEl<HTMLInputElement>(this, '#joinInput');
        const leaveBtn = mustEl<HTMLButtonElement>(this, '#leaveBtn');
        const resetBtn = mustEl<HTMLButtonElement>(this, '#resetBtn');

        const copyBtn = mustEl<HTMLButtonElement>(this, '#copyBtn');
        const shareBtn = mustEl<HTMLButtonElement>(this, '#shareBtn');

        const board = mustEl<HTMLElement>(this, '#board');

        createBtn.addEventListener('click', () => void this.onCreate());
        joinBtn.addEventListener('click', () => void this.onJoin(joinInput.value.trim()));
        leaveBtn.addEventListener('click', () => this.onLeave());
        resetBtn.addEventListener('click', () => void this.onReset());

        copyBtn.addEventListener('click', () => void this.onCopySessionId());
        shareBtn.addEventListener('click', () => void this.onShareLink());

        board.addEventListener('cell-click', (e: Event) => {
            const ce = e as CustomEvent<CellClickDetail>;
            void this.onLocalMove(ce.detail.index);
        });
    }

    private updateView(): void {
        const sessionText = mustEl<HTMLSpanElement>(this, '#sessionText');
        const roleText = mustEl<HTMLSpanElement>(this, '#roleText');
        const rtcText = mustEl<HTMLSpanElement>(this, '#rtcText');
        const statusEl = mustEl<HTMLDivElement>(this, '#status');

        const copyBtn = mustEl<HTMLButtonElement>(this, '#copyBtn');
        const shareBtn = mustEl<HTMLButtonElement>(this, '#shareBtn');

        const hasSession = this.ui.sessionId !== NAString.NA;

        sessionText.textContent = hasSession ? this.ui.sessionId : NAString.NA;
        roleText.textContent = this.ui.role === NAString.NA ? NAString.NA : this.ui.role;
        rtcText.textContent = this.ui.rtcStatus;
        statusEl.textContent = this.ui.statusText;

        copyBtn.disabled = !hasSession;
        shareBtn.disabled = !hasSession;

        const board = mustEl<any>(this, '#board');
        board.state = this.ui.game;

        const isConnected = this.ui.rtcStatus === WebRtcSessionStatus.Open;
        const isInProgress = this.ui.game.result === GameResult.InProgress;

        // P2P rules:
        // - Initiator plays X
        // - Responder plays O
        // const myPlayer =
        //     this.ui.role === P2pRole.Initiator ? Player.X :
        //         this.ui.role === P2pRole.Responder ? Player.O :
        //             Player.NA;
        //
        // const canInteract =
        //     isConnected &&
        //     isInProgress &&
        //     myPlayer !== Player.NA &&
        //     this.ui.game.currentPlayer === myPlayer;

        const myPlayer =
            this.ui.role === NAString.NA ? Player.NA : myPlayerFromRole(this.ui.role);

        const canInteract =
            isConnected &&
            isInProgress &&
            myPlayer !== Player.NA &&
            this.ui.game.currentPlayer === myPlayer;

        board.locked = !canInteract;
    }

    private setStatus(text: string): void {
        this.ui = {...this.ui, statusText: text};
        this.updateView();
    }

    /* ======================================================
       Lifecycle
       ====================================================== */

    private cleanup(): void {
        if (this.rtc) {
            this.rtc.close();
            this.rtc = undefined;
        }
        this.signaling.reset();
    }

    private onLeave(): void {
        this.cleanup();
        this.ui = {
            sessionId: NAString.NA,
            role: NAString.NA,
            rtcStatus: WebRtcSessionStatus.Idle,
            statusText: 'Left session.',
            game: emptyState(),
        };
        const joinInput = mustEl<HTMLInputElement>(this, '#joinInput');
        joinInput.value = '';
        this.updateView();
    }

    /* ======================================================
       Create / Join
       ====================================================== */

    private async onCreate(): Promise<void> {
        try {
            this.cleanup();

            const st = await this.signaling.createSession(this.clientId);
            if (st.kind !== SignalingStateKind.Ready) {
                this.setStatus('Signaling not ready.');
                return;
            }

            this.ui = {
                ...this.ui,
                sessionId: st.sessionId,
                role: st.role,
                rtcStatus: WebRtcSessionStatus.Connecting,
                statusText: `Session created. Share this ID: ${st.sessionId}`,
                game: emptyState(),
            };
            this.updateView();

            this.rtc = new WebRtcSession({
                clientId: this.clientId,
                signaling: this.signaling,
                onMessage: (txt) => this.onRemoteMessage(txt),
                onStatus: (s) => {
                    this.ui = {...this.ui, rtcStatus: s};
                    this.updateView();
                },
                onError: (m) => this.setStatus(`WebRTC error: ${m}`),
            });

            await this.rtc.startInitiator();

            // Minimal hello message
            this.rtc.sendJson({type: P2pMsgType.Hello, role: P2pRole.Initiator} satisfies P2pHelloMsg);
        } catch (e) {
            this.setStatus(`Create failed: ${(e as Error).message}`);
        }
    }

    private async onJoin(sessionId: string): Promise<void> {
        if (sessionId.length === 0) {
            this.setStatus('Enter a session id to join.');
            return;
        }

        try {
            this.cleanup();

            const st = await this.signaling.joinSession(sessionId, this.clientId);
            if (st.kind !== SignalingStateKind.Ready) {
                this.setStatus('Signaling not ready.');
                return;
            }

            this.ui = {
                ...this.ui,
                sessionId: st.sessionId,
                role: st.role,
                rtcStatus: WebRtcSessionStatus.Connecting,
                statusText: `Joined session ${st.sessionId}. Establishing WebRTC…`,
                game: emptyState(),
            };
            this.updateView();

            this.rtc = new WebRtcSession({
                clientId: this.clientId,
                signaling: this.signaling,
                onMessage: (txt) => this.onRemoteMessage(txt),
                onStatus: (s) => {
                    this.ui = {...this.ui, rtcStatus: s};
                    this.updateView();
                },
                onError: (m) => this.setStatus(`WebRTC error: ${m}`),
            });

            await this.rtc.startResponder();
        } catch (e) {
            this.setStatus(`Join failed: ${(e as Error).message}`);
        }
    }

    /* ======================================================
       Game actions
       ====================================================== */

    private async onReset(): Promise<void> {
        // local reset + notify peer (only if connected)
        this.ui = {...this.ui, game: emptyState()};
        this.updateView();

        if (this.rtc && this.ui.rtcStatus === WebRtcSessionStatus.Open) {
            this.rtc.sendJson({type: P2pMsgType.Reset} satisfies P2pResetMsg);
        }
    }

    private async onLocalMove(moveIndex: number): Promise<void> {
        if (!this.rtc) return;
        if (this.ui.rtcStatus !== WebRtcSessionStatus.Open) return;
        if (this.ui.role === NAString.NA) return;
        // if (this.ui.game.result !== GameResult.InProgress) return;

        // const myPlayer =
        //     this.ui.role === P2pRole.Initiator ? Player.X :
        //         this.ui.role === P2pRole.Responder ? Player.O :
        //             Player.NA;
        //
        // if (myPlayer === Player.NA) return;
        // if (this.ui.game.currentPlayer !== myPlayer) return;

        // const res = applyMove(this.ui.game, moveIndex);
        // if (res.move === BoardMove.Failed) return;


        const d = applyLocalMove({state: this.ui.game, myRole: this.ui.role, moveIndex});

        if (d.decision === ProtocolDecision.Rejected) {
            if (d.reason === RejectionReason.NotYourTurn) this.setStatus('Not your turn.');
            return;
        }


        this.ui = {...this.ui, game: d.next};
        this.updateView();

        const msg: P2pMoveMsg = makeMoveMsg(moveIndex, d.next);
        this.trySendP2p(msg);
    }

    private onRemoteMessage(text: string): void {
        const parsed = parseP2pMsg(text);
        if (parsed.kind === 'Invalid') {
            this.setStatus('Received invalid P2P message.');
            return;
        }

        const msg = parsed.msg;

        switch (msg.type) {
            case P2pMsgType.Hello:
                // purely informational for now
                this.setStatus(`Peer connected (${msg.role}).`);
                return;

            case P2pMsgType.Reset:
                this.ui = {...this.ui, game: emptyState()};
                this.updateView();
                this.setStatus('Game reset by peer.');
                return;

            case P2pMsgType.Move: {
                if (this.ui.role === NAString.NA) return;
                if (this.ui.game.result !== GameResult.InProgress) return;

                const d = applyRemoteMove({
                    state: this.ui.game,
                    myRole: this.ui.role,
                    moveIndex: msg.moveIndex,
                });

                if (d.decision === ProtocolDecision.Rejected) {
                    this.setStatus('Received an invalid move from peer (ignored).');
                    return;
                }

                this.ui = {...this.ui, game: d.next};
                this.updateView();

                // Divergence detection:
                const localHash = stateHash(d.next);
                if (msg.hash !== localHash) {
                    this.setStatus('State mismatch detected. Requesting resync…');
                    const req: P2pResyncRequestMsg = makeResyncRequestMsg(d.next);
                    this.trySendP2p(req);
                }

                return;
            }

            case P2pMsgType.ResyncRequest: {
                // Peer thinks we diverged. Send our current state as authority (P2P authority).
                const sync: P2pStateSyncMsg = makeStateSyncMsg(this.ui.game);
                const ok = this.trySendP2p(sync);
                this.setStatus(ok ? 'Peer requested resync. Sent current state.' : 'Cannot resync (not connected).');
                return;
            }

            case P2pMsgType.StateSync: {
                const v = validateStateSync(msg);
                if (v.kind === 'Invalid') {
                    this.setStatus('Received invalid StateSync (hash mismatch). Ignored.');
                    return;
                }

                this.ui = {...this.ui, game: v.state};
                this.updateView();
                this.setStatus('State synced with peer.');
                return;
            }
        }
    }

    private trySendP2p(msg: unknown): boolean {
        if (!this.rtc) return false;
        if (this.ui.rtcStatus !== WebRtcSessionStatus.Open) return false;
        this.rtc.sendJson(msg);
        return true;
    }

    /* ======================================================
       Copy / Share
       ====================================================== */

    private async onCopySessionId(): Promise<void> {
        if (this.ui.sessionId === NAString.NA) {
            this.setStatus('No session id to copy.');
            return;
        }
        const ok = await copyToClipboard(this.ui.sessionId);
        this.setStatus(ok ? `Copied session id.` : 'Copy failed.');
    }

    private buildShareUrl(sessionId: string): string {
        const base = `${location.origin}${location.pathname}`;
        const encoded = encodeURIComponent(sessionId);
        // route name: "#/p2p?sessionId=..."
        return `${base}#/p2p?sessionId=${encoded}`;
    }

    private async onShareLink(): Promise<void> {
        if (this.ui.sessionId === NAString.NA) {
            this.setStatus('No session id to share.');
            return;
        }
        const url = this.buildShareUrl(this.ui.sessionId);
        const ok = await copyToClipboard(url);
        this.setStatus(ok ? 'Share link copied to clipboard.' : 'Copy failed.');
    }

    private prefillFromShareLink(): void {
        const joinInput = mustEl<HTMLInputElement>(this, '#joinInput');
        const id = readSessionIdFromHash();
        if (id.length > 0) {
            joinInput.value = id;
            this.setStatus('Session ID prefilled from share link. Click Join.');
        }
    }
}

customElements.define('eh-p2p-multi-screen', EhP2pMultiScreen);