import type { FrameLoadInput, FrameLoadObservation } from './durable-send-harness-contract.ts';

/**
 * Busy main-thread work paced by a fixed frame clock inside a `requestAnimationFrame` loop. Headless
 * Chromium runs animation frames back to back instead of on a display's vsync, so the clock, not
 * the callback rate, holds the load at `busyMsPerFrame` of every `frameIntervalMs`.
 *
 * A caller that waits for a frame's end starts its work where a game's frame loop would: right
 * after the frame's own work, in the same task. Starting at that fixed phase keeps the round trips'
 * alignment with later frames, and so the figures, the same from run to run.
 */
export class PacedFrameLoad {
    private handle: number | undefined;
    private nextFrameAtMs = 0;
    private startedAtMs = 0;
    private busyMs = 0;
    private frameCount = 0;
    private frameEndWaiters: (() => void)[] = [];

    start(input: FrameLoadInput): void {
        this.startedAtMs = performance.now();
        this.nextFrameAtMs = this.startedAtMs;
        this.busyMs = 0;
        this.frameCount = 0;
        const runFrame = () => {
            this.runFrame(input);
            this.handle = requestAnimationFrame(runFrame);
        };
        this.handle = requestAnimationFrame(runFrame);
    }

    /** Resolves right after the next frame's work; at once when no load runs. */
    waitForFrameEnd(): Promise<void> {
        if (this.handle === undefined) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.frameEndWaiters.push(resolve));
    }

    stop(): FrameLoadObservation | undefined {
        if (this.handle === undefined) {
            return undefined;
        }
        cancelAnimationFrame(this.handle);
        this.handle = undefined;
        this.releaseFrameEndWaiters();
        const elapsedMs = performance.now() - this.startedAtMs;
        return {
            frameCount: this.frameCount,
            busyShare: Math.round((this.busyMs / elapsedMs) * 1000) / 1000
        };
    }

    private runFrame(input: FrameLoadInput): void {
        const frameStartMs = performance.now();
        if (frameStartMs < this.nextFrameAtMs) {
            return;
        }
        const busyUntilMs = frameStartMs + input.busyMsPerFrame;
        while (performance.now() < busyUntilMs) {
            // Busy-wait: the frame's main-thread work every durable round trip queues behind.
        }
        this.busyMs += performance.now() - frameStartMs;
        this.frameCount += 1;
        this.nextFrameAtMs = Math.max(this.nextFrameAtMs + input.frameIntervalMs, frameStartMs);
        this.releaseFrameEndWaiters();
    }

    private releaseFrameEndWaiters(): void {
        const waiters = this.frameEndWaiters;
        this.frameEndWaiters = [];
        waiters.forEach((resolve) => resolve());
    }
}
