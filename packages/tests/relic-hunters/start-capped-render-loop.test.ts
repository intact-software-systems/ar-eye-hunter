import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startCappedRenderLoop } from '../../../apps/relic-hunters-v1/src/game/scene/start-capped-render-loop.ts';

/** Like Babylon: one delta per animation frame, and no render-loop callback while the context is lost. */
class FakeEngine {
    readonly performanceMonitor = {
        reset: () => {
            this.previousFrameMs = null;
        }
    };
    readonly loops = new Set<() => void>();
    lost = false;
    private previousFrameMs: number | null = null;
    private deltaMs = 0;

    getDeltaTime(): number {
        return this.deltaMs;
    }

    runRenderLoop(frame: () => void): void {
        this.loops.add(frame);
    }

    stopRenderLoop(frame: () => void): void {
        this.loops.delete(frame);
    }

    animationFrame(): void {
        if (!this.lost) {
            this.deltaMs = this.previousFrameMs === null ? 0 : nowMs - this.previousFrameMs;
            this.previousFrameMs = nowMs;
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
    private readonly frameMs: number;
    private busyUntilMs = 0;

    constructor(frameMs = Number.POSITIVE_INFINITY) {
        this.frameMs = frameMs;
    }

    fenceSync(): WebGLSync | null {
        if (this.lost) {
            return null;
        }
        this.busyUntilMs = Math.max(nowMs, this.busyUntilMs) + this.frameMs;
        const fence = { generation: this.generation, readyAtMs: this.busyUntilMs };
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

interface DrawCounter {
    readonly draws: () => number;
    readonly frameTimeMs: () => number;
    readonly renderFrame: (frameTimeMs: number) => 'ready';
}

function countDraws(): DrawCounter {
    let draws = 0;
    let totalFrameTimeMs = 0;
    return {
        draws: () => draws,
        frameTimeMs: () => totalFrameTimeMs,
        renderFrame: (frameTimeMs) => {
            draws += 1;
            totalFrameTimeMs += frameTimeMs;
            return 'ready';
        }
    };
}

const CAP_INTERVAL_MS = 1000 / 45;
const DRIVER_FRAME_MS = 4;

function runDriverFrames(engine: FakeEngine, count: number): void {
    for (let index = 0; index < count; index += 1) {
        nowMs += DRIVER_FRAME_MS;
        engine.animationFrame();
    }
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

    it('follows the frame rate of a GPU slightly slower than the cap instead of a fraction of the cap', () => {
        const engine = new FakeEngine();
        const frame = countDraws();
        const loop = startCappedRenderLoop({
            engine,
            gpu: new FakeGpu(CAP_INTERVAL_MS + 3),
            frameIntervalMs: CAP_INTERVAL_MS,
            renderFrame: frame.renderFrame
        });
        runDriverFrames(engine, 240);
        expect(frame.draws(), 'one draw per 28 ms: the 25 ms GPU frame rounded up to a driver frame').toBe(35);
        expect(frame.frameTimeMs(), 'every animation frame after the first, up to the last draw at 952 ms').toBe(948);
        loop.dispose();
    });

    it('draws every capped frame on a GPU faster than the cap', () => {
        const engine = new FakeEngine();
        const frame = countDraws();
        const loop = startCappedRenderLoop({
            engine,
            gpu: new FakeGpu(2),
            frameIntervalMs: CAP_INTERVAL_MS,
            renderFrame: frame.renderFrame
        });
        runDriverFrames(engine, 240);
        expect(frame.draws(), 'one draw per 24 ms: the cap rounded up to a driver frame').toBe(41);
        expect(frame.frameTimeMs(), 'as without fences: the cap still drops its skipped frames\' time').toBe(160);
        loop.dispose();
    });

    it('keeps drawing every capped frame where the browser offers no GPU fences', () => {
        const engine = new FakeEngine();
        const frame = countDraws();
        const loop = startCappedRenderLoop({
            engine,
            gpu: null,
            frameIntervalMs: CAP_INTERVAL_MS,
            renderFrame: frame.renderFrame
        });
        runDriverFrames(engine, 240);
        expect(frame.draws()).toBe(41);
        expect(frame.frameTimeMs()).toBe(160);
        loop.dispose();
    });
});
