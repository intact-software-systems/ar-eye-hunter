import { requirePracticeElement } from '../../practice-controls.ts';
import type { PracticePlayer } from '../../practice-rules.ts';
import type { TownMatchSession } from '../town-match-session.ts';
import { TOWN_MATCH_RATE, type TownMatchPlayer, type TownMatchState } from '../town-match.ts';

export const TOWN_MATCH_MARKUP = `<main class="practice" aria-label="Online Grumpy Town">
          <canvas aria-label="Shared town playfield"></canvas>
          <header class="hud"><div class="brand"><span>CCA / PLAYING WITH FRIENDS</span><h1>GRUMPY TOWN</h1></div><button id="ready-next" hidden>Ready for next round</button><button id="extend-round" hidden>Extend by 1 minute</button><button id="leave-round">Leave town</button></header>
          <div class="scoreboard"><span id="round-clock"></span><span id="round-score"></span></div>
          <div class="zoom" role="group" aria-label="Camera zoom"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button></div>
          <div class="play-hint"><span class="you">YOU</span><p id="round-status" role="status"></p></div>
          <div class="controls"><div class="stick-wrap"><div id="joystick" aria-label="Movement joystick"><div id="puck"></div></div><span>MOVE</span></div><button id="dash" aria-label="Dash and drop"><strong>DASH<br>+ DROP</strong></button></div>
          <section id="round-results" class="pause-overlay" hidden><div><h2 id="round-result-title">Round complete</h2><p id="round-winners"></p><button id="rematch">New round</button><button id="leave-results">Leave match</button><button id="solo-results">Back to solo</button></div></section>
        </main>`;

const TOWN_PLAYER_APPEARANCES = [
    { color: '#347d79', label: 'TEAL HOODIE' },
    { color: '#bd7047', label: 'COPPER HOODIE' },
    { color: '#7a659b', label: 'PURPLE HOODIE' },
    { color: '#b1a445', label: 'MUSTARD HOODIE' }
] as const;

export function renderTownMatchHud(root: HTMLElement, view: TownMatchSession.View, shown: PracticePlayer): void {
    const match = view.match;
    const player = match?.players.find((player) => player.id === view.localId) ?? match?.players[0];
    if (!match || !player) {
        return;
    }
    root.dataset.phase = match.phase;
    root.dataset.matchId = match.matchId;
    root.dataset.tick = String(match.tick);
    root.dataset.director = String(view.isDirector);
    root.dataset.seat = match.seats.find((seat) => seat.id === view.localId)?.status ?? 'observer';
    root.dataset.x = String(player.x);
    root.dataset.speed = String(Math.hypot(player.vx, player.vz));
    root.dataset.peerX = String(
        match.players.find((peer) =>
            peer.id !== player.id && match.seats.some((seat) => seat.id === peer.id && seat.status === 'active')
        )
            ?.x ?? 0
    );
    root.dataset.dashes = String(player.consumedDash);
    root.dataset.pranks = String(player.pranks);
    root.dataset.playerColor = resolveTownMatchAppearance(match, player.id).color;
    root.dataset.poseTransport = view.livePoses?.transport ?? 'checkpoint';
    root.dataset.liveSend = view.liveSend;
    root.dataset.inputTransport = view.inputTransport;
    root.dataset.poseTick = String(view.livePoses?.tick ?? match.tick);
    requirePracticeElement(root, '#round-clock').textContent = `${Math.ceil(match.remainingTicks / TOWN_MATCH_RATE)}s`;
    requirePracticeElement(root, '#round-score').textContent = `${player.score} / 100 POINTS`;
    requirePracticeElement(root, '#leave-round').textContent = view.recovering ? 'Back to solo' : 'Leave town';
    const dash = requirePracticeElement<HTMLButtonElement>(root, '#dash');
    const frozen = player.frozenUntil > player.elapsed;
    const cooldown = Math.max(
        shown.cooldown,
        view.livePoses?.players.find((pose) => pose.id === view.localId)?.cooldown ?? player.cooldown
    );
    dash.disabled = view.recovering || view.observing || frozen || cooldown > 0;
    requirePracticeElement(dash, 'strong').textContent = frozen ? 'FROZEN' : cooldown > 0
        ? `WAIT ${cooldown.toFixed(1)}s`
        : 'DASH+ DROP';
    requirePracticeElement(root, '.controls').style.display = view.observing ? 'none' : '';
    requirePracticeElement(root, '.you').textContent = view.observing
        ? 'WATCHING THE TOWN'
        : `YOU / ${resolveTownMatchAppearance(match, player.id).label}`;
    requirePracticeElement(root, '#round-status').textContent = toRoundStatus(view, match, player);
}

function toRoundStatus(view: TownMatchSession.View, match: TownMatchState, player: TownMatchPlayer): string {
    return view.recovering
        ? 'Connection paused. Waiting for confirmed match state…'
        : view.observing
        ? 'Watching until the next round. Your confirmed points are preserved.'
        : match.phase === 'countdown'
        ? `Ready… ${Math.ceil(match.countdownTicks / TOWN_MATCH_RATE)}`
        : player.frozenUntil > player.elapsed
        ? `FROZEN ${Math.ceil(player.frozenUntil - player.elapsed)}s — a friend can rescue you!`
        : `Dash to make trouble. ${match.seats.filter((seat) => seat.status === 'active').length} friends in town. ${
            view.isDirector ? 'You host this round.' : ''
        }`;
}

/** Retained participants keep the same colors across views, disconnections and host changes. */
export function resolveTownMatchAppearance(
    match: TownMatchState,
    playerId: string
): typeof TOWN_PLAYER_APPEARANCES[number] {
    const index = match.participants.findIndex((participant) => participant.id === playerId);
    return TOWN_PLAYER_APPEARANCES[index] ?? TOWN_PLAYER_APPEARANCES[0];
}
