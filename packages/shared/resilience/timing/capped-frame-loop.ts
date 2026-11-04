export namespace CappedFrameLoop {
    export interface Driver {
        /** Register future frame delivery; registration itself does not invoke the frame. */
        start(frame: () => void): void;
        stop(frame: () => void): void;
        resetTiming(): void;
    }

    export interface Dependencies {
        readonly driver: Driver;
        readonly nowMs: () => number;
        readonly renderFrame: () => 'ready' | 'pending';
    }

    export interface Config {
        readonly frameIntervalMs: number;
    }
}

export class CappedFrameLoop {
    private readonly dependencies: CappedFrameLoop.Dependencies;
    private readonly config: CappedFrameLoop.Config;
    private running = false;
    private disposed = false;
    private continuous = true;
    private dirty = true;
    private drawing = false;
    private invalidationVersion = 0;
    private lastFrameMs = 0;
    private readonly scheduledFrame = () => this.drawScheduledFrame();

    constructor(dependencies: CappedFrameLoop.Dependencies, config: CappedFrameLoop.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    start(): void {
        if (this.disposed || this.running || this.drawing) {
            return;
        }
        this.drawFrame();
        this.startScheduling();
    }

    pauseWhenReady(): void {
        if (this.disposed || !this.continuous) {
            return;
        }
        this.continuous = false;
        this.invalidationVersion += 1;
        this.dirty = true;
        this.startScheduling();
    }

    invalidate(): void {
        if (this.disposed) {
            return;
        }
        this.dirty = true;
        this.invalidationVersion += 1;
        if (!this.running && !this.drawing) {
            this.dependencies.driver.resetTiming();
            this.drawFrame();
            this.startScheduling();
        }
    }

    resume(): void {
        if (this.disposed || this.continuous) {
            return;
        }
        this.continuous = true;
        this.dependencies.driver.resetTiming();
        if (!this.running && !this.drawing) {
            this.drawFrame();
            this.startScheduling();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.stopScheduling();
    }

    private startScheduling(): void {
        if (this.running || this.disposed || (!this.continuous && !this.dirty)) {
            return;
        }
        this.running = true;
        this.dependencies.driver.start(this.scheduledFrame);
    }

    private stopScheduling(): void {
        if (this.running) {
            this.running = false;
            this.dependencies.driver.stop(this.scheduledFrame);
        }
    }

    private drawScheduledFrame(): void {
        if (!this.running || this.disposed) {
            return;
        }
        if (this.dependencies.nowMs() - this.lastFrameMs < this.config.frameIntervalMs) {
            return;
        }
        this.drawFrame();
    }

    private drawFrame(): void {
        this.lastFrameMs = this.dependencies.nowMs();
        const version = this.invalidationVersion;
        this.drawing = true;
        try {
            this.dirty = this.dependencies.renderFrame() === 'pending' || version !== this.invalidationVersion;
        }
        catch (error) {
            this.dispose();
            throw error;
        }
        finally {
            this.drawing = false;
        }
        if (!this.continuous && !this.dirty) {
            this.stopScheduling();
        }
    }
}
