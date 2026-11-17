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
    flushed: boolean;
}

/**
 * Like WebGL2: a fence that was never flushed may never signal, and a sync from before a context loss reads null,
 * also after the context is restored.
 */
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
        const fence = { generation: this.generation, readyAtMs: this.busyUntilMs, flushed: false };
        this.liveFences.add(fence);
        return fence;
    }

    getSyncParameter(sync: WebGLSync): number | null {
        const fence = sync as FakeFence;
        if (this.lost || fence.generation !== this.generation) {
            return null;
        }
        return fence.flushed && fence.readyAtMs <= nowMs ? this.SIGNALED : this.UNSIGNALED;
    }

    deleteSync(sync: WebGLSync | null): void {
        this.liveFences.delete(sync as FakeFence);
    }

    flush(): void {
        for (const fence of this.liveFences) {
            fence.flushed = true;
        }
    }

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
    readonly lastFrameTimeMs: () => number;
    readonly renderFrame: (frameTimeMs: number) => 'ready';
}

function countDraws(): DrawCounter {
    let draws = 0;
    let totalFrameTimeMs = 0;
    let lastFrameTimeMs = 0;
    return {
        draws: () => draws,
        frameTimeMs: () => totalFrameTimeMs,
        lastFrameTimeMs: () => lastFrameTimeMs,
        renderFrame: (frameTimeMs) => {
            draws += 1;
            totalFrameTimeMs += frameTimeMs;
            lastFrameTimeMs = frameTimeMs;
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

function creditMotionOverRun(gpu: FakeGpu | null): number {
    nowMs = 0;
    const engine = new FakeEngine();
    const frame = countDraws();
    const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: CAP_INTERVAL_MS, renderFrame: frame.renderFrame });
    runDriverFrames(engine, 240);
    loop.dispose();
    return frame.frameTimeMs();
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

    it('follows the frame rate of a GPU slightly slower than the cap and credits motion with real time', () => {
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
        expect(frame.frameTimeMs(), 'every animation frame after the first, held or drawn, up to the last draw at 952 ms')
            .toBe(948);
        loop.dispose();
    });

    it('draws every capped frame on a GPU faster than the cap and credits motion only at the cap\'s rate', () => {
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
        expect(frame.frameTimeMs(), 'only the drawn frames\' own time: the frames the cap skips lose theirs').toBe(160);
        loop.dispose();
    });

    it.each([1, 10, 20, 22, 23, 25, 30, 44, 60, 100, 250])(
        'credits motion between the cap\'s rate and real time with a GPU frame of %i ms',
        (gpuFrameMs) => {
            const capOnlyMs = creditMotionOverRun(null);
            const creditedMs = creditMotionOverRun(new FakeGpu(gpuFrameMs));
            expect(creditedMs, 'never more than the run\'s elapsed time').toBeLessThanOrEqual(nowMs);
            expect(creditedMs, 'never less than the cap alone credits').toBeGreaterThanOrEqual(capOnlyMs);
        }
    );

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

    it('draws the next frame when the context places no fence', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        vi.spyOn(gpu, 'fenceSync').mockReturnValue(null);
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        nowMs = 20;
        engine.animationFrame();
        expect(frame.draws()).toBe(2);
        loop.dispose();
    });

    it('places and flushes a fence behind each drawn frame', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu(2);
        const fencesSeenByDraws: number[] = [];
        const loop = startCappedRenderLoop({
            engine,
            gpu,
            frameIntervalMs: 10,
            renderFrame: () => {
                fencesSeenByDraws.push(gpu.liveFences.size);
                return 'ready';
            }
        });
        runDriverFrames(engine, 6);
        expect(fencesSeenByDraws, 'a draw at 0, 12 and 24 ms, each before its own fence').toEqual([0, 0, 0]);
        expect(gpu.liveFences.size).toBe(1);
        loop.dispose();
    });

    it('passes the frame result on, so an unready image keeps a terminal pause drawing', () => {
        const engine = new FakeEngine();
        const results: ('ready' | 'pending')[] = ['ready', 'pending', 'pending', 'ready'];
        let draws = 0;
        const loop = startCappedRenderLoop({
            engine,
            gpu: new FakeGpu(2),
            frameIntervalMs: CAP_INTERVAL_MS,
            renderFrame: () => results[draws++] ?? 'ready'
        });
        loop.pauseWhenReady();
        runDriverFrames(engine, 30);
        expect(draws).toBe(4);
        expect(engine.loops.size, 'the ready image ends the pause').toBe(0);
        loop.dispose();
    });

    it('keeps a terminal pause scheduled while the GPU has not executed the previous frame', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        loop.pauseWhenReady();
        runDriverFrames(engine, 10);
        expect(frame.draws()).toBe(1);
        expect(engine.loops.size).toBe(1);

        gpu.executeQueuedFrames();
        runDriverFrames(engine, 1);
        expect(frame.draws()).toBe(2);
        expect(engine.loops.size).toBe(0);
        loop.dispose();
    });

    it('draws an invalidation that arrives while a fence is pending once the GPU has executed it', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        loop.pauseWhenReady();
        gpu.executeQueuedFrames();
        runDriverFrames(engine, 3);
        loop.invalidate();
        expect(frame.draws(), 'the idle loop draws the first invalidation at once').toBe(3);

        loop.invalidate();
        runDriverFrames(engine, 10);
        expect(frame.draws()).toBe(3);
        expect(engine.loops.size, 'the held invalidation stays scheduled').toBe(1);

        gpu.executeQueuedFrames();
        runDriverFrames(engine, 1);
        expect(frame.draws()).toBe(4);
        expect(engine.loops.size).toBe(0);
        loop.dispose();
    });

    it('does not give the time held for the GPU before a resume to the first frame drawn after it', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        loop.pauseWhenReady();
        gpu.executeQueuedFrames();
        runDriverFrames(engine, 3);
        expect(engine.loops.size, 'the terminal pause has stopped').toBe(0);

        loop.invalidate();
        loop.invalidate();
        runDriverFrames(engine, 5);
        expect(frame.draws(), 'the second redraw waits for the GPU').toBe(3);

        loop.resume();
        gpu.executeQueuedFrames();
        runDriverFrames(engine, 1);
        expect(frame.draws()).toBe(4);
        expect(frame.lastFrameTimeMs(), 'the 16 ms held before the resume is dropped with the reset timing').toBe(0);
        loop.dispose();
    });

    it('deletes the pending fence when a terminal pause stops drawing', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu(2);
        const loop = startCappedRenderLoop({
            engine,
            gpu,
            frameIntervalMs: 10,
            renderFrame: countDraws().renderFrame
        });
        loop.pauseWhenReady();
        runDriverFrames(engine, 3);
        expect(engine.loops.size).toBe(0);
        expect(gpu.liveFences.size).toBe(0);
        loop.dispose();
    });

    it('deletes the pending fence when the loop is disposed', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const loop = startCappedRenderLoop({
            engine,
            gpu,
            frameIntervalMs: 10,
            renderFrame: countDraws().renderFrame
        });
        expect(gpu.liveFences.size).toBe(1);
        loop.dispose();
        expect(gpu.liveFences.size).toBe(0);
    });

    it('deletes the fence of a draw made while the loop was idle when the loop is disposed', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu(2);
        const loop = startCappedRenderLoop({
            engine,
            gpu,
            frameIntervalMs: 10,
            renderFrame: countDraws().renderFrame
        });
        loop.pauseWhenReady();
        runDriverFrames(engine, 3);
        loop.invalidate();
        expect(gpu.liveFences.size).toBe(1);
        loop.dispose();
        expect(gpu.liveFences.size).toBe(0);
    });
});
