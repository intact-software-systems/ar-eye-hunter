import { describe, expect, it } from 'vitest';

import { CappedFrameLoop } from '../../../../shared/resilience/timing/capped-frame-loop.ts';

class FrameDriver {
    nowMs = 0;
    scheduled: (() => void) | undefined;
    timingResets = 0;

    start(frame: () => void): void {
        this.scheduled = frame;
    }

    stop(frame: () => void): void {
        if (this.scheduled === frame) {
            this.scheduled = undefined;
        }
    }

    resetTiming(): void {
        this.timingResets += 1;
    }

    advance(nowMs: number): void {
        this.nowMs = nowMs;
        this.scheduled?.();
    }
}

describe('capped frame lifecycle', () => {
    it('preserves an invalidation delivered during a ready render without recursive rendering', () => {
        const driver = new FrameDriver();
        const renderEvents = new Set<() => void>();
        let frames = 0;
        const loop = new CappedFrameLoop({
            driver,
            nowMs: () => driver.nowMs,
            renderFrame: () => {
                frames += 1;
                for (const event of renderEvents) {
                    event();
                }
                return 'ready';
            }
        }, { frameIntervalMs: 40 });
        loop.start();
        loop.pauseWhenReady();
        driver.advance(40);
        const invalidate = () => loop.invalidate();
        renderEvents.add(invalidate);
        loop.invalidate();
        expect(frames).toBe(3);
        expect(driver.scheduled).toBeDefined();
        renderEvents.delete(invalidate);
        driver.advance(80);
        expect(frames).toBe(4);
        expect(driver.scheduled).toBeUndefined();
    });

    it('draws immediately, caps driver callbacks and stops only after a ready requested image', () => {
        const driver = new FrameDriver();
        const frames: number[] = [];
        let ready = false;
        const loop = new CappedFrameLoop({
            driver,
            nowMs: () => driver.nowMs,
            renderFrame: () => {
                frames.push(driver.nowMs);
                return ready ? 'ready' : 'pending';
            }
        }, { frameIntervalMs: 40 });
        loop.start();
        loop.pauseWhenReady();
        driver.advance(10);
        driver.advance(40);
        expect(frames).toEqual([0, 40]);
        expect(driver.scheduled).toBeDefined();
        ready = true;
        driver.advance(80);
        driver.advance(120);
        expect(frames).toEqual([0, 40, 80]);
        expect(driver.scheduled).toBeUndefined();
        loop.pauseWhenReady();
        expect(frames).toEqual([0, 40, 80]);
    });

    it('redraws on invalidation without restarting continuous rendering, then resumes with fresh timing', () => {
        const driver = new FrameDriver();
        const frames: number[] = [];
        const loop = new CappedFrameLoop({
            driver,
            nowMs: () => driver.nowMs,
            renderFrame: () => {
                frames.push(driver.nowMs);
                return 'ready';
            }
        }, { frameIntervalMs: 40 });
        loop.start();
        loop.pauseWhenReady();
        driver.advance(40);
        driver.advance(10000);
        loop.invalidate();
        expect(frames).toEqual([0, 40, 10000]);
        expect(driver.scheduled).toBeUndefined();
        loop.resume();
        expect(driver.timingResets).toBe(2);
        driver.advance(10010);
        driver.advance(10040);
        expect(frames).toEqual([0, 40, 10000, 10000, 10040]);
        expect(driver.scheduled).toBeDefined();
        loop.dispose();
    });

    it('cancels pending readiness on disposal and ignores queued callbacks and later requests', () => {
        const driver = new FrameDriver();
        let frames = 0;
        const loop = new CappedFrameLoop({
            driver,
            nowMs: () => driver.nowMs,
            renderFrame: () => {
                frames += 1;
                return 'pending';
            }
        }, { frameIntervalMs: 40 });
        loop.start();
        const queued = driver.scheduled;
        loop.dispose();
        driver.nowMs = 100;
        queued?.();
        loop.invalidate();
        loop.resume();
        loop.start();
        expect(frames).toBe(1);
        expect(driver.scheduled).toBeUndefined();
    });

    it('releases scheduling if a renderer fails after startup', () => {
        const driver = new FrameDriver();
        const loop = new CappedFrameLoop({
            driver,
            nowMs: () => driver.nowMs,
            renderFrame: () => {
                if (driver.nowMs > 0) {
                    throw new Error('graphics failure');
                }
                return 'ready';
            }
        }, { frameIntervalMs: 40 });
        loop.start();
        expect(() => driver.advance(40)).toThrow('graphics failure');
        expect(driver.scheduled).toBeUndefined();
    });
});
