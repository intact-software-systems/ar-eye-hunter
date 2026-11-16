import { type Engine } from '@babylonjs/core/Engines/engine.js';
import { type PerformanceMonitor } from '@babylonjs/core/Misc/performanceMonitor.js';

import { CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

type GpuFenceContext = Pick<
    WebGL2RenderingContext,
    | 'deleteSync'
    | 'fenceSync'
    | 'flush'
    | 'getSyncParameter'
    | 'SIGNALED'
    | 'SYNC_GPU_COMMANDS_COMPLETE'
    | 'SYNC_STATUS'
    | 'UNSIGNALED'
>;

export interface StartCappedRenderLoopInput {
    readonly engine: Pick<Engine, 'runRenderLoop' | 'stopRenderLoop'> & {
        readonly performanceMonitor: Pick<PerformanceMonitor, 'reset'>;
    };
    /** The scene's WebGL2 context; null where the browser offers no fences and frames go unpaced. */
    readonly gpu: GpuFenceContext | null;
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

/**
 * Keeps at most one drawn frame waiting in the GPU process. Animation frames do not wait for the GPU, so a
 * software-rendered scene otherwise queues several frames there, and a synchronous WebGL call such as the context
 * teardown when the page unloads waits for that whole queue.
 */
class GpuFramePacer {
    private readonly context: GpuFenceContext;
    private previousFrame: WebGLSync | null = null;

    constructor(context: GpuFenceContext) {
        this.context = context;
    }

    drawFrame(renderFrame: () => 'ready' | 'pending'): 'ready' | 'pending' {
        if (!this.readPreviousFrameExecuted()) {
            return 'pending';
        }
        const result = renderFrame();
        this.previousFrame = this.context.fenceSync(this.context.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this.context.flush();
        return result;
    }

    private readPreviousFrameExecuted(): boolean {
        if (this.previousFrame === null) {
            return true;
        }
        const status = this.context.getSyncParameter(this.previousFrame, this.context.SYNC_STATUS);
        if (status === this.context.UNSIGNALED) {
            return false;
        }
        // A sync of a lost context reads null, also after a restore, and has nothing left to delete.
        if (status === this.context.SIGNALED) {
            this.context.deleteSync(this.previousFrame);
        }
        this.previousFrame = null;
        return true;
    }
}
