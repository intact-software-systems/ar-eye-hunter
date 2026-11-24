import { PracticeControls, requirePracticeElement } from './practice-controls.ts';
import {
    computePracticeTick,
    createPracticeState,
    type PracticeState
} from './practice-rules.ts';
import { PracticeScene } from './practice-scene.ts';
import { TOWN_TROUBLE_TARGET } from './town/mischief.ts';
import { TownRoutes } from './town/routes.ts';
import { describeTownSpectacle } from './town/spectacles/status.ts';

export class PracticeApp {
    private readonly routes = new TownRoutes();
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

    constructor(root: HTMLElement, onOnline: () => void) {
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
        requirePracticeElement(root, '#online').addEventListener('click', onOnline, { signal: this.lifetime.signal });
        this.scene.engine.runRenderLoop(() => this.frame());
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.routes.clear();
        this.lifetime.abort();
        this.controls.stop();
        this.scene.stop();
    }

    private bindLifecycle(canvas: HTMLCanvasElement): void {
        const options = { signal: this.lifetime.signal };
        this.pause.addEventListener('click', () => this.setPaused(!this.paused), options);
        requirePracticeElement(this.root, '#resume').addEventListener('click', () => this.setPaused(false), options);
        requirePracticeElement(this.root, '#reset').addEventListener('click', () => {
            this.routes.clear();
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
                this.state = computePracticeTick(this.state, this.controls.getInput(), {
                    seconds: 1 / 60,
                    routes: this.routes
                });
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
        this.heat.textContent = `${state.town.heat}/${TOWN_TROUBLE_TARGET}`;
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
                state.power === 'fart'
                    ? 'DROP'
                    : state.power === 'powder'
                    ? 'PUFF'
                    : state.power === 'poop-bomb'
                    ? 'BOMB'
                    : 'ZAP'
            }</strong>`;
        if (dashLabel !== this.previousDashLabel) {
            this.dash.innerHTML = dashLabel;
            this.previousDashLabel = dashLabel;
        }
        this.dash.setAttribute('aria-disabled', String(state.cooldown > 0 || state.frozenUntil > state.elapsed));
        this.publishObservedState(state);
    }

    private publishObservedState(state: PracticeState): void {
        this.root.dataset.spectacle = state.town.spectacles.active?.kind ?? 'none';
        this.root.dataset.spectaclePhase = state.town.spectacles.active?.phase ?? 'none';
        this.root.dataset.spectacleQueue = String(state.town.spectacles.queue.length);
        this.root.dataset.firefighters = String(state.town.spectacles.firefighters.length);
        this.root.dataset.fires = String(state.town.spectacles.fires);
        this.root.dataset.bombs = String(state.town.spectacles.bombs);
        this.root.dataset.dinners = String(state.town.spectacles.dinners);
        this.root.dataset.residents = state.town.personalities.filter((resident) => resident.phase === 'reacting').map(
            (resident) => resident.kind
        ).join(',');
        this.root.dataset.bonuses = String(state.town.raid.bonuses);
        this.root.dataset.police = String(
            state.town.raid.guards.filter((guard) => guard.mode !== 'emerging' || guard.until <= state.elapsed).length
        );
        this.root.dataset.stain = state.stain;
        this.root.dataset.objects = String(
            state.town.objects.filter((object) => object.damagedUntil > state.elapsed).length
        );
        this.root.dataset.mischief = String(state.town.mischief);
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
      <header class="hud"><div class="brand"><span>CCA / LOCAL PLAYGROUND + BOT PAL</span><h1>GRUMPY TOWN</h1></div><div class="hud-actions"><button id="online">Play with friends</button><button id="pause">Pause</button></div></header>
      <div class="scoreboard"><span>POINTS <b id="points">0</b></span><span>TROUBLE <b id="heat">0</b></span><span>SAVES <b id="rescues">0</b></span></div>
      <div class="zoom" role="group" aria-label="Camera zoom"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button></div>
      <div class="play-hint"><span class="you" id="power">TEAL HOODIE / FART LOADED</span><p id="status">Dash into a stall. Make a mess.</p></div>
      <div class="controls"><div class="stick-wrap"><div id="joystick" aria-label="Movement joystick"><div id="puck"></div></div><span>MOVE</span></div><button id="dash" aria-label="Dash and drop"><span class="action-icon">↯</span><strong>DASH<br>+ DROP</strong></button></div>
      <footer>WASD / arrows · Space · scroll to zoom<span>Pinch the street to zoom</span></footer>
      <section id="pause-overlay" class="pause-overlay" hidden aria-label="Practice paused"><div><p class="eyebrow">TAKE A BREATHER</p><h2>Market paused</h2><p>Explore the town. Dash the bell, flowers, statue, laundry and queue barrier.<br>Kick the barbecue to call grumpy firefighters. Grab THE BIG STINK and dash to drop it. Tip FREE SAMPLES for a spectacularly bad lunch.<br>Tip bins, spill fish, overflow the toilet or break a hydrant. Lure grumpy birds, dogs and cats into your pursuers. Water washes stains off.<br>Six fresh messes earn +50, then ten police leave the Ministry! Dodge for 25 seconds.<br>Stand beside a frozen friend for one second to rescue. You also thaw automatically after six seconds.</p><button id="resume" class="primary">Back to mischief</button><button id="reset">Start over</button><small>Orange BOT PAL is simulated · no multiplayer yet</small></div></section>
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
    if (town.companion && town.companion.frozenUntil > elapsed) {
        return 'BOT PAL FROZEN! Stand beside the orange coat to rescue.';
    }
    if (town.raid.phase === 'alarm') {
        return `+50 MISCHIEF BONUS! Ten police dispatched in ${Math.ceil(town.raid.until - elapsed)}s!`;
    }
    if (town.raid.phase === 'active') {
        return `10 POLICE / ${Math.ceil(town.raid.until - elapsed)}s — dodge targets. Lure animals!`;
    }
    if (town.raid.phase === 'returning') {
        return 'SHIFT OVER! Police returning to the Ministry.';
    }
    if (state.stain !== 'clean') {
        return `${state.stain.toUpperCase()}! Find fountain spray or a broken hydrant to wash off.`;
    }
    const spectacle = describeTownSpectacle(town, elapsed);
    if (spectacle) {
        return spectacle;
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
    return 'Six fresh messes = +50 points… and TEN POLICE.';
}
