export namespace GpuFramePacer {
    export type Context = Pick<
        WebGL2RenderingContext,
        | 'deleteSync'
        | 'fenceSync'
        | 'flush'
        | 'getSyncParameter'
        | 'isContextLost'
        | 'SIGNALED'
        | 'SYNC_GPU_COMMANDS_COMPLETE'
        | 'SYNC_STATUS'
    >;
}

/**
 * Keeps at most one drawn frame waiting in the GPU process. Animation frames do not wait for the GPU, so a
 * software-rendered scene otherwise queues several frames there, and every synchronous WebGL call — the context
 * teardown when the page unloads, another tab's shader link — waits for that whole queue.
 */
export class GpuFramePacer {
    private readonly context: GpuFramePacer.Context;
    private previousFrame: WebGLSync | null = null;

    constructor(context: GpuFramePacer.Context) {
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
        const executed = this.context.isContextLost() ||
            this.context.getSyncParameter(this.previousFrame, this.context.SYNC_STATUS) === this.context.SIGNALED;
        if (executed) {
            this.context.deleteSync(this.previousFrame);
            this.previousFrame = null;
        }
        return executed;
    }
}
