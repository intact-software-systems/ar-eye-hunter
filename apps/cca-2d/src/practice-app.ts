import { PracticeControls, requirePracticeElement } from './practice-controls.ts';
import { computePracticeTick, createPracticeState, type PracticeState } from './practice-rules.ts';
import { PracticeScene } from './practice-scene.ts';

export class PracticeApp {
    private readonly lifetime = new AbortController();
    private readonly root: HTMLElement;
    private readonly controls: PracticeControls;
    private readonly scene: PracticeScene;
    private readonly status: HTMLElement;
    private readonly points: HTMLElement;
    private readonly rescues: HTMLElement;
    private readonly heat: HTMLElement;
    private readonly power: HTMLElement;
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
        this.points = requirePracticeElement(root, '#points');
        this.rescues = requirePracticeElement(root, '#rescues');
        this.heat = requirePracticeElement(root, '#heat');
        this.power = requirePracticeElement(root, '#power');
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
        this.scene.render({
            state: this.state,
            zoom: this.controls.getZoom(),
            seconds,
            reducedMotion: this.reducedMotion.matches
        });
        this.updateHud();
    }

    private updateHud(): void {
        const state = this.state;
        this.points.textContent = String(state.town.score);
        this.rescues.textContent = String(state.town.rescues);
        this.loading.hidden = this.scene.scene.isReady();
        this.heat.textContent = String(Math.min(3, state.town.heat));
        this.power.textContent = state.power === 'fart'
            ? 'TEAL HOODIE / FART LOADED'
            : `${state.power.toUpperCase()} LOADED / DASH TO USE`;
        this.status.textContent = describePracticeStatus(state);
        const dashLabel = state.frozenUntil > state.elapsed
            ? `<span class="action-icon">❄</span><strong>FROZEN<br>${
                Math.ceil(state.frozenUntil - state.elapsed)
            }s</strong>`
            : state.cooldown > 0
            ? `<span class="action-icon">↯</span><strong>${state.cooldown.toFixed(1)}s</strong>`
            : `<span class="action-icon">↯</span><strong>DASH<br>+ ${
                state.power === 'fart' ? 'DROP' : state.power === 'powder' ? 'PUFF' : 'ZAP'
            }</strong>`;
        if (dashLabel !== this.previousDashLabel) {
            this.dash.innerHTML = dashLabel;
            this.previousDashLabel = dashLabel;
        }
        this.dash.setAttribute('aria-disabled', String(state.cooldown > 0 || state.frozenUntil > state.elapsed));
        this.root.dataset.raid = state.town.raid.phase;
        this.root.dataset.frozen = String(state.frozenUntil > state.elapsed);
        this.root.dataset.fountain = String(state.town.fountain.broken);
        this.root.dataset.cart = String(state.town.cart.loose);
        this.root.dataset.pranks = String(state.pranks);
        this.root.dataset.rescues = String(state.town.rescues);
        this.root.dataset.x = state.x.toFixed(2);
        this.root.dataset.z = state.z.toFixed(2);
        this.root.dataset.slipping = String(state.slipping);
        this.root.dataset.spills = String(state.town.spills);
        this.root.dataset.cleaned = String(state.town.cleaned);
        this.root.dataset.power = state.power;
        this.root.dataset.dizzy = String(state.dizzyUntil > state.elapsed);
        this.root.dataset.zoom = this.controls.getZoom().toFixed(2);
    }
}

function createPracticeMarkup(): string {
    return `<main class="practice" aria-label="CCA cutout market practice">
      <canvas aria-label="Market playfield: move with WASD or arrows, dash with Space, zoom with plus and minus"></canvas>
      <div id="scene-loading" class="scene-loading" role="status">Unpacking the market…</div>
      <header class="hud"><div class="brand"><span>CCA / LOCAL PLAYGROUND + BOT PAL</span><h1>GRUMPY TOWN</h1></div><button id="pause">Pause</button></header>
      <div class="scoreboard"><span>POINTS <b id="points">0</b></span><span>HEAT <b id="heat">0</b></span><span>SAVES <b id="rescues">0</b></span></div>
      <div class="zoom" role="group" aria-label="Camera zoom"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button></div>
      <div class="play-hint"><span class="you" id="power">TEAL HOODIE / FART LOADED</span><p id="status">Dash into a stall. Make a mess.</p></div>
      <div class="controls"><div class="stick-wrap"><div id="joystick" aria-label="Movement joystick"><div id="puck"></div></div><span>MOVE</span></div><button id="dash" aria-label="Dash and drop"><span class="action-icon">↯</span><strong>DASH<br>+ DROP</strong></button></div>
      <footer>WASD / arrows · Space · scroll to zoom<span>Pinch the street to zoom</span></footer>
      <section id="pause-overlay" class="pause-overlay" hidden aria-label="Practice paused"><div><p class="eyebrow">TAKE A BREATHER</p><h2>Market paused</h2><p>Dash into fruit stalls, the fountain or the parcel cart. Busy owners clean; tidy neighbours chase you.<br>Three witnessed pranks trigger a call. Distract the caller or dodge the raid!<br>Stand beside a frozen friend for one second to rescue. You also thaw automatically after six seconds.</p><button id="resume" class="primary">Back to mischief</button><button id="reset">Start over</button><small>Orange BOT PAL is simulated · no multiplayer yet</small></div></section>
    </main>`;
}

function describePracticeStatus(state: PracticeState): string {
    const { town, elapsed } = state;
    if (state.frozenUntil > elapsed) {
        return `FROZEN ${Math.ceil(state.frozenUntil - elapsed)}s — stay close to a friend to thaw.`;
    }
    if (town.rescueProgress > 0) {
        return `RESCUING ${Math.round(town.rescueProgress * 100)}% — stay close!`;
    }
    if (town.companion.frozenUntil > elapsed) {
        return 'BOT PAL FROZEN! Stand beside the orange coat to rescue.';
    }
    if (town.raid.phase === 'alarm') {
        return `CALLING THE GRUMPS! ${Math.ceil(town.raid.until - elapsed)}s — distract the caller!`;
    }
    if (town.raid.phase === 'active') {
        return `RAID ${Math.ceil(town.raid.until - elapsed)}s — dodge red targets. Stick together!`;
    }
    if (town.npcs.some((npc) => npc.mode === 'warning')) {
        return 'Owner aiming — move out of the target!';
    }
    if (state.dizzyUntil > elapsed) {
        return 'URRRP. Get out of that powder!';
    }
    if (state.slipping) {
        return 'SLIPPERY! Let go to feel the slide.';
    }
    if (town.npcs.some((npc) => npc.mode === 'chasing')) {
        return 'BUSTED! Break sight behind a stall.';
    }
    if (state.power !== 'fart') {
        return 'Dash near an owner to use your prank.';
    }
    return 'Tip fruit. Break the fountain. Push the cart. Keep them busy!';
}
