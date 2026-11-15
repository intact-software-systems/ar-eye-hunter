import { type Engine } from '@babylonjs/core/Engines/engine.js';
import { type PerformanceMonitor } from '@babylonjs/core/Misc/performanceMonitor.js';

import { CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

import { GpuFramePacer } from './gpu-frame-pacer.ts';

export interface StartCappedRenderLoopInput {
    readonly engine: Pick<Engine, 'runRenderLoop' | 'stopRenderLoop'> & {
        readonly performanceMonitor: Pick<PerformanceMonitor, 'reset'>;
    };
    /** The scene's WebGL2 context; null where the browser offers no fences and frames go unpaced. */
    readonly gpu: GpuFramePacer.Context | null;
    readonly frameIntervalMs: number;
    readonly renderFrame: CappedFrameLoop.Dependencies['renderFrame'];
}

/** Babylon owns callback delivery; the shared loop owns capping, invalidation and cancellation. */
export function startCappedRenderLoop(input: StartCappedRenderLoopInput): CappedFrameLoop {
    const pacer = input.gpu === null ? null : new GpuFramePacer(input.gpu);
    const loop = new CappedFrameLoop({
        driver: {
            start: (frame) => input.engine.runRenderLoop(frame),
            stop: (frame) => input.engine.stopRenderLoop(frame),
            resetTiming: () => input.engine.performanceMonitor.reset()
        },
        nowMs: () => performance.now(),
        renderFrame: pacer === null ? input.renderFrame : () => pacer.drawFrame(input.renderFrame)
    }, { frameIntervalMs: input.frameIntervalMs });
    loop.start();
    return loop;
}
