import {
    ColorId,
    WhackOutcome,
    createInitialState,
    computeNextState,
    makeMulberry32,
    whackAtNormalizedPoint,
    type EngineParams,
    type EngineState,
} from '@shared/mod';

import type { WhackDetail } from './eh-whack-canvas';

const DefaultParams: EngineParams = {
    tickMs: 250,
    wormTtlMs: 2000,
    spawnChancePerTick: 0.18,
    minRadius01: 0.04,
    maxRadius01: 0.08,
};

export class EhWhackSingleScreen extends HTMLElement {
    private params: EngineParams = DefaultParams;

    // Phase 3: single-player identity. (Later P2P: real playerId assigned in lobby.)
    private readonly localPlayerId: string = 'local';
    private readonly localColor: ColorId = ColorId.Green;

    private state: EngineState = createInitialState(Date.now());
    private rng = makeMulberry32(Date.now());

    private score: number = 0;

    private timerId: number | undefined = undefined;

    connectedCallback(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Whack-a-worm — Single-player</h2>

        <div class="row muted">
          <div>Score: <strong id="score">0</strong></div>
          <div>Worms: <strong id="worms">0</strong></div>
        </div>

        <eh-whack-canvas id="canvas"></eh-whack-canvas>

        <div class="row">
          <button id="restartBtn">Restart</button>
          <button id="backBtn">Back</button>
        </div>

        <div id="status" class="status"></div>
      </div>
    `;

        const canvas = this.querySelector('#canvas') as HTMLElement | null;
        const restartBtn = this.querySelector('#restartBtn') as HTMLButtonElement | null;
        const backBtn = this.querySelector('#backBtn') as HTMLButtonElement | null;

        if (!canvas) throw new Error('Missing #canvas');
        if (!restartBtn) throw new Error('Missing #restartBtn');
        if (!backBtn) throw new Error('Missing #backBtn');

        canvas.addEventListener('whack', (e: Event) => {
            const ce = e as CustomEvent<WhackDetail>;
            this.onWhack(ce.detail.x01, ce.detail.y01);
        });

        restartBtn.addEventListener('click', () => this.restart());
        backBtn.addEventListener('click', () => (location.hash = '#/whack'));

        this.startLoop();
        this.render();
    }

    disconnectedCallback(): void {
        this.stopLoop();
    }

    private startLoop(): void {
        this.stopLoop();
        this.timerId = window.setInterval(() => {
            this.state = computeNextState({
                state: this.state,
                nowMs: Date.now(),
                rng: this.rng,
                params: this.params,
                localPlayerId: this.localPlayerId,
                localColor: this.localColor,
            });
            this.render();
        }, this.params.tickMs);
    }

    private stopLoop(): void {
        if (this.timerId !== undefined) {
            window.clearInterval(this.timerId);
            this.timerId = undefined;
        }
    }

    private restart(): void {
        this.state = createInitialState(Date.now());
        this.rng = makeMulberry32(Date.now());
        this.score = 0;
        this.setStatus('Restarted.');
        this.render();
    }

    private onWhack(x01: number, y01: number): void {
        const res = whackAtNormalizedPoint({ state: this.state, x01, y01 });
        this.state = res.next;

        if (res.outcome === WhackOutcome.Hit) {
            this.score += 1;
            this.setStatus('Hit!');
        } else {
            this.setStatus('Miss.');
        }

        this.render();
    }

    private setStatus(text: string): void {
        const el = this.querySelector('#status') as HTMLDivElement | null;
        if (!el) throw new Error('Missing #status');
        el.textContent = text;
    }

    private render(): void {
        const scoreEl = this.querySelector('#score') as HTMLSpanElement | null;
        const wormsEl = this.querySelector('#worms') as HTMLSpanElement | null;
        const canvas = this.querySelector('#canvas') as any;

        if (!scoreEl) throw new Error('Missing #score');
        if (!wormsEl) throw new Error('Missing #worms');
        if (!canvas) throw new Error('Missing #canvas');

        scoreEl.textContent = String(this.score);
        wormsEl.textContent = String(this.state.wormsById.size);

        canvas.gameState = this.state;
    }
}

customElements.define('eh-whack-single-screen', EhWhackSingleScreen);