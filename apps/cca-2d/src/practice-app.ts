import { PracticeControls, requirePracticeElement } from './practice-controls.ts';
import { computePracticeTick, createPracticeState } from './practice-rules.ts';
import { PracticeScene } from './practice-scene.ts';

export class PracticeApp {
    private readonly lifetime = new AbortController();
    private readonly root: HTMLElement;
    private readonly controls: PracticeControls;
    private readonly scene: PracticeScene;
    private readonly status: HTMLElement;
    private readonly pranks: HTMLElement;
    private readonly slips: HTMLElement;
    private readonly loading: HTMLElement;
    private previousDashLabel = '';
    private readonly dash: HTMLButtonElement;
    private readonly pause: HTMLButtonElement;
    private readonly overlay: HTMLElement;
    private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    private state = createPracticeState();
    private previousTime = performance.now();
    private accumulator = 0;
    private paused = false;
    private stopped = false;

    constructor(root: HTMLElement) {
        this.root = root;
        root.innerHTML = createPracticeMarkup();
        const canvas = requirePracticeElement<HTMLCanvasElement>(root, 'canvas');
        this.scene = new PracticeScene(canvas);
        this.controls = new PracticeControls(root, canvas);
        this.status = requirePracticeElement(root, '#status');
        this.pranks = requirePracticeElement(root, '#pranks');
        this.slips = requirePracticeElement(root, '#slips');
        this.loading = requirePracticeElement(root, '#scene-loading');
        this.dash = requirePracticeElement(root, '#dash');
        this.pause = requirePracticeElement(root, '#pause');
        this.overlay = requirePracticeElement(root, '#pause-overlay');
        this.bindLifecycle(canvas);
        this.scene.engine.runRenderLoop(() => this.frame());
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.lifetime.abort();
        this.controls.stop();
        this.scene.stop();
    }

    private bindLifecycle(canvas: HTMLCanvasElement): void {
        const options = { signal: this.lifetime.signal };
        this.pause.addEventListener('click', () => this.setPaused(!this.paused), options);
        requirePracticeElement(this.root, '#resume').addEventListener('click', () => this.setPaused(false), options);
        requirePracticeElement(this.root, '#reset').addEventListener('click', () => {
            this.state = { ...createPracticeState(), consumedDash: this.controls.getInput().dash };
            this.setPaused(false);
        }, options);
        window.addEventListener('resize', () => this.scene.resize(), options);
        window.addEventListener('blur', () => this.setPaused(true), options);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.setPaused(true);
            }
        }, options);
        canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            this.stop();
            this.root.innerHTML =
                '<main class="loading"><h1>The market took a break.</h1><p>Your browser released the graphics context.</p><a href="">Reopen market</a></main>';
        }, options);
    }

    private setPaused(paused: boolean): void {
        this.controls.clear();
        this.state = { ...this.state, consumedDash: this.controls.getInput().dash };
        this.paused = paused;
        this.accumulator = 0;
        this.previousTime = performance.now();
        this.pause.textContent = paused ? 'Resume' : 'Pause';
        this.overlay.hidden = !paused;
        this.root.dataset.paused = String(paused);
    }

    private frame(): void {
        const now = performance.now();
        const seconds = Math.min(0.05, (now - this.previousTime) / 1000);
        this.previousTime = now;
        if (!this.paused) {
            this.accumulator += seconds;
            while (this.accumulator >= 1 / 60) {
                this.state = computePracticeTick(this.state, this.controls.getInput(), 1 / 60);
                this.accumulator -= 1 / 60;
            }
        }
        this.scene.render(this.state, this.controls.getZoom(), seconds, this.reducedMotion.matches);
        this.updateHud();
    }

    private updateHud(): void {
        const state = this.state;
        this.pranks.textContent = String(state.pranks);
        this.slips.textContent = String(state.slips);
        this.loading.hidden = this.scene.scene.isReady();
        this.status.textContent = state.slipping
            ? 'ICE! Let go to feel the slide.'
            : state.dashTime > 0
            ? 'WHOOPS. Was that you?'
            : 'Skate through the spill. Leave a little surprise.';
        const dashLabel = state.cooldown > 0
            ? `<span class="action-icon">↯</span><strong>${state.cooldown.toFixed(1)}s</strong>`
            : '<span class="action-icon">↯</span><strong>DASH<br>+ DROP</strong>';
        if (dashLabel !== this.previousDashLabel) {
            this.dash.innerHTML = dashLabel;
            this.previousDashLabel = dashLabel;
        }
        this.dash.setAttribute('aria-disabled', String(state.cooldown > 0));
        this.root.dataset.x = state.x.toFixed(2);
        this.root.dataset.z = state.z.toFixed(2);
        this.root.dataset.slipping = String(state.slipping);
        this.root.dataset.zoom = this.controls.getZoom().toFixed(2);
    }
}

function createPracticeMarkup(): string {
    return `<main class="practice" aria-label="CCA cutout market practice">
      <canvas aria-label="Market playfield: move with WASD or arrows, dash with Space, zoom with plus and minus"></canvas>
      <div id="scene-loading" class="scene-loading" role="status">Unpacking the market…</div>
      <header class="hud"><div class="brand"><span>CCA / LOCAL PLAYGROUND</span><h1>BAD MARKET</h1></div><button id="pause">Pause</button></header>
      <div class="scoreboard"><span>PRANKS <b id="pranks">0</b></span><span>SLIPS <b id="slips">0</b></span></div>
      <div class="zoom" role="group" aria-label="Camera zoom"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button></div>
      <div class="play-hint"><span class="you">YOU = TEAL HOODIE</span><p id="status">Skate through the spill. Leave a little surprise.</p></div>
      <div class="controls"><div class="stick-wrap"><div id="joystick" aria-label="Movement joystick"><div id="puck"></div></div><span>MOVE</span></div><button id="dash" aria-label="Dash and drop"><span class="action-icon">↯</span><strong>DASH<br>+ DROP</strong></button></div>
      <footer>WASD / arrows · Space · scroll to zoom<span>Pinch the street to zoom</span></footer>
      <section id="pause-overlay" class="pause-overlay" hidden aria-label="Practice paused"><div><p class="eyebrow">TAKE A BREATHER</p><h2>Market paused</h2><p>Move, dash, drop a cloud.<br>The blue spill is slippery.</p><button id="resume" class="primary">Back to mischief</button><button id="reset">Start over</button><small>Local scene · no multiplayer yet</small></div></section>
    </main>`;
}
