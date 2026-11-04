import { RELIC_MOTION_LANE_ID } from '../networking.ts';
import type { RelicFrameReadiness } from './read-relic-frame-readiness.ts';
import { isAvatarCameraMode } from './relic-camera.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';

export function writeDiagnostics(runtime: RelicSceneRuntime): void {
    const diagnostics = runtime.motion.diagnostics;
    runtime.canvas.dataset.sceneRuntime = 'next';
    runtime.canvas.dataset.sceneFirstPersonRig = String(runtime.firstPersonRig.root.isEnabled());
    const localAvatar = runtime.localPlayerId.value ? runtime.avatars.get(runtime.localPlayerId.value) : undefined;
    runtime.canvas.dataset.sceneLocalAvatarVisible = String(
        localAvatar?.parts.some((part) => part.isEnabled()) ?? false
    );
    runtime.canvas.dataset.sceneReady = 'true';
    runtime.canvas.dataset.sceneReadyMs = String(Math.round(performance.now()));
    runtime.canvas.dataset.sceneVisualTheme = 'neon-dystopian';
    runtime.canvas.dataset.assetPipeline = 'procedural';
    runtime.canvas.dataset.cameraMode = runtime.cameraMode.value;
    runtime.canvas.dataset.cameraControl = isAvatarCameraMode(runtime.cameraMode.value)
        ? `${runtime.cameraMode.value}:look`
        : runtime.cameraMode.value;
    runtime.canvas.dataset.lightingPreset = 'neon-dystopia';
    runtime.canvas.dataset.sceneMeshCount = String(runtime.scene.meshes.length);
    runtime.canvas.dataset.sceneActiveMeshCount = String(runtime.scene.getActiveMeshes().length);
    runtime.canvas.dataset.sceneMaterialCount = String(runtime.scene.materials.length);
    runtime.canvas.dataset.sceneParticleSystemCount = '0';
    runtime.canvas.dataset.sceneActiveParticleSystemCount = '0';
    runtime.canvas.dataset.sceneActiveRoomLightCount = String(runtime.rooms.size);
    runtime.canvas.dataset.sceneStaticBatchCount = '0';
    runtime.canvas.dataset.sceneBatchedMeshCount = '0';
    runtime.canvas.dataset.sceneActiveEffectCount = String(runtime.effects.length);
    runtime.canvas.dataset.sceneEffectMeshCount = String(
        runtime.effects.reduce((total, effect) => total + effect.meshes.length, 0)
    );
    runtime.canvas.dataset.reviewPlaybackState = runtime.review.key
        ? runtime.review.completed ? 'completed' : 'playing'
        : 'idle';
    runtime.canvas.dataset.reviewCueIndex = runtime.review.key
        ? `${Math.min(runtime.review.index + 1, runtime.review.queue.length)}/${runtime.review.queue.length}`
        : 'none';
    runtime.canvas.dataset.nearbyRelicId = runtime.nearbyRelic.value?.relicId ?? 'none';
    runtime.canvas.dataset.rallarMotionLane = RELIC_MOTION_LANE_ID;
    runtime.canvas.dataset.rallarMotionReadyPeers = String(diagnostics.readyPeerCount);
    runtime.canvas.dataset.rallarMotionLaneReady = diagnostics.laneReady ? 'true' : 'false';
    runtime.canvas.dataset.rallarMotionSampleAgeMs = diagnostics.lastSampleAgeMs === undefined
        ? 'none'
        : String(Math.round(diagnostics.lastSampleAgeMs));
    runtime.canvas.dataset.rallarMotionEstimateMode = diagnostics.lastEstimateMode ?? 'none';
    runtime.canvas.dataset.rallarMotionConfidence = diagnostics.lastConfidence === undefined
        ? 'none'
        : diagnostics.lastConfidence.toFixed(2);
    runtime.canvas.dataset.rallarMotionLastSendStatus = diagnostics.lastSendStatus ?? 'idle';
}

export function clearSceneDiagnostics(canvas: HTMLCanvasElement): void {
    delete canvas.dataset.sceneRuntime;
    delete canvas.dataset.sceneFirstPersonRig;
    delete canvas.dataset.sceneLocalAvatarVisible;
    delete canvas.dataset.sceneReady;
    delete canvas.dataset.sceneRenderCount;
    delete canvas.dataset.sceneRenderedMs;
    delete canvas.dataset.scenePendingMeshes;
    delete canvas.dataset.scenePendingGlowMeshes;
    delete canvas.dataset.scenePendingGlowComposition;
    delete canvas.dataset.scenePendingCamera;
    delete canvas.dataset.scenePendingData;
    delete canvas.dataset.sceneReadyMs;
    delete canvas.dataset.sceneVisualTheme;
    delete canvas.dataset.assetPipeline;
    delete canvas.dataset.cameraMode;
    delete canvas.dataset.cameraControl;
    delete canvas.dataset.lightingPreset;
    delete canvas.dataset.sceneMeshCount;
    delete canvas.dataset.sceneActiveMeshCount;
    delete canvas.dataset.sceneMaterialCount;
    delete canvas.dataset.sceneParticleSystemCount;
    delete canvas.dataset.sceneActiveParticleSystemCount;
    delete canvas.dataset.sceneActiveRoomLightCount;
    delete canvas.dataset.sceneStaticBatchCount;
    delete canvas.dataset.sceneBatchedMeshCount;
    delete canvas.dataset.sceneActiveEffectCount;
    delete canvas.dataset.sceneEffectMeshCount;
    delete canvas.dataset.reviewPlaybackState;
    delete canvas.dataset.reviewCueIndex;
    delete canvas.dataset.nearbyRelicId;
    delete canvas.dataset.rallarMotionLane;
    delete canvas.dataset.rallarMotionReadyPeers;
    delete canvas.dataset.rallarMotionLaneReady;
    delete canvas.dataset.rallarMotionSampleAgeMs;
    delete canvas.dataset.rallarMotionEstimateMode;
    delete canvas.dataset.rallarMotionConfidence;
    delete canvas.dataset.rallarMotionLastSendStatus;
}

export function writeRelicFrameObservation(
    runtime: RelicSceneRuntime,
    readiness: RelicFrameReadiness,
    ready: boolean
): void {
    runtime.renderCount += 1;
    runtime.canvas.dataset.sceneRenderCount = String(runtime.renderCount);
    runtime.canvas.dataset.sceneRenderedMs = String(Math.round(performance.now()));
    runtime.canvas.dataset.sceneReady = String(ready);
    runtime.canvas.dataset.scenePendingMeshes = String(readiness.pendingMeshes);
    runtime.canvas.dataset.scenePendingGlowMeshes = String(readiness.pendingGlowMeshes);
    runtime.canvas.dataset.scenePendingGlowComposition = String(readiness.pendingGlowComposition);
    runtime.canvas.dataset.scenePendingCamera = String(readiness.pendingCamera);
    runtime.canvas.dataset.scenePendingData = String(readiness.pendingData);
}
