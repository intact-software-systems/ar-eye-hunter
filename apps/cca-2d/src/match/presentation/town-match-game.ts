import { PracticeControls, requirePracticeElement } from '../../practice-controls.ts';
import type { PracticeInput } from '../../practice-rules.ts';
import { PracticeScene } from '../../practice-scene.ts';
import type { TownMatchSession } from '../town-match-session.ts';
import type { TownMatchPlayer, TownMatchState } from '../town-match.ts';
import { TownMatchControls } from './town-match-controls.ts';
import {
    renderTownMatchHud,
    renderTownMatchResults,
    resolveTownMatchAppearance,
    TOWN_MATCH_MARKUP
} from './town-match-hud.ts';
import { TownMatchPeerActors } from './town-match-peer-actors.ts';
import { TownMatchPresentation } from './town-match-presentation.ts';

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
    private readonly peers: TownMatchPeerActors;
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
        root.innerHTML = TOWN_MATCH_MARKUP;
        const canvas = requirePracticeElement<HTMLCanvasElement>(root, 'canvas');
        this.scene = new PracticeScene(canvas);
        this.peers = new TownMatchPeerActors(root, this.scene.scene);
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
        requirePracticeElement(root, '#ready-next').addEventListener('click', () => {
            void session.act({ kind: 'ready', ready: true });
        }, options);
        requirePracticeElement(root, '#extend-round').addEventListener('click', () => {
            const match = session.getView().match;
            if (match) {
                void session.act({ kind: 'extend', expectedDurationTicks: match.tick + match.remainingTicks });
            }
        }, options);
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
        renderTownMatchResults(this.root, view);
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
            this.peers.render(view, match, player, this.visible, performance.timeOrigin + now);
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
        renderTownMatchHud(this.root, view, shown);
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
