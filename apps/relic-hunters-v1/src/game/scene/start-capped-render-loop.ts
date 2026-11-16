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

type RenderLoopEngine = Pick<Engine, 'runRenderLoop' | 'stopRenderLoop'> & {
    readonly performanceMonitor: Pick<PerformanceMonitor, 'reset'>;
};

export interface StartCappedRenderLoopInput {
    readonly engine: RenderLoopEngine;
    readonly gpu: GpuFenceContext | null;
    readonly frameIntervalMs: number;
    readonly renderFrame: CappedFrameLoop.Dependencies['renderFrame'];
}

/** Babylon owns callback delivery; the shared loop owns capping, invalidation and cancellation. */
export function startCappedRenderLoop(input: StartCappedRenderLoopInput): CappedFrameLoop {
    const driver = new GpuPacedFrameDriver(input.engine, input.gpu);
    const loop = new CappedFrameLoop({
        driver,
        nowMs: () => performance.now(),
        renderFrame: () => driver.drawFrame(input.renderFrame)
    }, { frameIntervalMs: input.frameIntervalMs });
    loop.start();
    return loop;
}

/**
 * Keeps at most one drawn frame waiting in the GPU process. Animation frames do not wait for the GPU, so a
 * software-rendered scene otherwise queues several frames there, and a synchronous WebGL call such as the context
 * teardown when the page unloads waits for that whole queue. An animation frame held back for the GPU never reaches
 * the loop, so the wait costs one animation frame and leaves the cap's timing alone.
 */
class GpuPacedFrameDriver implements CappedFrameLoop.Driver {
    private readonly engine: RenderLoopEngine;
    private readonly gpu: GpuFenceContext | null;
    private previousFrame: WebGLSync | null = null;
    private scheduledFrame: (() => void) | null = null;
    private readonly animationFrame = () => this.deliverAnimationFrame();

    constructor(engine: RenderLoopEngine, gpu: GpuFenceContext | null) {
        this.engine = engine;
        this.gpu = gpu;
    }

    start(frame: () => void): void {
        this.scheduledFrame = frame;
        this.engine.runRenderLoop(this.animationFrame);
    }

    stop(): void {
        this.engine.stopRenderLoop(this.animationFrame);
        this.scheduledFrame = null;
    }

    resetTiming(): void {
        this.engine.performanceMonitor.reset();
    }

    drawFrame(renderFrame: () => 'ready' | 'pending'): 'ready' | 'pending' {
        if (!this.readPreviousFrameExecuted()) {
            return 'pending';
        }
        const result = renderFrame();
        if (this.gpu !== null) {
            this.previousFrame = this.gpu.fenceSync(this.gpu.SYNC_GPU_COMMANDS_COMPLETE, 0);
            this.gpu.flush();
        }
        return result;
    }

    private deliverAnimationFrame(): void {
        if (this.readPreviousFrameExecuted()) {
            this.scheduledFrame?.();
        }
    }

    private readPreviousFrameExecuted(): boolean {
        if (this.gpu === null || this.previousFrame === null) {
            return true;
        }
        const status = this.gpu.getSyncParameter(this.previousFrame, this.gpu.SYNC_STATUS);
        if (status === this.gpu.UNSIGNALED) {
            return false;
        }
        // A sync of a lost context reads null, also after a restore, and has nothing left to delete.
        if (status === this.gpu.SIGNALED) {
            this.gpu.deleteSync(this.previousFrame);
        }
        this.previousFrame = null;
        return true;
    }
}
