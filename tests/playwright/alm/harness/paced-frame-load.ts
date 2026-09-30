import type { FrameLoadInput, FrameLoadObservation } from './durable-send-harness-contract.ts';

export interface FramePhase {
    /** Offset from the current frame's start; undefined when no load runs. */
    readonly offsetMs: number | undefined;
    readonly framesStarted: number;
}

interface ScheduledSend {
    readonly offsetMs: number;
    readonly action: () => void;
}

/**
 * Busy main-thread work in a `requestAnimationFrame` loop, paced by a fixed frame clock: each frame
 * that starts burns `busyMsPerFrame` of every `frameIntervalMs` (the observation reports the measured
 * busy share). Headless Chromium has no display vsync, so frames are not aligned to one; their
 * lateness against the clock is recorded instead of assumed away.
 *
 * `runAtFrameOffset` starts a send at a chosen offset from the start of the next frame, from inside
 * that frame's busy work when the offset falls within it, so a run samples a chosen mix of phases.
 */
export class PacedFrameLoad {
    private handle: number | undefined;
    private gapTimer: ReturnType<typeof setTimeout> | undefined;
    private scheduledSend: ScheduledSend | undefined;
    private nextFrameAtMs = 0;
    private startedAtMs = 0;
    private currentFrameStartMs = 0;
    private busyMs = 0;
    private frameCount = 0;
    private frameLatenessMs: number[] = [];

    start(input: FrameLoadInput): void {
        this.startedAtMs = performance.now();
        this.nextFrameAtMs = this.startedAtMs;
        this.busyMs = 0;
        this.frameCount = 0;
        this.frameLatenessMs = [];
        const runFrame = () => {
            this.runFrame(input);
            this.handle = requestAnimationFrame(runFrame);
        };
        this.handle = requestAnimationFrame(runFrame);
    }

    /** Runs `action` at once when no load runs. */
    runAtFrameOffset(offsetMs: number, action: () => void): void {
        if (this.handle === undefined) {
            action();
            return;
        }
        this.scheduledSend = { offsetMs, action };
    }

    readFramePhase(atMs: number): FramePhase {
        return {
            offsetMs: this.handle === undefined ? undefined : atMs - this.currentFrameStartMs,
            framesStarted: this.frameCount
        };
    }

    countFramesStarted(): number {
        return this.frameCount;
    }

    stop(): FrameLoadObservation | undefined {
        if (this.handle === undefined) {
            return undefined;
        }
        cancelAnimationFrame(this.handle);
        clearTimeout(this.gapTimer);
        this.handle = undefined;
        this.scheduledSend = undefined;
        const elapsedMs = performance.now() - this.startedAtMs;
        return {
            frameCount: this.frameCount,
            busyShare: Math.round((this.busyMs / elapsedMs) * 1000) / 1000,
            frameLatenessMs: this.frameLatenessMs
        };
    }

    private runFrame(input: FrameLoadInput): void {
        const frameStartMs = performance.now();
        if (frameStartMs < this.nextFrameAtMs) {
            return;
        }
        if (this.frameCount > 0) {
            this.frameLatenessMs.push(frameStartMs - this.nextFrameAtMs);
        }
        this.currentFrameStartMs = frameStartMs;
        this.frameCount += 1;
        this.nextFrameAtMs = Math.max(this.nextFrameAtMs + input.frameIntervalMs, frameStartMs);
        const unstarted = this.burnBusyTime(frameStartMs, input.busyMsPerFrame);
        this.busyMs += performance.now() - frameStartMs;
        if (unstarted !== undefined) {
            const delayMs = unstarted.offsetMs - (performance.now() - frameStartMs);
            this.gapTimer = setTimeout(unstarted.action, Math.max(0, delayMs));
        }
    }

    /** Burns the frame's busy time, starting the scheduled send when its offset is reached; returns it if the frame ended first. */
    private burnBusyTime(frameStartMs: number, busyMs: number): ScheduledSend | undefined {
        let pending = this.scheduledSend;
        this.scheduledSend = undefined;
        while (performance.now() - frameStartMs < busyMs) {
            if (pending !== undefined && performance.now() - frameStartMs >= pending.offsetMs) {
                const { action } = pending;
                pending = undefined;
                action();
            }
        }
        return pending;
    }
}
