import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startCappedRenderLoop } from '../../../apps/relic-hunters-v1/src/game/scene/start-capped-render-loop.ts';

class FakeEngine {
    readonly performanceMonitor = { reset: () => undefined };
    frame: (() => void) | undefined;

    runRenderLoop(frame: () => void): void {
        this.frame = frame;
    }

    stopRenderLoop(): void {
        this.frame = undefined;
    }
}

class FakeGpu {
    readonly SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
    readonly SYNC_STATUS = 0x9114;
    readonly SIGNALED = 0x9119;
    executed = false;
    lost = false;
    liveFences = 0;

    fenceSync(): WebGLSync {
        this.executed = false;
        this.liveFences += 1;
        return {};
    }

    getSyncParameter(): number | null {
        if (this.lost) {
            return null;
        }
        return this.executed ? this.SIGNALED : 0x9118;
    }

    deleteSync(): void {
        this.liveFences -= 1;
    }

    flush(): void {}

    isContextLost(): boolean {
        return this.lost;
    }
}

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
    let nowMs = 0;
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
        engine.frame?.();
        nowMs = 40;
        engine.frame?.();
        expect(frame.draws()).toBe(1);

        gpu.executed = true;
        nowMs = 60;
        engine.frame?.();
        expect(frame.draws()).toBe(2);
        expect(gpu.liveFences).toBe(1);
        loop.dispose();
    });

    it('does not wait on the fence of a lost context', () => {
        const engine = new FakeEngine();
        const gpu = new FakeGpu();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu, frameIntervalMs: 10, renderFrame: frame.renderFrame });

        gpu.lost = true;
        nowMs = 20;
        engine.frame?.();
        expect(frame.draws()).toBe(2);
        loop.dispose();
    });

    it('keeps drawing every capped frame where the browser offers no GPU fences', () => {
        const engine = new FakeEngine();
        const frame = countDraws();
        const loop = startCappedRenderLoop({ engine, gpu: null, frameIntervalMs: 10, renderFrame: frame.renderFrame });
        nowMs = 20;
        engine.frame?.();
        expect(frame.draws()).toBe(2);
        loop.dispose();
    });
});
