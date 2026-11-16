import type { Mesh } from '@babylonjs/core/Meshes/mesh';

import { CutoutActor } from '../cutout-actor.ts';
import { CutoutArt } from '../cutout-art.ts';
import { PracticeControls, requirePracticeElement } from '../practice-controls.ts';
import { PracticeScene } from '../practice-scene.ts';
import { createTownIce } from '../town/raid-presentation.ts';
import type { TownMatchSession } from './match-session.ts';
import { TOWN_MATCH_RATE, type TownMatchState } from './town-match.ts';

interface TownMatchPeer {
    readonly actor: CutoutActor;
    readonly ice: Mesh;
}

/** The online canvas displays committed match state; it never advances the simulation. */
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
    private renderedZoom = 0;

    private readonly root: HTMLElement;
    private readonly session: TownMatchSession;

    constructor(root: HTMLElement, session: TownMatchSession, onLeave: () => void) {
        this.root = root;
        root.style.position = 'fixed';
        root.style.inset = '0';
        root.style.visibility = 'hidden';
        root.style.pointerEvents = 'none';
        root.setAttribute('aria-hidden', 'true');
        this.session = session;
        root.innerHTML = `<main class="practice" aria-label="Online Grumpy Town">
          <canvas aria-label="Shared town playfield"></canvas>
          <header class="hud"><div class="brand"><span>CCA / PLAYING WITH FRIENDS</span><h1>GRUMPY TOWN</h1></div><button id="leave-round">Leave town</button></header>
          <div class="scoreboard"><span id="round-clock"></span><span id="round-score"></span></div>
          <div class="zoom" role="group" aria-label="Camera zoom"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button></div>
          <div class="play-hint"><span class="you">YOU / TEAL HOODIE</span><p id="round-status" role="status"></p></div>
          <div class="controls"><div class="stick-wrap"><div id="joystick" aria-label="Movement joystick"><div id="puck"></div></div><span>MOVE</span></div><button id="dash" aria-label="Dash and drop"><strong>DASH<br>+ DROP</strong></button></div>
          <section id="round-results" class="pause-overlay" hidden><div><h2>Round complete</h2><p id="round-winners"></p><button id="rematch">New round</button><button id="leave-results">Leave match</button></div></section>
        </main>`;
        const canvas = requirePracticeElement<HTMLCanvasElement>(root, 'canvas');
        this.scene = new PracticeScene(canvas);
        this.art = new CutoutArt(this.scene.scene);
        this.canvas = canvas;
        const options = { signal: this.lifetime.signal };
        requirePracticeElement(root, '#leave-round').addEventListener('click', onLeave, options);
        requirePracticeElement(root, '#leave-results').addEventListener('click', onLeave, options);
        requirePracticeElement(root, '#rematch').addEventListener('click', () => {
            void session.act({ kind: 'rematch', nextMatchId: crypto.randomUUID() });
        }, options);
        window.addEventListener('resize', () => this.resize(), options);
        window.addEventListener('blur', () => this.clearControls(), options);
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
        this.controls?.clear();
        this.publishControls();
    }

    private publishControls(): void {
        const controls = this.controls?.getInput();
        if (controls) {
            this.session.setControls(controls);
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
        const player = match?.players.find((player) => player.id === view.localId) ?? match?.players[0];
        if (!match || !player) {
            return;
        }
        const now = performance.now();
        const seconds = Math.min(0.05, (now - this.previousTime) / 1000);
        this.previousTime = now;
        if (this.visible) {
            this.publishControls();
        }
        const zoom = this.controls?.getZoom() ?? 13;
        if (
            match.phase === 'playing' || !this.prepared || this.renderedMatchId !== match.matchId ||
            this.renderedZoom !== zoom
        ) {
            this.renderPeers(view);
            this.scene.render({
                state: { ...player, town: match.town },
                zoom,
                seconds,
                reducedMotion: match.phase !== 'playing'
            });
            this.prepared = this.scene.scene.isReady();
            if (this.prepared) {
                this.preparedKey = preparationKey;
            }
            this.renderedMatchId = match.matchId;
            this.renderedZoom = zoom;
        }
        this.updateHud(view);
    }

    private updateHud(view: TownMatchSession.View): void {
        const match = view.match;
        const player = match?.players.find((player) => player.id === view.localId) ?? match?.players[0];
        if (!match || !player) {
            return;
        }
        this.root.dataset.phase = match.phase;
        this.root.dataset.x = String(player.x);
        this.root.dataset.speed = String(Math.hypot(player.vx, player.vz));
        this.root.dataset.peerX = String(match.players.find((peer) => peer.id !== player.id)?.x ?? 0);
        this.root.dataset.dashes = String(player.consumedDash);
        requirePracticeElement(this.root, '#round-clock').textContent = `${
            Math.ceil(match.remainingTicks / TOWN_MATCH_RATE)
        }s`;
        requirePracticeElement(this.root, '#round-score').textContent = `${player.score} / 100 POINTS`;
        requirePracticeElement(this.root, '#round-status').textContent = !view.available
            ? 'Connection paused. Waiting for the director…'
            : match.phase === 'countdown'
            ? `Ready… ${Math.ceil(match.countdownTicks / TOWN_MATCH_RATE)}`
            : player.frozenUntil > player.elapsed
            ? `FROZEN ${Math.ceil(player.frozenUntil - player.elapsed)}s — a friend can rescue you!`
            : `Dash to make trouble. ${match.players.length} friends in town.`;
    }

    private renderResults(view: TownMatchSession.View): void {
        const match = view.match;
        const finished = match?.phase === 'finished' || match?.phase === 'interrupted';
        requirePracticeElement(this.root, '#round-results').hidden = !finished;
        requirePracticeElement(this.root, '#rematch').hidden = !view.isDirector;
        requirePracticeElement(this.root, '#round-winners').textContent = match?.interruption ??
            match?.results.map((result) =>
                `${result.displayName}: ${result.score}${result.qualified ? ' — WINNER!' : ''}`
            ).join(' · ') ?? '';
    }

    private renderPeers(view: TownMatchSession.View): void {
        const players = view.match?.players.filter((player) => player.id !== view.localId) ?? [];
        for (const [id, peer] of this.peers) {
            if (!players.some((player) => player.id === id)) {
                peer.actor.root.dispose();
                peer.ice.dispose();
                this.peers.delete(id);
            }
            else {
                peer.ice.setEnabled(false);
            }
        }
        for (const player of players) {
            let peer = this.peers.get(player.id);
            if (!peer) {
                const actor = new CutoutActor({
                    scene: this.scene.scene,
                    art: this.art,
                    color: ['#bd7047', '#7a659b', '#b1a445'][this.peers.size % 3],
                    guard: false
                });
                peer = { actor, ice: createTownIce(this.scene.scene, this.art) };
                this.peers.set(player.id, peer);
            }
            peer.ice.setEnabled(player.frozenUntil > player.elapsed);
            peer.ice.position.set(player.x, 1, player.z - 0.3);
            peer.actor.render({
                x: player.x,
                z: player.z,
                time: player.frozenUntil > player.elapsed ? 0 : player.elapsed,
                moving: player.frozenUntil <= player.elapsed && Math.hypot(player.vx, player.vz) > 0.2,
                slipping: player.slipping,
                facing: player.facingX,
                angry: false,
                dizzy: player.dizzyUntil > player.elapsed,
                puking: player.sickAt >= 0 && player.elapsed >= player.sickAt && player.elapsed < player.sickAt + 1,
                mini: false,
                working: false,
                stain: player.stain
            });
        }
    }
}

function toPreparationKey(match: TownMatchState | undefined): string {
    return JSON.stringify([match?.matchId, match?.members.map((member) => [member.id, member.sessionId])]);
}
