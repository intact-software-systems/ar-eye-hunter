import type { Engine } from '@babylonjs/core/Engines/engine.js';

export function startCappedRenderLoop(
    engine: Engine,
    frameIntervalMs: number,
    renderFrame: () => void
): void {
    renderFrame();
    let lastFrameMs = performance.now();
    engine.runRenderLoop(() => {
        const now = performance.now();
        if (now - lastFrameMs < frameIntervalMs) {
            return;
        }
        lastFrameMs = now;
        renderFrame();
    });
}
