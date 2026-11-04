import { type Engine } from '@babylonjs/core/Engines/engine.js';

import { CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

export interface StartCappedRenderLoopInput {
    readonly engine: Engine;
    readonly frameIntervalMs: number;
    readonly renderFrame: CappedFrameLoop.Dependencies['renderFrame'];
}

/** Babylon owns callback delivery; the shared loop owns capping, invalidation and cancellation. */
export function startCappedRenderLoop(input: StartCappedRenderLoopInput): CappedFrameLoop {
    const loop = new CappedFrameLoop({
        driver: {
            start: (frame) => input.engine.runRenderLoop(frame),
            stop: (frame) => input.engine.stopRenderLoop(frame),
            resetTiming: () => input.engine.performanceMonitor.reset()
        },
        nowMs: () => performance.now(),
        renderFrame: input.renderFrame
    }, { frameIntervalMs: input.frameIntervalMs });
    loop.start();
    return loop;
}
