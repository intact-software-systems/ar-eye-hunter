import '@babylonjs/core/Culling/ray.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Scene } from '@babylonjs/core/scene.js';

import { type RelicActionInput, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

import { type RelicSceneProps } from '../../relic-scene.tsx';
import { ROOM_ROAM_SPRINT_SPEED, ROOM_ROAM_WALK_SPEED } from '../motionTuning.ts';
import { RELIC_NEON_THEME } from '../neonTheme.ts';
import {
    broadcastLocalPosition,
    createRelicMotionState,
    type RelicMotionPhase,
    type RelicMotionRuntimeState
} from '../networking.ts';
import {
    type RelicCameraMode
} from '../relic-scene-model.ts';
import { type ScenePrompt } from '../types.ts';
import { computeRelicTerminalPresentationKey } from './compute-relic-terminal-presentation-key.ts';
import { createFirstPersonRig, syncAvatars, type AvatarBundle, type FirstPersonRig } from './relic-avatars.ts';
import {
    ensureCameraModeHasPlayer,
    isAvatarCameraMode,
    readReducedMotionPreference,
    readStoredCameraMode,
    resolveDefaultCameraMode,
    updateCamera
} from './relic-camera.ts';
import { createWorldBase, rebuildFacility, updateRoomHighlights, type RoomBundle } from './relic-facility.ts';
import { createFacilityMaterials, type FacilityMaterials } from './relic-materials.ts';
import { syncRelics, updateRelicMeshes, type RelicBundle, type RelicPickupPrompt } from './relic-relics.ts';
import { updateSceneEffects, type SceneEffect } from './relic-review-effects.ts';
import {
    syncReviewPlayback,
    updateReviewPlayback,
    type ReviewAvatarMotion,
    type ReviewPlaybackState
} from './relic-review.ts';
import { updateCameraYawFromKeys } from './relic-scene-input.ts';
import { updatePromptForSelection, type PointerLookState } from './relic-scene-input.ts';
import { clamp, ROOM_HALF_ROAM } from './relic-scene-space.ts';
import { updateAvatarPositions } from './update-avatar-positions.ts';

const RELIC_SCENE_FLYOVER_DURATION_MS = 6200;
const RELIC_SCENE_REDUCED_FLYOVER_DURATION_MS = 650;

interface RelicSceneGraphics {
    readonly canvas: HTMLCanvasElement;
    readonly engine: Engine;
    readonly scene: Scene;
    readonly camera: UniversalCamera;
    readonly glow: GlowLayer;
    readonly materials: FacilityMaterials;
    readonly firstPersonRig: FirstPersonRig;
    readonly initialCameraMode: RelicCameraMode;
    readonly reducedMotion: boolean;
}

export namespace RelicSceneRuntime {
    export interface Input extends RelicSceneProps {
        readonly canvas: HTMLCanvasElement;
        onPromptChange(prompt: ScenePrompt | undefined): void;
        onPickupPromptChange(prompt: RelicPickupPrompt | undefined): void;
        onCameraModeChange(mode: RelicCameraMode): void;
    }
}

export class RelicSceneRuntime {
    cameraYaw: { value: number; } = { value: Math.PI * 0.18 };
    cameraPitch: { value: number; } = { value: -0.06 };
    pointerLook: PointerLookState = { active: false, pointerId: undefined, lastX: 0, lastY: 0 };
    flyoverStartedAtMs: { value?: number; } = { value: undefined };
    motionPhase: { value: RelicMotionPhase; } = { value: 'idle' };
    motion: RelicMotionRuntimeState = createRelicMotionState();
    roamOffset: Vector3 = new Vector3(0, 0, 0);
    roamRoomId: { value?: string; } = { value: undefined };
    pressedKeys: Set<string> = new Set();
    rooms: Map<string, RoomBundle> = new Map();
    avatars: Map<string, AvatarBundle> = new Map();
    relics: Map<string, RelicBundle> = new Map();
    effects: SceneEffect[] = [];
    review: ReviewPlaybackState = {
        key: undefined,
        queue: [],
        index: 0,
        cueStartedAtMs: undefined,
        completed: false,
        notifiedKey: undefined
    };
    reviewAvatarMotions: Map<string, ReviewAvatarMotion> = new Map();
    nearbyRelic: { value?: RelicPickupPrompt; } = { value: undefined };
    transientMeshes: Mesh[] = [];
    mapKey: { value?: string; } = { value: undefined };
    pulsePhase: { value: number; } = { value: 0 };
    canvas: HTMLCanvasElement;
    engine: Engine;
    scene: Scene;
    camera: UniversalCamera;
    glow: GlowLayer;
    materials: FacilityMaterials;
    snapshot: { value: RelicPublicSnapshot; };
    localPlayerId: { value: string | undefined; };
    selectedRoomId: { value: string | undefined; };
    primedAction: { value: RelicActionInput | undefined; };
    focusRoomId: { value: string | undefined; };
    rtcReady: { value: boolean; };
    inputEnabled: { value: boolean; };
    cameraMode: { value: RelicCameraMode; };
    previousCameraMode: { value: RelicCameraMode; };
    flyoverDurationMs: { value: number; };
    reducedMotion: { value: boolean; };
    firstPersonRig: FirstPersonRig;
    onSelectRoom: { value(roomId: string): void; };
    onPrimeAction: { value: (action: RelicActionInput) => void; };
    onPickupRelic: { value: (relicId: string) => void; };
    onPromptChange: { value(prompt?: ScenePrompt): void; };
    onPickupPromptChange: { value(prompt?: RelicPickupPrompt): void; };
    onCameraModeChange: { value(mode: RelicCameraMode): void; };
    reviewDirector: { value: boolean; };
    onReviewPlaybackComplete: { value: () => void; };
    renderCount = 0;
    terminal = false;
    terminalKey: string | undefined;

    constructor(input: RelicSceneRuntime.Input, graphics: RelicSceneGraphics) {
        this.canvas = graphics.canvas;
        this.engine = graphics.engine;
        this.scene = graphics.scene;
        this.camera = graphics.camera;
        this.glow = graphics.glow;
        this.materials = graphics.materials;
        this.snapshot = { value: input.snapshot };
        this.localPlayerId = { value: input.localPlayerId };
        this.selectedRoomId = { value: input.selectedRoomId };
        this.primedAction = { value: input.primedAction };
        this.focusRoomId = { value: input.focusRoomId };
        this.rtcReady = { value: input.rtcReady };
        this.inputEnabled = { value: input.inputEnabled };
        this.cameraMode = { value: graphics.initialCameraMode };
        this.previousCameraMode = {
            value: graphics.initialCameraMode === 'flyover' ? 'overview' : graphics.initialCameraMode
        };
        this.flyoverDurationMs = {
            value: graphics.reducedMotion
                ? RELIC_SCENE_REDUCED_FLYOVER_DURATION_MS
                : RELIC_SCENE_FLYOVER_DURATION_MS
        };
        this.reducedMotion = { value: graphics.reducedMotion };
        this.firstPersonRig = graphics.firstPersonRig;
        this.onSelectRoom = { value: input.onSelectRoom };
        this.onPrimeAction = { value: input.onPrimeAction };
        this.onPickupRelic = { value: input.onPickupRelic };
        this.onPromptChange = { value: input.onPromptChange };
        this.onPickupPromptChange = { value: input.onPickupPromptChange };
        this.onCameraModeChange = { value: input.onCameraModeChange };
        this.reviewDirector = { value: input.reviewDirector };
        this.onReviewPlaybackComplete = { value: input.onReviewPlaybackComplete };
    }
}

export function createRelicSceneRuntime(input: RelicSceneRuntime.Input): RelicSceneRuntime {
    const { canvas } = input;
    const engine = new Engine(canvas, true, {
        adaptToDeviceRatio: true,
        antialias: true,
        preserveDrawingBuffer: true,
        stencil: true
    });
    try {
        return createRelicSceneOnEngine(input, engine);
    }
    catch (error) {
        engine.dispose();
        throw error;
    }
}

function createRelicSceneOnEngine(input: RelicSceneRuntime.Input, engine: Engine): RelicSceneRuntime {
    const { canvas, snapshot, localPlayerId } = input;
    engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));
    const scene = new Scene(engine);
    scene.clearColor = Color4.FromHexString('#07111fff');
    scene.ambientColor = Color3.FromHexString('#8fcfff');
    scene.imageProcessingConfiguration.exposure = 1.22;
    scene.imageProcessingConfiguration.contrast = 1.08;

    const camera = new UniversalCamera('relic-next-camera', new Vector3(-15, 18, -22), scene);
    camera.fov = 0.78;
    camera.minZ = 0.1;
    camera.maxZ = 220;
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;

    const glow = createRelicSceneLighting(scene);
    const materials = createFacilityMaterials(scene);
    const initialCameraMode = resolveDefaultCameraMode(snapshot, localPlayerId, readStoredCameraMode());
    const runtime = new RelicSceneRuntime(input, {
        canvas,
        engine,
        scene,
        camera,
        glow,
        materials,
        initialCameraMode,
        reducedMotion: readReducedMotionPreference(),
        firstPersonRig: createFirstPersonRig(scene, camera, materials)
    });
    runtime.terminalKey = computeRelicTerminalPresentationKey(input.snapshot);
    runtime.terminal = runtime.terminalKey !== undefined;
    runtime.inputEnabled.value = input.inputEnabled && !runtime.terminal;
    createWorldBase(runtime);
    syncRelicSceneSnapshot(runtime);
    return runtime;
}

function createRelicSceneLighting(scene: Scene): GlowLayer {
    const hemi = new HemisphericLight('neon-dystopia-hemi', new Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.96;
    hemi.diffuse = Color3.FromHexString('#b6f7ff');
    hemi.groundColor = Color3.FromHexString('#22334a');

    const key = new DirectionalLight('neon-dystopia-key', new Vector3(-0.35, -0.88, -0.42), scene);
    key.intensity = 1.65;
    key.diffuse = Color3.FromHexString('#bafcff');

    const fill = new PointLight('neon-dystopia-fill', new Vector3(0, 10, -10), scene);
    fill.intensity = 28;
    fill.range = 54;
    fill.diffuse = Color3.FromHexString(RELIC_NEON_THEME.cyanSoft);

    const glow = new GlowLayer('neon-dystopia-glow', scene);
    glow.intensity = 0.55;
    glow.blurKernelSize = 48;

    return glow;
}

export function syncRelicSceneSnapshot(runtime: RelicSceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const mapKey = JSON.stringify(snapshot.map);
    if (mapKey !== runtime.mapKey.value) {
        rebuildFacility(runtime, snapshot);
        runtime.mapKey.value = mapKey;
    }
    syncRelics(runtime, snapshot);
    syncReviewPlayback(runtime, snapshot);
    syncAvatars(runtime, snapshot);
    ensureCameraModeHasPlayer(runtime);
    updateRoomHighlights(runtime);
    updatePromptForSelection(runtime, runtime.selectedRoomId.value);
}

export function updateRelicSceneMotion(runtime: RelicSceneRuntime): void {
    runtime.pulsePhase.value += Math.min(MAX_DT_SECONDS, runtime.engine.getDeltaTime() / 1000);
    updateLocalRoam(runtime);
    updateAvatarPositions(runtime);
    updateRelicMeshes(runtime);
    updateReviewPlayback(runtime);
    updateSceneEffects(runtime);
    updateCamera(runtime);
    if (runtime.snapshot.value?.phase !== 'review') {
        void broadcastLocalPosition(runtime);
    }
}

function updateLocalRoam(runtime: RelicSceneRuntime): void {
    updateCameraYawFromKeys(runtime);
    const snapshot = runtime.snapshot.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === runtime.localPlayerId.value);
    if (
        !snapshot ||
        !localPlayer ||
        localPlayer.escaped ||
        localPlayer.defeated ||
        snapshot.phase === 'lobby' ||
        snapshot.phase === 'review'
    ) {
        runtime.motionPhase.value = 'idle';
        return;
    }
    if (!isAvatarCameraMode(runtime.cameraMode.value)) {
        runtime.motionPhase.value = 'idle';
        return;
    }
    const rawRight = (runtime.pressedKeys.has('d') || runtime.pressedKeys.has('arrowright') ? 1 : 0) -
        (runtime.pressedKeys.has('a') || runtime.pressedKeys.has('arrowleft') ? 1 : 0);
    const rawForward = (runtime.pressedKeys.has('w') || runtime.pressedKeys.has('arrowup') ? 1 : 0) -
        (runtime.pressedKeys.has('s') || runtime.pressedKeys.has('arrowdown') ? 1 : 0);
    const forward = new Vector3(Math.sin(runtime.cameraYaw.value), 0, Math.cos(runtime.cameraYaw.value));
    const right = new Vector3(Math.cos(runtime.cameraYaw.value), 0, -Math.sin(runtime.cameraYaw.value));
    const direction = new Vector3(
        right.x * rawRight + forward.x * rawForward,
        0,
        right.z * rawRight + forward.z * rawForward
    );
    if (direction.lengthSquared() <= 0.0001) {
        runtime.motionPhase.value = 'idle';
        return;
    }
    direction.normalize();
    const sprinting = runtime.pressedKeys.has('shift');
    const dt = Math.min(MAX_DT_SECONDS, runtime.engine.getDeltaTime() / 1000);
    const speed = sprinting ? ROOM_ROAM_SPRINT_SPEED : ROOM_ROAM_WALK_SPEED;
    runtime.roamOffset.addInPlace(direction.scale(speed * dt));
    runtime.roamOffset.x = clamp(runtime.roamOffset.x, -ROOM_HALF_ROAM, ROOM_HALF_ROAM);
    runtime.roamOffset.z = clamp(runtime.roamOffset.z, -ROOM_HALF_ROAM, ROOM_HALF_ROAM);
    runtime.motionPhase.value = sprinting ? 'sprint' : 'walk';
}

const MAX_DT_SECONDS = 0.045;
