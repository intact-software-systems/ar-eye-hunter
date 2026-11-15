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

    fenceSync(): WebGLSync {
        this.executed = false;
        return {};
    }

    getSyncParameter(): number {
        return this.executed ? this.SIGNALED : 0x9118;
    }

    deleteSync(): void {}

    flush(): void {}

    isContextLost(): boolean {
        return false;
    }
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
        let draws = 0;
        const loop = startCappedRenderLoop({
            engine,
            gpu,
            frameIntervalMs: 10,
            renderFrame: () => {
                draws += 1;
                return 'ready';
            }
        });
        expect(draws).toBe(1);

        nowMs = 20;
        engine.frame?.();
        nowMs = 40;
        engine.frame?.();
        expect(draws).toBe(1);

        gpu.executed = true;
        nowMs = 60;
        engine.frame?.();
        expect(draws).toBe(2);
        loop.dispose();
    });

    it('keeps drawing every capped frame where the browser offers no GPU fences', () => {
        const engine = new FakeEngine();
        let draws = 0;
        const loop = startCappedRenderLoop({
            engine,
            gpu: null,
            frameIntervalMs: 10,
            renderFrame: () => {
                draws += 1;
                return 'ready';
            }
        });
        nowMs = 20;
        engine.frame?.();
        expect(draws).toBe(2);
        loop.dispose();
    });
});
