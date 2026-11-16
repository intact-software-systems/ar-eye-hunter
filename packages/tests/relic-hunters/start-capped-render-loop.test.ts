import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startCappedRenderLoop } from '../../../apps/relic-hunters-v1/src/game/scene/start-capped-render-loop.ts';

/** Like Babylon: one delta per animation frame, and no render-loop callback while the context is lost. */
class FakeEngine {
    readonly performanceMonitor = { reset: () => undefined };
    readonly loops = new Set<() => void>();
    lost = false;

    runRenderLoop(frame: () => void): void {
        this.loops.add(frame);
    }

    stopRenderLoop(frame: () => void): void {
        this.loops.delete(frame);
    }

    animationFrame(): void {
        if (!this.lost) {
            for (const frame of [...this.loops]) {
                frame();
            }
        }
    }
}

interface FakeFence {
    readonly generation: number;
    readyAtMs: number;
}

/** Like WebGL2: a sync from before a context loss reads null, also after the context is restored. */
class FakeGpu {
    readonly SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
    readonly SYNC_STATUS = 0x9114;
    readonly UNSIGNALED = 0x9118;
    readonly SIGNALED = 0x9119;
    readonly liveFences = new Set<FakeFence>();
    generation = 0;
    lost = false;

    fenceSync(): WebGLSync | null {
        if (this.lost) {
            return null;
        }
        const fence = { generation: this.generation, readyAtMs: Number.POSITIVE_INFINITY };
        this.liveFences.add(fence);
        return fence;
    }

    getSyncParameter(sync: WebGLSync): number | null {
        const fence = sync as FakeFence;
        if (this.lost || fence.generation !== this.generation) {
            return null;
        }
        return fence.readyAtMs <= nowMs ? this.SIGNALED : this.UNSIGNALED;
    }

    deleteSync(sync: WebGLSync | null): void {
        this.liveFences.delete(sync as FakeFence);
    }

    flush(): void {}

    executeQueuedFrames(): void {
        for (const fence of this.liveFences) {
            fence.readyAtMs = Number.NEGATIVE_INFINITY;
        }
    }

    loseContext(): void {
        this.lost = true;
        this.generation += 1;
        this.liveFences.clear();
    }

    restoreContext(): void {
        this.lost = false;
    }
}

let nowMs = 0;

function countDraws(): { readonly draws: () => number; readonly renderFrame: () => 'ready'; } {
    let draws = 0;
    return {
        draws: () => draws,
        renderFrame: () => {
            draws += 1;
            return 'ready';
        }
    };
}

describe('Relic gameplay render loop', () => {
    beforeEach(() => {
        nowMs = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('draws the next frame only once the GPU has executed the previous one', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        expect(frame.draws()).toBe(1);

        nowMs = 20;
        engine.animationFrame();
        nowMs = 40;
        engine.animationFrame();
        expect(frame.draws()).toBe(1);

        gpu.executeQueuedFrames();
        nowMs = 60;
        engine.animationFrame();
        expect(frame.draws()).toBe(2);
        expect(gpu.liveFences.size).toBe(1);
        loop.dispose();
    });

    it('draws again after a context loss and restore, although the earlier fence can no longer be read', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });

        gpu.loseContext();
        engine.lost = true;
        nowMs = 20;
        engine.animationFrame();
        gpu.restoreContext();
        engine.lost = false;
        nowMs = 40;
        engine.animationFrame();
        expect(frame.draws()).toBe(2);
        loop.dispose();
    });

    it('keeps drawing every capped frame where the browser offers no GPU fences', () => {
        const engine = new FakeEngine();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu: null, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        nowMs = 20;
        engine.animationFrame();
        expect(frame.draws()).toBe(2);
        loop.dispose();
    });
});
