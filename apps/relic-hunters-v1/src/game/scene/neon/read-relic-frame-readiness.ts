import type { RelicSceneRuntime } from './relic-scene-runtime.ts';

export interface RelicFrameReadiness {
    readonly meshKey: string;
    readonly pendingMeshes: number;
    readonly pendingGlowMeshes: number;
    readonly pendingGlowComposition: boolean;
    readonly pendingCamera: boolean;
    readonly pendingData: number;
    readonly ready: boolean;
}

/** Active meshes include visible geometry whose material draw was skipped; off-camera variants cannot affect this image. */
export function readRelicFrameReadiness(runtime: RelicSceneRuntime): RelicFrameReadiness {
    const meshes = runtime.scene.getActiveMeshes();
    const currentPass = runtime.engine.currentRenderPassId;
    const meshIds: number[] = [];
    let pendingMeshes = 0;
    let pendingGlowMeshes = 0;
    const glowVisible = runtime.glow.shouldRender();
    try {
        runtime.engine.currentRenderPassId = runtime.camera.renderPassId;
        for (let index = 0; index < meshes.length; index += 1) {
            const mesh = meshes.data[index];
            meshIds.push(mesh.uniqueId);
            if (!mesh.isReady(true)) {
                pendingMeshes += 1;
            }
            if (!glowVisible || !runtime.glow.hasMesh(mesh)) {
                continue;
            }
            runtime.engine.currentRenderPassId = runtime.glow.mainTexture.renderPassId;
            for (const subMesh of mesh.subMeshes ?? []) {
                // This procedural renderer creates no instances or thin instances.
                if (!runtime.glow.isReady(subMesh, false)) {
                    pendingGlowMeshes += 1;
                }
            }
            runtime.engine.currentRenderPassId = runtime.camera.renderPassId;
        }
    }
    finally {
        runtime.engine.currentRenderPassId = currentPass;
    }
    const pendingGlowComposition = glowVisible && !runtime.glow.isLayerReady();
    const pendingCamera = !runtime.camera.isReady(true);
    const pendingData = runtime.scene.getWaitingItemsCount();
    return {
        meshKey: meshIds.join(','),
        pendingMeshes,
        pendingGlowMeshes,
        pendingGlowComposition,
        pendingCamera,
        pendingData,
        ready: pendingMeshes === 0 && pendingGlowMeshes === 0 && !pendingGlowComposition && !pendingCamera &&
            pendingData === 0
    };
}
