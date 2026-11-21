import { TOWN_MATCH_MAX_TICKS } from './match-extension.ts';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

import { CutoutActor } from '../cutout-actor.ts';
import { CutoutArt } from '../cutout-art.ts';
import { PracticeControls, requirePracticeElement } from '../practice-controls.ts';
import type { PracticeInput, PracticePlayer } from '../practice-rules.ts';
import { PracticeScene } from '../practice-scene.ts';
import { createTownIce } from '../town/raid-presentation.ts';
import { TownMatchControls } from './match-controls.ts';
import { TownMatchPeerPresentation } from './match-peer-presentation.ts';
import { TownMatchPresentation } from './match-presentation.ts';
import type { TownMatchSession } from './match-session.ts';
import { TOWN_MATCH_RATE, type TownMatchPlayer, type TownMatchState } from './town-match.ts';

const TOWN_PLAYER_APPEARANCES = [
    { color: '#347d79', label: 'TEAL HOODIE' },
    { color: '#bd7047', label: 'COPPER HOODIE' },
    { color: '#7a659b', label: 'PURPLE HOODIE' },
    { color: '#b1a445', label: 'MUSTARD HOODIE' }
] as const;

interface TownMatchPeer {
    readonly actor: CutoutActor;
    readonly ice: Mesh;
    readonly presentation: TownMatchPeerPresentation;
}

export namespace TownMatchGame {
    export interface Input {
        readonly root: HTMLElement;
        readonly session: TownMatchSession;
        readonly onLeave: () => void;
        readonly onSolo: () => void;
    }
}

/** Renders confirmed world state with bounded local movement prediction; never writes match truth. */
export class TownMatchGame {
    private readonly scene: PracticeScene;
    private controls: PracticeControls | undefined;
    private readonly canvas: HTMLCanvasElement;
    private readonly peers = new Map<string, TownMatchPeer>();
    private readonly art: CutoutArt;
    private readonly lifetime = new AbortController();
    private previousTime = performance.now();
    private stopped = false;
    private visible = false;
    private prepared = false;
    private preparedKey = '';
    private error = '';
    private renderedMatchId = '';
    private renderedPhase: TownMatchState['phase'] | undefined;
    private renderedZoom = 0;
    private matchControls = new TownMatchControls();
    private presentation = new TownMatchPresentation();
    private inputGeneration = -1;

    private readonly root: HTMLElement;
    private readonly session: TownMatchSession;

    constructor(input: TownMatchGame.Input) {
        const { root, session, onLeave, onSolo } = input;
        this.root = root;
        root.style.position = 'fixed';
        root.style.inset = '0';
        root.style.visibility = 'hidden';
        root.style.pointerEvents = 'none';
        root.setAttribute('aria-hidden', 'true');
        this.session = session;
        root.innerHTML = `<main class="practice" aria-label="Online Grumpy Town">
          <canvas aria-label="Shared town playfield"></canvas>
          <header class="hud"><div class="brand"><span>CCA / PLAYING WITH FRIENDS</span><h1>GRUMPY TOWN</h1></div><button id="extend-round" hidden>Extend by 1 minute</button><button id="leave-round">Leave town</button></header>
          <div class="scoreboard"><span id="round-clock"></span><span id="round-score"></span></div>
          <div class="zoom" role="group" aria-label="Camera zoom"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button></div>
          <div class="play-hint"><span class="you">YOU</span><p id="round-status" role="status"></p></div>
          <div class="controls"><div class="stick-wrap"><div id="joystick" aria-label="Movement joystick"><div id="puck"></div></div><span>MOVE</span></div><button id="dash" aria-label="Dash and drop"><strong>DASH<br>+ DROP</strong></button></div>
          <section id="round-results" class="pause-overlay" hidden><div><h2 id="round-result-title">Round complete</h2><p id="round-winners"></p><button id="rematch">New round</button><button id="leave-results">Leave match</button><button id="solo-results">Back to solo</button></div></section>
        </main>`;
        const canvas = requirePracticeElement<HTMLCanvasElement>(root, 'canvas');
        this.scene = new PracticeScene(canvas);
        this.art = new CutoutArt(this.scene.scene);
        this.canvas = canvas;
        const options = { signal: this.lifetime.signal };
        requirePracticeElement(root, '#leave-round').addEventListener('click', () => {
            if (session.getView().recovering) {
                onSolo();
            }
            else {
                onLeave();
            }
        }, options);
        requirePracticeElement(root, '#leave-results').addEventListener('click', onLeave, options);
        requirePracticeElement(root, '#solo-results').addEventListener('click', onSolo, options);
        requirePracticeElement(root, '#extend-round').addEventListener('click', () => {
            const match = session.getView().match;
            if (match) {
                void session.act({ kind: 'extend', expectedDurationTicks: match.tick + match.remainingTicks });
            }
        });
        requirePracticeElement(root, '#rematch').addEventListener('click', () => {
            void session.act({ kind: 'rematch', nextMatchId: crypto.randomUUID() });
        }, options);
        window.addEventListener('resize', () => this.resize(), options);
        window.addEventListener('blur', () => this.clearControls(), options);
        window.addEventListener('keydown', (event) => this.admitControlKey(event), { ...options, capture: true });
        window.addEventListener('keyup', (event) => this.matchControls.releaseKey(event.code), options);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.clearControls();
            }
        }, options);
        canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            this.showContextLoss(onLeave);
        }, options);
        this.scene.engine.runRenderLoop(() => this.frame());
    }

    isReady(): boolean {
        return !this.stopped && this.prepared && this.preparedKey === toPreparationKey(this.session.getView().match);
    }

    getError(): string {
        return this.error;
    }

    setVisible(visible: boolean): void {
        if (this.visible === visible) {
            return;
        }
        this.visible = visible;
        this.root.style.visibility = visible ? 'visible' : 'hidden';
        this.root.style.pointerEvents = visible ? 'auto' : 'none';
        this.root.setAttribute('aria-hidden', String(!visible));
        if (this.stopped) {
            return;
        }
        this.clearControls();
        this.controls?.stop();
        this.controls = visible ? new PracticeControls(this.root, this.canvas) : undefined;
        this.matchControls = new TownMatchControls();
        if (visible) {
            this.resize();
            this.previousTime = performance.now();
        }
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.lifetime.abort();
        this.session.setControls({ x: 0, z: 0, dash: this.controls?.getInput().dash ?? 0 });
        this.controls?.stop();
        this.controls = undefined;
        this.scene.stop();
    }

    private resize(): void {
        if (!this.stopped) {
            this.scene.resize();
            this.prepared = false;
        }
    }

    private showContextLoss(onLeave: () => void): void {
        this.error = 'Graphics context lost. Leave town and rejoin.';
        void this.session.act({ kind: 'ready', ready: false });
        this.stop();
        this.root.innerHTML =
            '<main class="loading"><h1>The market needs to reopen.</h1><p>Your browser released the graphics context.</p><button id="leave-lost-scene">Leave town</button></main>';
        requirePracticeElement(this.root, '#leave-lost-scene').onclick = onLeave;
    }

    private clearControls(): void {
        this.presentation = new TownMatchPresentation();
        this.matchControls.clearKeys();
        this.controls?.clear();
        this.publishControls();
    }

    private publishControls(): PracticeInput {
        const view = this.session.getView();
        const blocked = view.recovering || view.observing;
        const consumed = view.match?.players.find((player) => player.id === view.localId)?.consumedDash ?? 0;
        const idle = { x: 0, z: 0, dash: consumed };
        if (blocked) {
            this.controls?.clear();
        }
        const controls = this.controls?.getInput();
        if (controls) {
            if (this.inputGeneration !== view.inputGeneration) {
                this.controls?.clear();
                this.matchControls.rebase(controls, consumed);
                this.inputGeneration = view.inputGeneration;
                this.session.setControls(idle);
                return idle;
            }
            const sampled = this.matchControls.sample(controls, consumed, blocked);
            this.session.setControls(sampled);
            return sampled;
        }
        return idle;
    }

    private admitControlKey(event: KeyboardEvent): void {
        const view = this.session.getView();
        if (
            this.visible &&
            !this.matchControls.acceptKeyDown(event.code, event.repeat, view.recovering || view.observing)
        ) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    private frame(): void {
        const view = this.session.getView();
        const match = view.match;
        const preparationKey = toPreparationKey(match);
        if (this.preparedKey !== preparationKey) {
            this.prepared = false;
        }
        if (!this.visible && this.prepared) {
            return;
        }
        this.renderResults(view);
        const player = resolveTownMatchViewPlayer(view);
        if (!match || !player) {
            return;
        }
        const now = performance.now();
        const seconds = Math.min(0.05, (now - this.previousTime) / 1000);
        this.previousTime = now;
        const controls = this.visible ? this.publishControls() : { x: 0, z: 0, dash: player.consumedDash };
        const shown = this.presentation.advance({
            player,
            livePose: view.livePoses?.players.find((pose) => pose.id === view.localId),
            town: match.town,
            matchId: match.matchId,
            inputGeneration: view.inputGeneration,
            enabled: this.visible && !document.hidden && match.phase === 'playing' && view.available &&
                !view.recovering && !view.observing,
            controls,
            seconds
        });
        const zoom = this.controls?.getZoom() ?? 13;
        if (
            match.phase === 'playing' || !this.prepared || this.renderedMatchId !== match.matchId ||
            this.renderedZoom !== zoom || this.renderedPhase !== match.phase
        ) {
            this.scene.updatePlayerColor(resolveTownMatchAppearance(match, player.id).color);
            this.renderPeers(view, performance.timeOrigin + now);
            this.scene.render({
                state: { ...shown, town: match.town },
                zoom,
                seconds,
                reducedMotion: match.phase !== 'playing'
            });
            this.prepared = this.scene.scene.isReady();
            if (this.prepared) {
                this.preparedKey = preparationKey;
            }
            this.renderedMatchId = match.matchId;
            this.renderedPhase = match.phase;
            this.renderedZoom = zoom;
            this.root.dataset.renderX = String(shown.x);
            this.root.dataset.renderDashes = String(shown.consumedDash);
            this.root.dataset.renderPranks = String(shown.pranks);
        }
        this.updateHud(view, shown);
    }

    private updateHud(view: TownMatchSession.View, shown: PracticePlayer): void {
        const match = view.match;
        const player = match?.players.find((player) => player.id === view.localId) ?? match?.players[0];
        if (!match || !player) {
            return;
        }
        this.root.dataset.phase = match.phase;
        this.root.dataset.matchId = match.matchId;
        this.root.dataset.tick = String(match.tick);
        this.root.dataset.director = String(view.isDirector);
        this.root.dataset.seat = match.seats.find((seat) => seat.id === view.localId)?.status ?? 'observer';
        this.root.dataset.x = String(player.x);
        this.root.dataset.speed = String(Math.hypot(player.vx, player.vz));
        this.root.dataset.peerX = String(
            match.players.find((peer) =>
                peer.id !== player.id && match.seats.some((seat) => seat.id === peer.id && seat.status === 'active')
            )
                ?.x ?? 0
        );
        this.root.dataset.dashes = String(player.consumedDash);
        this.root.dataset.pranks = String(player.pranks);
        this.root.dataset.playerColor = resolveTownMatchAppearance(match, player.id).color;
        this.root.dataset.poseTransport = view.livePoses?.transport ?? 'checkpoint';
        this.root.dataset.liveSend = view.liveSend;
        this.root.dataset.inputTransport = view.inputTransport;
        this.root.dataset.poseTick = String(view.livePoses?.tick ?? match.tick);
        requirePracticeElement(this.root, '#round-clock').textContent = `${
            Math.ceil(match.remainingTicks / TOWN_MATCH_RATE)
        }s`;
        requirePracticeElement(this.root, '#round-score').textContent = `${player.score} / 100 POINTS`;
        requirePracticeElement(this.root, '#leave-round').textContent = view.recovering ? 'Back to solo' : 'Leave town';
        const dash = requirePracticeElement<HTMLButtonElement>(this.root, '#dash');
        const frozen = player.frozenUntil > player.elapsed;
        const cooldown = Math.max(
            shown.cooldown,
            view.livePoses?.players.find((pose) => pose.id === view.localId)?.cooldown ?? player.cooldown
        );
        dash.disabled = view.recovering || view.observing || frozen || cooldown > 0;
        requirePracticeElement(dash, 'strong').textContent = frozen ? 'FROZEN' : cooldown > 0
            ? `WAIT ${cooldown.toFixed(1)}s`
            : 'DASH+ DROP';
        requirePracticeElement(this.root, '.controls').style.display = view.observing ? 'none' : '';
        requirePracticeElement(this.root, '.you').textContent = view.observing
            ? 'WATCHING THE TOWN'
            : `YOU / ${resolveTownMatchAppearance(match, player.id).label}`;
        requirePracticeElement(this.root, '#round-status').textContent = view.recovering
            ? 'Connection paused. Waiting for confirmed match state…'
            : view.observing
            ? 'Watching until the next round. Your confirmed points are preserved.'
            : match.phase === 'countdown'
            ? `Ready… ${Math.ceil(match.countdownTicks / TOWN_MATCH_RATE)}`
            : player.frozenUntil > player.elapsed
            ? `FROZEN ${Math.ceil(player.frozenUntil - player.elapsed)}s — a friend can rescue you!`
            : `Dash to make trouble. ${
                match.seats.filter((seat) => seat.status === 'active').length
            } friends in town. ${view.isDirector ? 'You host this round.' : ''}`;
    }

    private renderResults(view: TownMatchSession.View): void {
        const match = view.match;
        const interrupted = Boolean(view.interruption) || match?.phase === 'interrupted';
        const finished = match?.phase === 'finished' || interrupted;
        const extend = requirePracticeElement<HTMLButtonElement>(this.root, '#extend-round');
        extend.hidden = !view.isDirector || match?.phase !== 'playing';
        extend.disabled = !view.available || view.recovering || !match ||
            match.tick + match.remainingTicks >= TOWN_MATCH_MAX_TICKS;
        requirePracticeElement(this.root, '#leave-round').hidden = finished;
        requirePracticeElement(this.root, '#round-results').hidden = !finished;
        requirePracticeElement(this.root, '#round-result-title').textContent = interrupted
            ? 'Round interrupted'
            : 'Round complete';
        requirePracticeElement(this.root, '#rematch').hidden = !view.isDirector;
        requirePracticeElement<HTMLButtonElement>(this.root, '#rematch').disabled = !view.available ||
            (match?.phase !== 'interrupted' && match?.phase !== 'finished');
        requirePracticeElement<HTMLButtonElement>(this.root, '#leave-results').disabled = !view.available;
        const points = match?.participants.map((participant) =>
            `${participant.displayName}: ${match.players.find((player) => player.id === participant.id)?.score ?? 0}`
        ).join(' · ');
        requirePracticeElement(this.root, '#round-winners').textContent = interrupted
            ? `${view.interruption ?? match?.interruption} Confirmed points: ${points}`
            : match?.results.map((result) =>
                `${result.displayName}: ${result.score}${result.qualified ? ' — WINNER!' : ''}`
            ).join(' · ') ?? '';
    }

    private renderPeers(view: TownMatchSession.View, nowEpochMs: number): void {
        const focus = resolveTownMatchViewPlayer(view);
        const players = view.match?.players.filter((player) =>
            player.id !== focus?.id &&
            view.match?.seats.some((seat) => seat.id === player.id && seat.status === 'active')
        ) ?? [];
        this.removeAbsentPeers(players);
        for (const player of players) {
            let peer = this.peers.get(player.id);
            if (!peer) {
                const actor = new CutoutActor({
                    scene: this.scene.scene,
                    art: this.art,
                    color: resolveTownMatchAppearance(view.match!, player.id).color,
                    guard: false
                });
                peer = {
                    actor,
                    ice: createTownIce(this.scene.scene, this.art),
                    presentation: new TownMatchPeerPresentation()
                };
                this.peers.set(player.id, peer);
            }
            peer.actor.updateColor(resolveTownMatchAppearance(view.match!, player.id).color);
            const live = view.livePoses?.players.find((pose) => pose.id === player.id);
            const source = live && player.frozenUntil <= player.elapsed ? { ...player, ...live } : player;
            const pose = peer.presentation.advance({
                player: source,
                town: view.match!.town,
                matchId: view.match!.matchId,
                tick: live ? view.livePoses!.tick : view.match!.tick,
                inputGeneration: view.inputGeneration,
                enabled: this.visible && !document.hidden && view.match!.phase === 'playing' &&
                    view.available && !view.recovering,
                nowEpochMs
            });
            if (player === players[0]) {
                this.root.dataset.renderPeerX = String(pose.x);
                this.root.dataset.peerColor = resolveTownMatchAppearance(view.match!, player.id).color;
            }
            peer.ice.setEnabled(player.frozenUntil > player.elapsed);
            peer.ice.position.set(pose.x, 1, pose.z - 0.3);
            peer.actor.render({
                x: pose.x,
                z: pose.z,
                time: player.frozenUntil > player.elapsed ? 0 : pose.animationTime,
                moving: player.frozenUntil <= player.elapsed && Math.hypot(source.vx, source.vz) > 0.2,
                slipping: player.slipping,
                facing: Math.abs(source.vx) > 0.05 ? Math.sign(source.vx) : player.facingX,
                angry: false,
                dizzy: player.dizzyUntil > player.elapsed,
                puking: player.sickAt >= 0 && player.elapsed >= player.sickAt && player.elapsed < player.sickAt + 1,
                mini: false,
                working: false,
                stain: player.stain
            });
        }
    }

    private removeAbsentPeers(players: readonly TownMatchPlayer[]): void {
        if (players.length === 0) {
            delete this.root.dataset.renderPeerX;
            delete this.root.dataset.peerColor;
        }
        for (const [id, peer] of this.peers) {
            if (!players.some((player) => player.id === id)) {
                peer.actor.root.dispose();
                peer.ice.dispose();
                this.peers.delete(id);
            }
        }
    }
}

function resolveTownMatchViewPlayer(view: TownMatchSession.View): TownMatchPlayer | undefined {
    const match = view.match;
    const active = match?.players.filter((player) =>
        match.seats.some((seat) => seat.id === player.id && seat.status === 'active')
    );
    return active?.find((player) => player.id === view.localId) ?? active?.[0] ?? match?.players[0];
}

function toPreparationKey(match: TownMatchState | undefined): string {
    return JSON.stringify([match?.matchId, match?.members.map((member) => [member.id, member.sessionId])]);
}

/** Retained participants keep the same colors across views, disconnections and host changes. */
function resolveTownMatchAppearance(match: TownMatchState, playerId: string): typeof TOWN_PLAYER_APPEARANCES[number] {
    const index = match.participants.findIndex((participant) => participant.id === playerId);
    return TOWN_PLAYER_APPEARANCES[index] ?? TOWN_PLAYER_APPEARANCES[0];
}
