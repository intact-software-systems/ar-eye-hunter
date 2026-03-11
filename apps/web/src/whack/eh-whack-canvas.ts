import { ColorId, type EngineState, type Worm } from '@shared/mod';
import { mustEl } from '../utils/utils.ts';

export type WhackDetail = {
    readonly x01: number;
    readonly y01: number;
};

export class EhWhackCanvas extends HTMLElement {
    private state: EngineState | undefined = undefined;
    private ro: ResizeObserver | undefined = undefined;

    connectedCallback(): void {
        this.innerHTML = `
      <div class="whack-canvas-wrap">
        <canvas class="whack-canvas"></canvas>
      </div>
    `;

        const wrap = mustEl<HTMLDivElement>(this, '.whack-canvas-wrap');
        const canvas = mustEl<HTMLCanvasElement>(this, 'canvas');

        this.ro = new ResizeObserver(() => this.resizeToCssPixels());
        this.ro.observe(wrap);

        canvas.addEventListener('pointerdown', (ev) => {
            const rect = canvas.getBoundingClientRect();
            const x01 = (ev.clientX - rect.left) / rect.width;
            const y01 = (ev.clientY - rect.top) / rect.height;

            this.dispatchEvent(
                new CustomEvent<WhackDetail>('whack', {
                    detail: { x01, y01 },
                    bubbles: true,
                    composed: true,
                }),
            );
        });

        this.resizeToCssPixels();
        this.draw();
    }

    disconnectedCallback(): void {
        this.ro?.disconnect();
        this.ro = undefined;
    }

    set gameState(v: EngineState) {
        this.state = v;
        this.draw();
    }

    private resizeToCssPixels(): void {
        const canvas = mustEl<HTMLCanvasElement>(this, 'canvas');
        const rect = canvas.getBoundingClientRect();

        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        this.draw();
    }

    private colorToCss(color: ColorId): string {
        // Small palette. Adjust as you like.
        switch (color) {
            case ColorId.Green:
                return '#2ecc71';
            case ColorId.Blue:
                return '#3498db';
            case ColorId.Red:
                return '#e74c3c';
            case ColorId.Yellow:
                return '#f1c40f';
        }
    }

    private drawWormSingle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, worm: Worm): void {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = this.colorToCss(worm.color);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.stroke();
    }

    private drawWormMulti(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, worms: readonly Worm[]): void {
        const n = worms.length;
        const step = (Math.PI * 2) / n;

        // Center
        ctx.beginPath();
        ctx.arc(x, y, r * 0.75, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();

        for (let i = 0; i < n; i++) {
            const a0 = i * step;
            const a1 = a0 + step;

            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.arc(x, y, r, a0, a1);
            ctx.closePath();

            ctx.fillStyle = this.colorToCss(worms[i]!.color);
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.stroke();
    }

    private draw(): void {
        const canvas = this.querySelector('canvas') as HTMLCanvasElement | null;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const st = this.state;
        const w = canvas.width;
        const h = canvas.height;

        // Background
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, 0, w, h);

        if (!st) return;

        const minDim = Math.min(w, h);

        // Bucket worms by approximate pixel grid to treat near-overlaps as collisions.
        // This makes "coordinate collisions" practical (exact float equality is rare).
        const bucketPx = 10;
        const buckets = new Map<string, Worm[]>();

        for (const worm of st.wormsById.values()) {
            const x = worm.x * w;
            const y = worm.y * h;

            const bx = Math.floor(x / bucketPx);
            const by = Math.floor(y / bucketPx);
            const key = `${bx}:${by}`;

            const arr = buckets.get(key);
            if (arr) arr.push(worm);
            else buckets.set(key, [worm]);
        }

        for (const worms of buckets.values()) {
            const base = worms[0]!;
            const x = base.x * w;
            const y = base.y * h;
            const r = base.radius01 * minDim;

            if (worms.length === 1) this.drawWormSingle(ctx, x, y, r, base);
            else this.drawWormMulti(ctx, x, y, r, worms);
        }
    }
}

customElements.define('eh-whack-canvas', EhWhackCanvas);
