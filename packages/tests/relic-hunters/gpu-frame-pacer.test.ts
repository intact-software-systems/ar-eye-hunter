import { describe, expect, it } from 'vitest';

import { GpuFramePacer } from '../../../apps/relic-hunters-v1/src/game/scene/gpu-frame-pacer.ts';

interface FakeFence {
    signaled: boolean;
    deleted: boolean;
}

class FakeFenceContext implements GpuFramePacer.Context {
    readonly SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
    readonly SYNC_STATUS = 0x9114;
    readonly SIGNALED = 0x9119;
    readonly fences = new Map<WebGLSync, FakeFence>();
    flushes = 0;
    lost = false;

    fenceSync(): WebGLSync {
        const sync: WebGLSync = {};
        this.fences.set(sync, { signaled: false, deleted: false });
        return sync;
    }

    getSyncParameter(sync: WebGLSync): number | null {
        if (this.lost) {
            return null;
        }
        return this.fences.get(sync)?.signaled ? this.SIGNALED : 0x9118;
    }

    deleteSync(sync: WebGLSync | null): void {
        const fence = sync ? this.fences.get(sync) : undefined;
        if (fence) {
            fence.deleted = true;
        }
    }

    flush(): void {
        this.flushes += 1;
    }

    isContextLost(): boolean {
        return this.lost;
    }

    signalAll(): void {
        for (const fence of this.fences.values()) {
            fence.signaled = true;
        }
    }
}

function countingFrame(): { readonly draws: () => number; readonly renderFrame: () => 'ready'; } {
    let draws = 0;
    return {
        draws: () => draws,
        renderFrame: () => {
            draws += 1;
            return 'ready';
        }
    };
}

describe('GPU frame pacing', () => {
    it('submits a frame only after the GPU has executed the previous one', () => {
        const context = new FakeFenceContext();
        const pacer = new GpuFramePacer(context);
        const frame = countingFrame();

        expect(pacer.drawFrame(frame.renderFrame)).toBe('ready');
        expect(frame.draws()).toBe(1);
        expect(context.flushes).toBe(1);

        expect(pacer.drawFrame(frame.renderFrame)).toBe('pending');
        expect(pacer.drawFrame(frame.renderFrame)).toBe('pending');
        expect(frame.draws()).toBe(1);

        context.signalAll();
        expect(pacer.drawFrame(frame.renderFrame)).toBe('ready');
        expect(frame.draws()).toBe(2);
        expect([...context.fences.values()].map((fence) => fence.deleted)).toEqual([true, false]);
    });

    it('passes on the frame result so an unready image keeps the loop drawing', () => {
        const context = new FakeFenceContext();
        const pacer = new GpuFramePacer(context);

        expect(pacer.drawFrame(() => 'pending')).toBe('pending');
        context.signalAll();
        expect(pacer.drawFrame(() => 'ready')).toBe('ready');
    });

    it('does not wait on a fence of a lost context', () => {
        const context = new FakeFenceContext();
        const pacer = new GpuFramePacer(context);
        const frame = countingFrame();
        pacer.drawFrame(frame.renderFrame);

        context.lost = true;
        expect(pacer.drawFrame(frame.renderFrame)).toBe('ready');
        expect(frame.draws()).toBe(2);
    });
});
