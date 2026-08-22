import { useEffect, useMemo, useRef, useState } from 'react';
import '@babylonjs/core/Culling/ray.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type {
    RelicActionInput,
    RelicAnimationCue,
    RelicCharacter,
    RelicDefinition,
    RelicEvent,
    RelicPlayer,
    RelicPublicSnapshot,
    RelicRoom
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { ROOM_ROAM_SPRINT_SPEED, ROOM_ROAM_WALK_SPEED } from './scene/motionTuning.ts';
import { sceneMoveActionForPickedRoom } from './scene/movement.ts';
import { RELIC_NEON_THEME, relicNeonAccentForRoom } from './scene/neonTheme.ts';
import {
    broadcastLocalPosition,
    createRelicMotionState,
    isRelicMotionEstimateFreshForPlayer,
    RELIC_MOTION_LANE_ID,
    subscribeRelicScenePositionUpdates,
    type RelicMotionPhase,
    type RelicMotionRuntimeState
} from './scene/networking.ts';
import { deriveSceneObjective } from './scene/objectives.ts';
import { directionBetweenRooms } from './scene/prompts.ts';
import {
    blackHumourSignForRoom,
    facilityRoomCallsign,
    facilityRoomPosition,
    NEON_ROOM_GRID_SCALE,
    planNeonAvatarCameraPose,
    planNeonFirstPersonCameraPose,
    planNeonFlyoverCameraPose,
    planNeonOverviewCameraPose,
    planNeonTacticalCameraPose,
    RELIC_SCENE_NEXT_CAMERA_MODES,
    RELIC_SCENE_NEXT_FLYOVER_DURATION_MS,
    RELIC_SCENE_NEXT_REDUCED_FLYOVER_DURATION_MS,
    type RelicSceneNextCameraMode
} from './scene/relicSceneNextModel.ts';
import { startCappedRenderLoop } from './scene/renderLoop.ts';
import { SceneInteractionPrompt } from './scene/SceneInteractionPrompt.tsx';
import { SceneObjectivePanel } from './scene/SceneObjectivePanel.tsx';
import type { ScenePrompt } from './scene/types.ts';

const FRAME_INTERVAL_MS = 1000 / 45;
const ROOM_FLOOR_SIZE = 12.4;
const ROOM_HALF_ROAM = 5.0;
const PICKUP_RADIUS = 1.55;
const AVATAR_Y = 0.72;
const CAMERA_SMOOTHING = 0.12;
const MAX_DT_SECONDS = 0.045;
const REVIEW_CUE_GAP_MS = 160;
const CAMERA_MODE_STORAGE_KEY = 'relic.sceneNext.cameraMode';
const POINTER_LOOK_SENSITIVITY = 0.006;
const KEYBOARD_LOOK_STEP = 0.055;

const VIEW_CONTROLS: readonly {
    mode: RelicSceneNextCameraMode;
    label: string;
    shortLabel: string;
    ariaLabel: string;
}[] = [
    { mode: 'avatar', label: 'Avatar', shortLabel: '3rd', ariaLabel: 'Avatar view' },
    { mode: 'first-person', label: 'Visor', shortLabel: '1st', ariaLabel: 'First-person view' },
    { mode: 'overview', label: 'Overview', shortLabel: 'Map', ariaLabel: 'Overview view' },
    { mode: 'flyover', label: 'Flyover', shortLabel: 'Fly', ariaLabel: 'Fly over rooms' }
];

export type RelicSceneNextProps = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    primedAction?: RelicActionInput;
    focusRoomId?: string;
    rtcReady?: boolean;
    inputEnabled?: boolean;
    reviewDirector?: boolean;
    onSelectRoom(roomId: string): void;
    onPrimeAction?(action: RelicActionInput): void;
    onPickupRelic?(relicId: string): void;
    onReviewPlaybackComplete?(): void;
}>;

type FacilityMaterials = Readonly<{
    floor: PBRMaterial;
    floorPanel: PBRMaterial;
    wall: PBRMaterial;
    glass: PBRMaterial;
    corridor: PBRMaterial;
    cyan: PBRMaterial;
    magenta: PBRMaterial;
    violet: PBRMaterial;
    amber: PBRMaterial;
    green: PBRMaterial;
    danger: PBRMaterial;
    white: PBRMaterial;
    avatarCore: PBRMaterial;
}>;

type RoomBundle = {
    roomId: string;
    root: TransformNode;
    floor: Mesh;
    accent: PBRMaterial;
    light: PointLight;
    dynamicMeshes: Mesh[];
};

type AvatarBundle = {
    playerId: string;
    root: TransformNode;
    parts: Mesh[];
    ring: Mesh;
    label: Mesh;
    labelTexture: DynamicTexture;
    trail: Mesh;
    target: Vector3;
    lastPosition: Vector3;
    lastMovedAtMs: number;
};

type FirstPersonRig = {
    root: TransformNode;
    parts: Mesh[];
};

type RelicBundle = {
    relicId: string;
    roomId: string;
    root: TransformNode;
    parts: Mesh[];
    label: Mesh;
    labelTexture: DynamicTexture;
    baseY: number;
};

type RelicPickupPrompt = Readonly<{
    relicId: string;
    name: string;
    value: number;
}>;

type SceneEffect = {
    id: string;
    startedAtMs: number;
    durationMs: number;
    meshes: Mesh[];
    update(progress: number): void;
    dispose(): void;
};

type ReviewPlaybackCue = Readonly<{
    eventId: string;
    event: RelicEvent;
    cue: RelicAnimationCue;
    durationMs: number;
}>;

type ReviewAvatarMotion = Readonly<{
    playerId: string;
    from: Vector3;
    to: Vector3;
    startedAtMs: number;
    durationMs: number;
}>;

type ReviewPlaybackState = {
    key?: string;
    queue: ReviewPlaybackCue[];
    index: number;
    cueStartedAtMs?: number;
    completed: boolean;
    notifiedKey?: string;
};

type PointerLookState = {
    active: boolean;
    pointerId?: number;
    lastX: number;
    lastY: number;
};

type RelicSceneNextRuntime = {
    canvas: HTMLCanvasElement;
    engine: Engine;
    scene: Scene;
    camera: UniversalCamera;
    glow: GlowLayer;
    materials: FacilityMaterials;
    snapshot: { value?: RelicPublicSnapshot; };
    localPlayerId: { value?: string; };
    selectedRoomId: { value?: string; };
    primedAction: { value?: RelicActionInput; };
    focusRoomId: { value?: string; };
    objectiveTargetRoomId: { value?: string; };
    rtcReady: { value: boolean; };
    inputEnabled: { value: boolean; };
    cameraMode: { value: RelicSceneNextCameraMode; };
    previousCameraMode: { value: RelicSceneNextCameraMode; };
    cameraYaw: { value: number; };
    cameraPitch: { value: number; };
    pointerLook: PointerLookState;
    flyoverStartedAtMs: { value?: number; };
    flyoverDurationMs: { value: number; };
    reducedMotion: { value: boolean; };
    motionPhase: { value: RelicMotionPhase; };
    motion: RelicMotionRuntimeState;
    firstPersonRig: FirstPersonRig;
    roamOffset: Vector3;
    roamRoomId: { value?: string; };
    pressedKeys: Set<string>;
    rooms: Map<string, RoomBundle>;
    avatars: Map<string, AvatarBundle>;
    relics: Map<string, RelicBundle>;
    effects: SceneEffect[];
    review: ReviewPlaybackState;
    reviewAvatarMotions: Map<string, ReviewAvatarMotion>;
    nearbyRelic: { value?: RelicPickupPrompt; };
    transientMeshes: Mesh[];
    mapKey: { value?: string; };
    pulsePhase: { value: number; };
    onSelectRoom: { value(roomId: string): void; };
    onPrimeAction: { value?: (action: RelicActionInput) => void; };
    onPickupRelic: { value?: (relicId: string) => void; };
    onPromptChange: { value(prompt?: ScenePrompt): void; };
    onPickupPromptChange: { value(prompt?: RelicPickupPrompt): void; };
    onCameraModeChange: { value(mode: RelicSceneNextCameraMode): void; };
    reviewDirector: { value: boolean; };
    onReviewPlaybackComplete: { value?: () => void; };
};

export function RelicSceneNext({
    snapshot,
    localPlayerId,
    selectedRoomId,
    primedAction,
    focusRoomId,
    rtcReady = false,
    inputEnabled = true,
    reviewDirector = false,
    onSelectRoom,
    onPrimeAction,
    onPickupRelic,
    onReviewPlaybackComplete
}: RelicSceneNextProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<RelicSceneNextRuntime | undefined>(undefined);
    const [sceneError, setSceneError] = useState<string | undefined>();
    const [scenePrompt, setScenePrompt] = useState<ScenePrompt | undefined>();
    const [pickupPrompt, setPickupPrompt] = useState<RelicPickupPrompt | undefined>();
    const [cameraMode, setCameraModeState] = useState<RelicSceneNextCameraMode>(() =>
        readStoredCameraMode() ?? resolveDefaultCameraMode(snapshot, localPlayerId)
    );
    const snapshotRef = useRef(snapshot);
    const localPlayerIdRef = useRef(localPlayerId);
    const selectedRoomIdRef = useRef(selectedRoomId);
    const primedActionRef = useRef(primedAction);
    const focusRoomIdRef = useRef(focusRoomId);
    const rtcReadyRef = useRef(rtcReady);
    const inputEnabledRef = useRef(inputEnabled);
    const reviewDirectorRef = useRef(reviewDirector);
    const onSelectRoomRef = useRef(onSelectRoom);
    const onPrimeActionRef = useRef(onPrimeAction);
    const onPickupRelicRef = useRef(onPickupRelic);
    const onReviewPlaybackCompleteRef = useRef(onReviewPlaybackComplete);
    const objective = useMemo(
        () => deriveSceneObjective({ snapshot, localPlayerId, primedAction }),
        [localPlayerId, primedAction, snapshot]
    );

    useEffect(() => {
        snapshotRef.current = snapshot;
        if (runtimeRef.current) {
            runtimeRef.current.snapshot.value = snapshot;
            syncNextRuntime(runtimeRef.current);
        }
    }, [snapshot]);

    useEffect(() => {
        localPlayerIdRef.current = localPlayerId;
        if (runtimeRef.current) {
            runtimeRef.current.localPlayerId.value = localPlayerId;
            ensureCameraModeHasPlayer(runtimeRef.current);
        }
    }, [localPlayerId]);

    useEffect(() => {
        selectedRoomIdRef.current = selectedRoomId;
        if (runtimeRef.current) {
            runtimeRef.current.selectedRoomId.value = selectedRoomId;
            updateRoomHighlights(runtimeRef.current);
        }
    }, [selectedRoomId]);

    useEffect(() => {
        primedActionRef.current = primedAction;
        if (runtimeRef.current) {
            runtimeRef.current.primedAction.value = primedAction;
        }
    }, [primedAction]);

    useEffect(() => {
        focusRoomIdRef.current = focusRoomId;
        if (runtimeRef.current) {
            runtimeRef.current.focusRoomId.value = focusRoomId;
        }
    }, [focusRoomId]);

    useEffect(() => {
        rtcReadyRef.current = rtcReady;
        if (runtimeRef.current) {
            runtimeRef.current.rtcReady.value = rtcReady;
        }
    }, [rtcReady]);

    useEffect(() => {
        inputEnabledRef.current = inputEnabled;
        if (runtimeRef.current) {
            runtimeRef.current.inputEnabled.value = inputEnabled;
        }
    }, [inputEnabled]);

    useEffect(() => {
        reviewDirectorRef.current = reviewDirector;
        if (runtimeRef.current) {
            runtimeRef.current.reviewDirector.value = reviewDirector;
        }
    }, [reviewDirector]);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }
        runtime.cameraMode.value = cameraMode;
        if (cameraMode !== 'flyover') {
            runtime.previousCameraMode.value = cameraMode;
        }
        persistCameraMode(cameraMode);
    }, [cameraMode]);

    useEffect(() => {
        onSelectRoomRef.current = onSelectRoom;
        if (runtimeRef.current) {
            runtimeRef.current.onSelectRoom.value = onSelectRoom;
        }
    }, [onSelectRoom]);

    useEffect(() => {
        onPrimeActionRef.current = onPrimeAction;
        if (runtimeRef.current) {
            runtimeRef.current.onPrimeAction.value = onPrimeAction;
        }
    }, [onPrimeAction]);

    useEffect(() => {
        onPickupRelicRef.current = onPickupRelic;
        if (runtimeRef.current) {
            runtimeRef.current.onPickupRelic.value = onPickupRelic;
        }
    }, [onPickupRelic]);

    useEffect(() => {
        onReviewPlaybackCompleteRef.current = onReviewPlaybackComplete;
        if (runtimeRef.current) {
            runtimeRef.current.onReviewPlaybackComplete.value = onReviewPlaybackComplete;
        }
    }, [onReviewPlaybackComplete]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        let runtime: RelicSceneNextRuntime;
        try {
            runtime = createNextRuntime({
                canvas,
                snapshot: snapshotRef.current,
                localPlayerId: localPlayerIdRef.current,
                selectedRoomId: selectedRoomIdRef.current,
                primedAction: primedActionRef.current,
                focusRoomId: focusRoomIdRef.current,
                rtcReady: rtcReadyRef.current,
                inputEnabled: inputEnabledRef.current,
                reviewDirector: reviewDirectorRef.current,
                onSelectRoom: onSelectRoomRef.current,
                onPrimeAction: onPrimeActionRef.current,
                onPickupRelic: onPickupRelicRef.current,
                onPromptChange: setScenePrompt,
                onPickupPromptChange: setPickupPrompt,
                onCameraModeChange: setCameraModeState,
                onReviewPlaybackComplete: onReviewPlaybackCompleteRef.current
            });
            runtimeRef.current = runtime;
            setCameraModeState(runtime.cameraMode.value);
            setSceneError(undefined);
        }
        catch (error) {
            setSceneError(error instanceof Error ? error.message : String(error));
            return;
        }

        const resize = () => runtime.engine.resize();
        const keydown = (event: KeyboardEvent) => {
            if (!runtime.inputEnabled.value || isTypingTarget(event.target)) {
                return;
            }
            const key = event.key.toLowerCase();
            if (key === 'e' && runtime.nearbyRelic.value) {
                runtime.onPickupRelic.value?.(runtime.nearbyRelic.value.relicId);
                canvas.focus();
                event.preventDefault();
                return;
            }
            if (isCameraModeCycleKey(key)) {
                cycleRuntimeCameraMode(runtime);
                canvas.focus();
                event.preventDefault();
                return;
            }
            if (isFlyoverKey(key)) {
                setRuntimeCameraMode(runtime, 'flyover');
                canvas.focus();
                event.preventDefault();
                return;
            }
            if (isCameraRotateKey(key)) {
                runtime.pressedKeys.add(key);
                canvas.focus();
                event.preventDefault();
                return;
            }
            if (isMoveKey(key)) {
                runtime.pressedKeys.add(key);
                canvas.focus();
                event.preventDefault();
            }
        };
        const keyup = (event: KeyboardEvent) => {
            runtime.pressedKeys.delete(event.key.toLowerCase());
        };
        const pointerdown = (event: PointerEvent) => {
            if (!runtime.inputEnabled.value) {
                return;
            }
            canvas.focus();
            if (!cameraModeAcceptsLook(runtime.cameraMode.value)) {
                return;
            }
            runtime.pointerLook.active = true;
            runtime.pointerLook.pointerId = event.pointerId;
            runtime.pointerLook.lastX = event.clientX;
            runtime.pointerLook.lastY = event.clientY;
            canvas.setPointerCapture?.(event.pointerId);
        };
        const pointermove = (event: PointerEvent) => {
            if (document.pointerLockElement === canvas) {
                applyCameraLook(runtime, event.movementX, event.movementY);
                event.preventDefault();
                return;
            }
            if (!runtime.pointerLook.active || runtime.pointerLook.pointerId !== event.pointerId) {
                return;
            }
            applyCameraLook(
                runtime,
                event.clientX - runtime.pointerLook.lastX,
                event.clientY - runtime.pointerLook.lastY
            );
            runtime.pointerLook.lastX = event.clientX;
            runtime.pointerLook.lastY = event.clientY;
            event.preventDefault();
        };
        const pointerup = (event: PointerEvent) => {
            if (runtime.pointerLook.pointerId === event.pointerId) {
                runtime.pointerLook.active = false;
                runtime.pointerLook.pointerId = undefined;
                canvas.releasePointerCapture?.(event.pointerId);
            }
        };
        const pointerlockchange = () => {
            runtime.pointerLook.active = document.pointerLockElement === canvas;
        };

        runtime.scene.onPointerObservable.add((event) => {
            if (event.event.type !== 'pointerdown' || !runtime.inputEnabled.value) {
                return;
            }
            const metadata = event.pickInfo?.pickedMesh?.metadata as
                | Readonly<{ roomId?: unknown; primeAction?: unknown; relicId?: unknown; }>
                | undefined;
            if (typeof metadata?.relicId === 'string') {
                runtime.onPickupRelic.value?.(metadata.relicId);
                return;
            }
            if (metadata?.primeAction === 'search') {
                runtime.onPrimeAction.value?.({ kind: 'search' });
                return;
            }
            const roomId = metadata?.roomId;
            if (typeof roomId !== 'string') {
                return;
            }
            const move = sceneMoveActionForPickedRoom({
                snapshot: runtime.snapshot.value,
                localPlayerId: runtime.localPlayerId.value,
                roomId
            });
            runtime.onSelectRoom.value(roomId);
            runtime.selectedRoomId.value = roomId;
            updatePromptForSelection(runtime, roomId);
            updateRoomHighlights(runtime);
            if (move) {
                runtime.onPrimeAction.value?.(move);
            }
        });

        window.addEventListener('resize', resize);
        window.addEventListener('keydown', keydown);
        window.addEventListener('keyup', keyup);
        canvas.addEventListener('pointerdown', pointerdown);
        canvas.addEventListener('pointermove', pointermove);
        canvas.addEventListener('pointerup', pointerup);
        canvas.addEventListener('pointercancel', pointerup);
        document.addEventListener('pointerlockchange', pointerlockchange);

        startCappedRenderLoop(runtime.engine, FRAME_INTERVAL_MS, () => {
            updateNextRuntime(runtime);
            runtime.scene.render();
            writeDiagnostics(runtime);
        });

        return () => {
            window.removeEventListener('resize', resize);
            window.removeEventListener('keydown', keydown);
            window.removeEventListener('keyup', keyup);
            canvas.removeEventListener('pointerdown', pointerdown);
            canvas.removeEventListener('pointermove', pointermove);
            canvas.removeEventListener('pointerup', pointerup);
            canvas.removeEventListener('pointercancel', pointerup);
            document.removeEventListener('pointerlockchange', pointerlockchange);
            delete canvas.dataset.sceneRuntime;
            delete canvas.dataset.sceneReady;
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
            runtime.scene.dispose();
            runtime.engine.dispose();
            runtimeRef.current = undefined;
        };
    }, []);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!rtcReady || !runtime) {
            return;
        }
        return subscribeRelicScenePositionUpdates(runtime);
    }, [rtcReady]);

    if (sceneError) {
        return (
            <div className="relic-scene-fallback">
                <strong>Neon scene failed to boot.</strong>
                <span>{sceneError}</span>
            </div>
        );
    }

    return (
        <>
            <canvas
                ref={canvasRef}
                className="relic-scene relic-scene-next"
                data-scene-runtime="next"
                data-scene-visual-theme="neon-dystopian"
                tabIndex={0}
                aria-label="Relic Hunters neon cyber-dojo canvas"
            />
            <SceneViewControls
                mode={cameraMode}
                onChange={(mode) => {
                    const runtime = runtimeRef.current;
                    if (runtime) {
                        setRuntimeCameraMode(runtime, mode);
                    }
                    else {
                        setCameraModeState(mode);
                    }
                }}
            />
            <SceneObjectivePanel
                objective={{
                    ...objective,
                    eyebrow: objective.eyebrow === 'Expedition'
                        ? 'Compliance Quest'
                        : objective.eyebrow,
                    detail: dystopianObjectiveDetail(objective.detail)
                }}
                onPrimeAction={(action) => onPrimeAction?.(action)}
            />
            <SceneInteractionPrompt
                prompt={scenePrompt}
                onPrimeAction={(action) => onPrimeAction?.(action)}
            />
            <ScenePickupPrompt
                prompt={pickupPrompt}
                onPickup={(relicId) => onPickupRelic?.(relicId)}
            />
        </>
    );
}

function ScenePickupPrompt({
    prompt,
    onPickup
}: Readonly<{
    prompt?: RelicPickupPrompt;
    onPickup(relicId: string): void;
}>) {
    if (!prompt) {
        return null;
    }
    return (
        <div className="scene-pickup-prompt" role="status" aria-live="polite">
            <span>E Pick Up</span>
            <strong>{prompt.name}</strong>
            <small>{prompt.value} pts. Asset Management is already disappointed.</small>
            <button type="button" onClick={() => onPickup(prompt.relicId)}>
                Pick Up
            </button>
        </div>
    );
}

function SceneViewControls({
    mode,
    onChange
}: Readonly<{
    mode: RelicSceneNextCameraMode;
    onChange(mode: RelicSceneNextCameraMode): void;
}>) {
    return (
        <div className="scene-view-controls" role="group" aria-label="Scene view controls">
            {VIEW_CONTROLS.map((control) => (
                <button
                    key={control.mode}
                    type="button"
                    className={mode === control.mode ? 'active' : undefined}
                    aria-label={control.ariaLabel}
                    aria-pressed={mode === control.mode}
                    onClick={() => onChange(control.mode)}
                >
                    <span className="view-label-full">{control.label}</span>
                    <span className="view-label-short">{control.shortLabel}</span>
                </button>
            ))}
        </div>
    );
}

function setRuntimeCameraMode(runtime: RelicSceneNextRuntime, mode: RelicSceneNextCameraMode): void {
    const snapshot = runtime.snapshot.value;
    const hasLocalHunter = hasPlayableLocalHunter(snapshot, runtime.localPlayerId.value);
    const nextMode = (mode === 'avatar' || mode === 'first-person') && !hasLocalHunter ? 'overview' : mode;
    if (nextMode === 'flyover') {
        runtime.previousCameraMode.value = runtime.cameraMode.value === 'flyover'
            ? runtime.previousCameraMode.value
            : runtime.cameraMode.value;
        runtime.flyoverStartedAtMs.value = performance.now();
    }
    else {
        runtime.previousCameraMode.value = nextMode;
        runtime.flyoverStartedAtMs.value = undefined;
        persistCameraMode(nextMode);
    }
    runtime.cameraMode.value = nextMode;
    runtime.pointerLook.active = false;
    runtime.onCameraModeChange.value(nextMode);
}

function cycleRuntimeCameraMode(runtime: RelicSceneNextRuntime): void {
    const current = runtime.cameraMode.value === 'flyover'
        ? runtime.previousCameraMode.value
        : runtime.cameraMode.value;
    const available = RELIC_SCENE_NEXT_CAMERA_MODES.filter((mode) =>
        (mode !== 'avatar' && mode !== 'first-person') ||
        hasPlayableLocalHunter(runtime.snapshot.value, runtime.localPlayerId.value)
    );
    const index = Math.max(0, available.indexOf(current));
    setRuntimeCameraMode(runtime, available[(index + 1) % available.length] ?? 'overview');
}

function ensureCameraModeHasPlayer(runtime: RelicSceneNextRuntime): void {
    if (
        (runtime.cameraMode.value === 'avatar' || runtime.cameraMode.value === 'first-person') &&
        !hasPlayableLocalHunter(runtime.snapshot.value, runtime.localPlayerId.value)
    ) {
        setRuntimeCameraMode(runtime, 'overview');
    }
}

function resolveDefaultCameraMode(
    snapshot?: RelicPublicSnapshot,
    localPlayerId?: string,
    stored?: RelicSceneNextCameraMode
): RelicSceneNextCameraMode {
    if (stored && stored !== 'flyover') {
        if ((stored === 'avatar' || stored === 'first-person') && !hasPlayableLocalHunter(snapshot, localPlayerId)) {
            return 'overview';
        }
        return stored;
    }
    return hasPlayableLocalHunter(snapshot, localPlayerId) ? 'avatar' : 'overview';
}

function hasPlayableLocalHunter(snapshot?: RelicPublicSnapshot, localPlayerId?: string): boolean {
    if (!snapshot || snapshot.phase === 'lobby') {
        return false;
    }
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);
    return !!localPlayer && !localPlayer.escaped && !localPlayer.defeated;
}

function readStoredCameraMode(): RelicSceneNextCameraMode | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    const value = window.localStorage?.getItem(CAMERA_MODE_STORAGE_KEY);
    return isRelicSceneNextCameraMode(value) && value !== 'flyover' ? value : undefined;
}

function persistCameraMode(mode: RelicSceneNextCameraMode): void {
    if (typeof window === 'undefined' || mode === 'flyover') {
        return;
    }
    window.localStorage?.setItem(CAMERA_MODE_STORAGE_KEY, mode);
}

function isRelicSceneNextCameraMode(value: unknown): value is RelicSceneNextCameraMode {
    return value === 'avatar' || value === 'first-person' || value === 'overview' || value === 'flyover';
}

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function createNextRuntime({
    canvas,
    snapshot,
    localPlayerId,
    selectedRoomId,
    primedAction,
    focusRoomId,
    rtcReady,
    inputEnabled,
    reviewDirector,
    onSelectRoom,
    onPrimeAction,
    onPickupRelic,
    onPromptChange,
    onPickupPromptChange,
    onCameraModeChange,
    onReviewPlaybackComplete
}: Readonly<{
    canvas: HTMLCanvasElement;
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    primedAction?: RelicActionInput;
    focusRoomId?: string;
    rtcReady: boolean;
    inputEnabled: boolean;
    reviewDirector: boolean;
    onSelectRoom(roomId: string): void;
    onPrimeAction?: (action: RelicActionInput) => void;
    onPickupRelic?: (relicId: string) => void;
    onPromptChange(prompt?: ScenePrompt): void;
    onPickupPromptChange(prompt?: RelicPickupPrompt): void;
    onCameraModeChange(mode: RelicSceneNextCameraMode): void;
    onReviewPlaybackComplete?: () => void;
}>): RelicSceneNextRuntime {
    const engine = new Engine(canvas, true, {
        adaptToDeviceRatio: true,
        antialias: true,
        preserveDrawingBuffer: true,
        stencil: true
    });
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

    const materials = createFacilityMaterials(scene);
    const initialCameraMode = resolveDefaultCameraMode(snapshot, localPlayerId, readStoredCameraMode());
    const reducedMotion = prefersReducedMotion();
    const firstPersonRig = createFirstPersonRig(scene, camera, materials);
    const runtime: RelicSceneNextRuntime = {
        canvas,
        engine,
        scene,
        camera,
        glow,
        materials,
        snapshot: { value: snapshot },
        localPlayerId: { value: localPlayerId },
        selectedRoomId: { value: selectedRoomId },
        primedAction: { value: primedAction },
        focusRoomId: { value: focusRoomId },
        objectiveTargetRoomId: { value: undefined },
        rtcReady: { value: rtcReady },
        inputEnabled: { value: inputEnabled },
        cameraMode: { value: initialCameraMode },
        previousCameraMode: { value: initialCameraMode === 'flyover' ? 'overview' : initialCameraMode },
        cameraYaw: { value: Math.PI * 0.18 },
        cameraPitch: { value: -0.06 },
        pointerLook: { active: false, lastX: 0, lastY: 0 },
        flyoverStartedAtMs: { value: undefined },
        flyoverDurationMs: {
            value: reducedMotion ? RELIC_SCENE_NEXT_REDUCED_FLYOVER_DURATION_MS : RELIC_SCENE_NEXT_FLYOVER_DURATION_MS
        },
        reducedMotion: { value: reducedMotion },
        motionPhase: { value: 'idle' },
        motion: createRelicMotionState(),
        firstPersonRig,
        roamOffset: new Vector3(0, 0, 0),
        roamRoomId: { value: undefined },
        pressedKeys: new Set(),
        rooms: new Map(),
        avatars: new Map(),
        relics: new Map(),
        effects: [],
        review: {
            key: undefined,
            queue: [],
            index: 0,
            cueStartedAtMs: undefined,
            completed: false,
            notifiedKey: undefined
        },
        reviewAvatarMotions: new Map(),
        nearbyRelic: { value: undefined },
        transientMeshes: [],
        mapKey: { value: undefined },
        pulsePhase: { value: 0 },
        onSelectRoom: { value: onSelectRoom },
        onPrimeAction: { value: onPrimeAction },
        onPickupRelic: { value: onPickupRelic },
        onPromptChange: { value: onPromptChange },
        onPickupPromptChange: { value: onPickupPromptChange },
        onCameraModeChange: { value: onCameraModeChange },
        reviewDirector: { value: reviewDirector },
        onReviewPlaybackComplete: { value: onReviewPlaybackComplete }
    };

    createWorldBase(runtime);
    syncNextRuntime(runtime);
    writeDiagnostics(runtime);
    return runtime;
}

function syncNextRuntime(runtime: RelicSceneNextRuntime): void {
    const snapshot = runtime.snapshot.value;
    if (!snapshot) {
        clearFacility(runtime);
        clearRelics(runtime);
        resetReviewPlayback(runtime);
        return;
    }
    const mapKey = snapshot.map
        .map((room) =>
            [
                room.id,
                room.kind,
                room.x,
                room.z,
                room.neighbors.join(','),
                room.collapsed ? 'c' : '-',
                room.unstable ? 'u' : '-'
            ].join(':')
        )
        .join('|');
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

function createFacilityMaterials(scene: Scene): FacilityMaterials {
    return {
        floor: pbr(scene, 'next-floor', RELIC_NEON_THEME.floor, '#18344a', 0.26, 0.34, 0.22),
        floorPanel: pbr(scene, 'next-floor-panel', RELIC_NEON_THEME.floorPanel, '#20536b', 0.36, 0.42, 0.2),
        wall: pbr(scene, 'next-wall', RELIC_NEON_THEME.graphiteLift, '#101c2c', 0.15, 0.36, 0.45),
        glass: pbr(scene, 'next-hologlass', RELIC_NEON_THEME.glass, '#0e3447', 0.52, 0.05, 0.08, 0.34),
        corridor: pbr(scene, 'next-corridor', RELIC_NEON_THEME.graphite, '#152d40', 0.22, 0.48, 0.28),
        cyan: pbr(scene, 'next-cyan', '#07111f', RELIC_NEON_THEME.cyan, 1.55, 0.08, 0.18),
        magenta: pbr(scene, 'next-magenta', '#14091a', RELIC_NEON_THEME.magenta, 1.45, 0.08, 0.18),
        violet: pbr(scene, 'next-violet', '#100d20', RELIC_NEON_THEME.violet, 1.25, 0.12, 0.22),
        amber: pbr(scene, 'next-amber', '#181305', RELIC_NEON_THEME.amber, 1.25, 0.16, 0.2),
        green: pbr(scene, 'next-green', '#07180f', RELIC_NEON_THEME.green, 1.3, 0.1, 0.18),
        danger: pbr(scene, 'next-danger', '#19070c', RELIC_NEON_THEME.coral, 1.2, 0.08, 0.2),
        white: pbr(scene, 'next-white', '#0d1824', RELIC_NEON_THEME.white, 0.9, 0.08, 0.16),
        avatarCore: pbr(scene, 'next-avatar-core', '#172434', '#25445c', 0.12, 0.36, 0.38)
    };
}

function createFirstPersonRig(
    scene: Scene,
    camera: UniversalCamera,
    materials: FacilityMaterials
): FirstPersonRig {
    const root = new TransformNode('neon-visor-rig', scene);
    root.parent = camera;
    root.position.set(0, 0, 0);
    root.setEnabled(false);
    const parts: Mesh[] = [];
    const add = (mesh: Mesh, material: PBRMaterial) => {
        mesh.material = material;
        mesh.parent = root;
        parts.push(mesh);
        return mesh;
    };

    const leftHand = add(
        MeshBuilder.CreateBox('neon-visor-left-hand', { width: 0.22, height: 0.16, depth: 0.54 }, scene),
        materials.magenta
    );
    leftHand.position.set(-0.46, -0.44, 1.08);
    leftHand.rotation.set(0.18, -0.32, 0.28);

    const rightHand = add(
        MeshBuilder.CreateBox('neon-visor-right-hand', { width: 0.24, height: 0.16, depth: 0.62 }, scene),
        materials.cyan
    );
    rightHand.position.set(0.42, -0.48, 1.02);
    rightHand.rotation.set(0.18, 0.28, -0.22);

    const blade = add(
        MeshBuilder.CreateBox('neon-visor-katana-edge', { width: 0.045, height: 0.055, depth: 1.36 }, scene),
        materials.white
    );
    blade.position.set(0.64, -0.36, 1.55);
    blade.rotation.set(0.08, -0.35, 0.08);

    const scanner = add(
        MeshBuilder.CreateBox('neon-visor-compliance-scanner', { width: 0.34, height: 0.12, depth: 0.34 }, scene),
        materials.amber
    );
    scanner.position.set(-0.66, -0.36, 1.32);
    scanner.rotation.set(0.12, 0.3, -0.16);

    return { root, parts };
}

function createWorldBase(runtime: RelicSceneNextRuntime): void {
    const { scene, materials } = runtime;
    const baseSize = 240;
    const base = MeshBuilder.CreateGround(
        'neon-dystopia-base-grid',
        { width: baseSize, height: baseSize, subdivisions: 2 },
        scene
    );
    base.position.y = -0.06;
    base.material = materials.floor;

    for (let index = -8; index <= 8; index += 1) {
        const xStrip = MeshBuilder.CreateBox(
            `base-grid-x-${index}`,
            { width: 0.035, height: 0.018, depth: baseSize },
            scene
        );
        xStrip.position.set(index * NEON_ROOM_GRID_SCALE, 0.02, 0);
        xStrip.material = index === 0 ? materials.magenta : materials.cyan;
        const zStrip = MeshBuilder.CreateBox(
            `base-grid-z-${index}`,
            { width: baseSize, height: 0.018, depth: 0.035 },
            scene
        );
        zStrip.position.set(0, 0.022, index * NEON_ROOM_GRID_SCALE);
        zStrip.material = index === 0 ? materials.magenta : materials.cyan;
    }
}

function rebuildFacility(runtime: RelicSceneNextRuntime, snapshot: RelicPublicSnapshot): void {
    clearFacility(runtime);
    const roomById = new Map(snapshot.map.map((room) => [room.id, room]));

    for (const room of snapshot.map) {
        runtime.rooms.set(room.id, createRoomBundle(runtime, room));
    }

    const seenEdges = new Set<string>();
    for (const room of snapshot.map) {
        for (const neighborId of room.neighbors) {
            const neighbor = roomById.get(neighborId);
            if (!neighbor) {
                continue;
            }
            const key = [room.id, neighbor.id].sort().join(':');
            if (seenEdges.has(key)) {
                continue;
            }
            seenEdges.add(key);
            runtime.transientMeshes.push(...createCorridor(runtime, room, neighbor));
        }
    }
}

function clearFacility(runtime: RelicSceneNextRuntime): void {
    for (const bundle of runtime.rooms.values()) {
        bundle.light.dispose();
        bundle.accent.dispose();
        bundle.root.dispose();
    }
    runtime.rooms.clear();
    for (const mesh of runtime.transientMeshes) {
        mesh.dispose();
    }
    runtime.transientMeshes = [];
}

function clearRelics(runtime: RelicSceneNextRuntime): void {
    for (const bundle of runtime.relics.values()) {
        bundle.root.dispose();
        bundle.labelTexture.dispose();
    }
    runtime.relics.clear();
    runtime.nearbyRelic.value = undefined;
    runtime.onPickupPromptChange.value(undefined);
}

function syncRelics(runtime: RelicSceneNextRuntime, snapshot: RelicPublicSnapshot): void {
    const visibleRelics = snapshot.relics.filter((relic) => !relic.carriedBy && !relic.escapedBy);
    const visibleIds = new Set(visibleRelics.map((relic) => relic.id));
    for (const [relicId, bundle] of runtime.relics.entries()) {
        if (!visibleIds.has(relicId)) {
            bundle.root.dispose();
            bundle.labelTexture.dispose();
            runtime.relics.delete(relicId);
        }
    }

    for (const relic of visibleRelics) {
        const room = snapshot.map.find((candidate) => candidate.id === relic.roomId);
        if (!room || room.collapsed) {
            continue;
        }
        let bundle = runtime.relics.get(relic.id);
        if (!bundle) {
            bundle = createRelicBundle(runtime, relic, room);
            runtime.relics.set(relic.id, bundle);
        }
        bundle.roomId = relic.roomId;
        for (const part of bundle.parts) {
            part.metadata = { relicId: relic.id, roomId: relic.roomId };
        }
        updateRelicLabel(bundle, relic);
        const roomPosition = facilityRoomPosition(room);
        const localOffset = relicLocalOffset(relic);
        bundle.root.position.set(roomPosition.x + localOffset.x, bundle.baseY, roomPosition.z + localOffset.z);
        bundle.root.setEnabled(snapshot.phase === 'planning' || snapshot.phase === 'review');
    }
}

function createRelicBundle(
    runtime: RelicSceneNextRuntime,
    relic: RelicDefinition,
    room: RelicRoom
): RelicBundle {
    const root = new TransformNode(`facility-relic-${relic.id}`, runtime.scene);
    const parts: Mesh[] = [];
    const accentMaterial = relic.value >= 7
        ? runtime.materials.magenta
        : relic.value >= 4
        ? runtime.materials.amber
        : room.kind === 'monster' || room.kind === 'trap'
        ? runtime.materials.danger
        : runtime.materials.cyan;
    const add = (mesh: Mesh, material: PBRMaterial | StandardMaterial) => {
        mesh.material = material;
        mesh.parent = root;
        mesh.metadata = { relicId: relic.id, roomId: relic.roomId };
        parts.push(mesh);
        return mesh;
    };

    const pedestal = add(
        MeshBuilder.CreateCylinder(
            `facility-relic-${relic.id}-pedestal`,
            { diameter: 1.0, height: 0.42, tessellation: 8 },
            runtime.scene
        ),
        runtime.materials.wall
    );
    pedestal.position.y = -0.2;

    const ring = add(
        MeshBuilder.CreateTorus(
            `facility-relic-${relic.id}-pickup-ring`,
            { diameter: 1.34, thickness: 0.045, tessellation: 40 },
            runtime.scene
        ),
        accentMaterial
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;

    const core = add(
        MeshBuilder.CreateSphere(
            `facility-relic-${relic.id}-core`,
            { diameter: 0.54 + Math.min(0.28, relic.value * 0.025), segments: 16 },
            runtime.scene
        ),
        accentMaterial
    );
    core.position.y = 0.5;

    const shard = add(
        MeshBuilder.CreateBox(
            `facility-relic-${relic.id}-shard`,
            { width: 0.18, height: 0.98, depth: 0.18 },
            runtime.scene
        ),
        runtime.materials.white
    );
    shard.position.y = 0.78;
    shard.rotation.set(0.34, 0.44, 0.23);

    const labelTexture = new DynamicTexture(
        `facility-relic-${relic.id}-label-texture`,
        { width: 512, height: 160 },
        runtime.scene,
        false
    );
    const label = MeshBuilder.CreatePlane(
        `facility-relic-${relic.id}-label`,
        { width: 2.55, height: 0.8 },
        runtime.scene
    );
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.parent = root;
    label.position.y = 1.64;
    label.material = labelMaterial(runtime.scene, `facility-relic-${relic.id}-label-material`, labelTexture);
    label.metadata = { relicId: relic.id, roomId: relic.roomId };
    updateRelicLabel({ labelTexture }, relic);

    return {
        relicId: relic.id,
        roomId: relic.roomId,
        root,
        parts: [...parts, label],
        label,
        labelTexture,
        baseY: 0.68
    };
}

function updateRelicLabel(
    bundle: Pick<RelicBundle, 'labelTexture'>,
    relic: Pick<RelicDefinition, 'name' | 'value'>
): void {
    const ctx = bundle.labelTexture.getContext();
    ctx.clearRect(0, 0, 512, 160);
    ctx.fillStyle = 'rgba(4, 9, 21, 0.88)';
    ctx.fillRect(0, 0, 512, 160);
    ctx.strokeStyle = relic.value >= 7
        ? RELIC_NEON_THEME.magenta
        : relic.value >= 4
        ? RELIC_NEON_THEME.amber
        : RELIC_NEON_THEME.cyan;
    ctx.lineWidth = 5;
    ctx.strokeRect(5, 5, 502, 150);
    ctx.fillStyle = '#f8fdff';
    ctx.font = '800 28px monospace';
    wrapText(ctx, relic.name, 22, 42, 468, 30);
    ctx.fillStyle = '#ffe66d';
    ctx.font = '800 22px monospace';
    ctx.fillText(`${relic.value} PTS / DO NOT ENJOY`, 22, 134);
    bundle.labelTexture.update();
}

function relicLocalOffset(relic: Pick<RelicDefinition, 'id' | 'value'>): Readonly<{ x: number; z: number; }> {
    const hash = hashText(relic.id);
    const angle = (hash % 360) * Math.PI / 180;
    const radius = Math.min(ROOM_HALF_ROAM - 0.9, 2.15 + (hash % 7) * 0.24 + Math.min(0.7, relic.value * 0.04));
    return {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius
    };
}

function createRoomBundle(runtime: RelicSceneNextRuntime, room: RelicRoom): RoomBundle {
    const { scene, materials } = runtime;
    const root = new TransformNode(`facility-room-${room.id}`, scene);
    const position = facilityRoomPosition(room);
    root.position.set(position.x, 0, position.z);

    const accent = accentMaterialForRoom(scene, room);
    const skirt = MeshBuilder.CreateBox(
        `facility-room-${room.id}-skirt`,
        { width: ROOM_FLOOR_SIZE + 0.62, height: 0.7, depth: ROOM_FLOOR_SIZE + 0.62 },
        scene
    );
    skirt.position.y = -0.38;
    skirt.material = materials.wall;
    skirt.parent = root;

    const floor = MeshBuilder.CreateBox(
        `facility-room-${room.id}-floor`,
        { width: ROOM_FLOOR_SIZE, height: 0.24, depth: ROOM_FLOOR_SIZE },
        scene
    );
    floor.position.y = 0.08;
    floor.material = room.collapsed ? materials.danger : materials.floorPanel;
    floor.metadata = { roomId: room.id };
    floor.parent = root;

    const inset = MeshBuilder.CreateBox(
        `facility-room-${room.id}-inset`,
        { width: ROOM_FLOOR_SIZE - 1.2, height: 0.035, depth: ROOM_FLOOR_SIZE - 1.2 },
        scene
    );
    inset.position.y = 0.235;
    inset.material = accent;
    inset.metadata = { roomId: room.id };
    inset.parent = root;

    const railMeshes = createRoomRails(runtime, room, root, accent);
    const wallMeshes = createHologlassWalls(runtime, room, root);
    const sign = createRoomSign(runtime, room, root, accent);
    const searchKiosk = createSearchKiosk(runtime, room, root);
    const light = new PointLight(
        `facility-room-${room.id}-accent-light`,
        new Vector3(position.x, 3.2, position.z),
        scene
    );
    light.diffuse = Color3.FromHexString(relicNeonAccentForRoom(room).emissive);
    light.range = 18;
    light.intensity = room.collapsed ? 5 : room.unstable ? 10 : 7.4;

    return {
        roomId: room.id,
        root,
        floor,
        accent,
        light,
        dynamicMeshes: [...railMeshes, ...wallMeshes, sign, searchKiosk]
    };
}

function createRoomRails(
    runtime: RelicSceneNextRuntime,
    room: RelicRoom,
    root: TransformNode,
    accent: PBRMaterial
): Mesh[] {
    const meshes: Mesh[] = [];
    const add = (name: string, width: number, depth: number, x: number, z: number) => {
        const rail = MeshBuilder.CreateBox(name, { width, height: 0.07, depth }, runtime.scene);
        rail.position.set(x, 0.31, z);
        rail.material = accent;
        rail.metadata = { roomId: room.id };
        rail.parent = root;
        meshes.push(rail);
    };
    add(`facility-room-${room.id}-rail-n`, ROOM_FLOOR_SIZE, 0.08, 0, -ROOM_FLOOR_SIZE / 2);
    add(`facility-room-${room.id}-rail-s`, ROOM_FLOOR_SIZE, 0.08, 0, ROOM_FLOOR_SIZE / 2);
    add(`facility-room-${room.id}-rail-e`, 0.08, ROOM_FLOOR_SIZE, ROOM_FLOOR_SIZE / 2, 0);
    add(`facility-room-${room.id}-rail-w`, 0.08, ROOM_FLOOR_SIZE, -ROOM_FLOOR_SIZE / 2, 0);
    return meshes;
}

function createHologlassWalls(
    runtime: RelicSceneNextRuntime,
    room: RelicRoom,
    root: TransformNode
): Mesh[] {
    const meshes: Mesh[] = [];
    const wallHeight = 2.45;
    const wallY = 1.42;
    const doorGap = 3.35;
    const segmentLength = Math.max(1.8, (ROOM_FLOOR_SIZE - doorGap) / 2 - 0.28);
    const segmentOffset = doorGap / 2 + segmentLength / 2 + 0.08;

    const addSegment = (name: string, width: number, depth: number, x: number, z: number) => {
        const wall = MeshBuilder.CreateBox(name, { width, height: wallHeight, depth }, runtime.scene);
        wall.position.set(x, wallY, z);
        wall.material = runtime.materials.glass;
        wall.metadata = { roomId: room.id };
        wall.parent = root;
        meshes.push(wall);
    };

    addSegment(`facility-room-${room.id}-wall-n-left`, segmentLength, 0.08, -segmentOffset, -ROOM_FLOOR_SIZE / 2);
    addSegment(`facility-room-${room.id}-wall-n-right`, segmentLength, 0.08, segmentOffset, -ROOM_FLOOR_SIZE / 2);
    addSegment(`facility-room-${room.id}-wall-s-left`, segmentLength, 0.08, -segmentOffset, ROOM_FLOOR_SIZE / 2);
    addSegment(`facility-room-${room.id}-wall-s-right`, segmentLength, 0.08, segmentOffset, ROOM_FLOOR_SIZE / 2);
    addSegment(`facility-room-${room.id}-wall-e-top`, 0.08, segmentLength, ROOM_FLOOR_SIZE / 2, -segmentOffset);
    addSegment(`facility-room-${room.id}-wall-e-bottom`, 0.08, segmentLength, ROOM_FLOOR_SIZE / 2, segmentOffset);
    addSegment(`facility-room-${room.id}-wall-w-top`, 0.08, segmentLength, -ROOM_FLOOR_SIZE / 2, -segmentOffset);
    addSegment(`facility-room-${room.id}-wall-w-bottom`, 0.08, segmentLength, -ROOM_FLOOR_SIZE / 2, segmentOffset);

    for (const [index, z] of [-doorGap, doorGap].entries()) {
        const rail = MeshBuilder.CreateBox(
            `facility-room-${room.id}-ceiling-rail-${index}`,
            { width: ROOM_FLOOR_SIZE - 0.6, height: 0.06, depth: 0.08 },
            runtime.scene
        );
        rail.position.set(0, 2.86, z);
        rail.material = runtime.materials.white;
        rail.parent = root;
        meshes.push(rail);
    }
    return meshes;
}

function createRoomSign(
    runtime: RelicSceneNextRuntime,
    room: RelicRoom,
    root: TransformNode,
    accent: PBRMaterial
): Mesh {
    const signBack = MeshBuilder.CreateBox(
        `facility-room-${room.id}-sign-back`,
        { width: 3.7, height: 1.04, depth: 0.08 },
        runtime.scene
    );
    signBack.position.set(0, 2.34, -ROOM_FLOOR_SIZE / 2 - 0.05);
    signBack.material = accent;
    signBack.metadata = { roomId: room.id };
    signBack.parent = root;

    const sign = MeshBuilder.CreatePlane(`facility-room-${room.id}-sign`, { width: 3.46, height: 0.82 }, runtime.scene);
    sign.position.set(0, 2.34, -ROOM_FLOOR_SIZE / 2 - 0.11);
    sign.rotation.y = Math.PI;
    sign.material = createTextMaterial(runtime.scene, `sign-${room.id}`, {
        title: facilityRoomCallsign(room),
        detail: blackHumourSignForRoom(room),
        accent: relicNeonAccentForRoom(room).emissive
    });
    sign.metadata = { roomId: room.id };
    sign.parent = root;
    return signBack;
}

function createSearchKiosk(
    runtime: RelicSceneNextRuntime,
    room: RelicRoom,
    root: TransformNode
): Mesh {
    const kiosk = MeshBuilder.CreateBox(
        `facility-room-${room.id}-kiosk`,
        { width: 0.72, height: 0.82, depth: 0.42 },
        runtime.scene
    );
    kiosk.position.set(-ROOM_FLOOR_SIZE / 2 + 0.86, 0.68, ROOM_FLOOR_SIZE / 2 - 0.9);
    kiosk.material = room.kind === 'trap' || room.unstable ? runtime.materials.danger : runtime.materials.cyan;
    kiosk.metadata = { roomId: room.id, primeAction: 'search' };
    kiosk.parent = root;
    return kiosk;
}

function createCorridor(
    runtime: RelicSceneNextRuntime,
    from: RelicRoom,
    to: RelicRoom
): Mesh[] {
    const a = facilityRoomPosition(from);
    const b = facilityRoomPosition(to);
    const mid = Vector3.Center(a, b);
    const dx = Math.abs(a.x - b.x);
    const dz = Math.abs(a.z - b.z);
    const alongX = dx >= dz;
    const length = Math.max(1.1, (alongX ? dx : dz) - ROOM_FLOOR_SIZE + 0.9);
    const floor = MeshBuilder.CreateBox(
        `facility-corridor-${from.id}-${to.id}`,
        {
            width: alongX ? length : 3.25,
            height: 0.18,
            depth: alongX ? 3.25 : length
        },
        runtime.scene
    );
    floor.position.set(mid.x, 0.12, mid.z);
    floor.material = runtime.materials.corridor;
    floor.metadata = { roomId: to.id };

    const seam = MeshBuilder.CreateBox(
        `facility-corridor-${from.id}-${to.id}-seam`,
        {
            width: alongX ? length : 0.12,
            height: 0.05,
            depth: alongX ? 0.12 : length
        },
        runtime.scene
    );
    seam.position.set(mid.x, 0.27, mid.z);
    seam.material = from.unstable || to.unstable ? runtime.materials.danger : runtime.materials.cyan;
    seam.metadata = { roomId: to.id };
    return [floor, seam];
}

function syncAvatars(runtime: RelicSceneNextRuntime, snapshot: RelicPublicSnapshot): void {
    const activePlayerIds = new Set(snapshot.players.map((player) => player.playerId));
    for (const [playerId, avatar] of runtime.avatars.entries()) {
        if (!activePlayerIds.has(playerId)) {
            avatar.root.dispose();
            runtime.avatars.delete(playerId);
        }
    }

    for (const player of snapshot.players) {
        if (!runtime.avatars.has(player.playerId)) {
            runtime.avatars.set(player.playerId, createAvatarBundle(runtime, player));
        }
        const avatar = runtime.avatars.get(player.playerId)!;
        updateAvatarLabel(avatar, findRelicCharacter(player.characterId), player);
        avatar.target.copyFrom(snapshotPositionForPlayer(snapshot, player));
        if (player.escaped || player.defeated) {
            avatar.root.setEnabled(false);
        }
        else {
            avatar.root.setEnabled(true);
        }
    }

    const localPlayer = snapshot.players.find((player) => player.playerId === runtime.localPlayerId.value);
    if (localPlayer && runtime.roamRoomId.value !== localPlayer.roomId) {
        runtime.roamRoomId.value = localPlayer.roomId;
        runtime.roamOffset.set(0, 0, 0);
        runtime.motion.buffer.remove(localPlayer.playerId);
        runtime.motion.kinematics.remove(localPlayer.playerId);
    }
}

function createAvatarBundle(runtime: RelicSceneNextRuntime, player: RelicPlayer): AvatarBundle {
    const character = findRelicCharacter(player.characterId);
    const root = new TransformNode(`neon-ronin-${player.playerId}`, runtime.scene);
    const accent = character.colors.accent;
    const accentMaterial = standard(runtime.scene, `ronin-${player.playerId}-accent`, '#06111f', accent, 1.2);
    const visorMaterial = standard(
        runtime.scene,
        `ronin-${player.playerId}-visor`,
        '#041018',
        RELIC_NEON_THEME.cyanSoft,
        1.4
    );
    const armorMaterial = runtime.materials.avatarCore;
    const parts: Mesh[] = [];
    const add = (mesh: Mesh, material: StandardMaterial | PBRMaterial) => {
        mesh.material = material;
        mesh.parent = root;
        parts.push(mesh);
        return mesh;
    };

    const torso = add(
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-torso`,
            { width: 0.82, height: 1.18, depth: 0.42 },
            runtime.scene
        ),
        armorMaterial
    );
    torso.position.y = 0.92;

    const chestTrim = add(
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-chest-trim`,
            { width: 0.9, height: 0.08, depth: 0.46 },
            runtime.scene
        ),
        accentMaterial
    );
    chestTrim.position.y = 1.22;

    const head = add(
        MeshBuilder.CreateSphere(
            `ronin-${player.playerId}-helmet`,
            { diameterX: 0.62, diameterY: 0.5, diameterZ: 0.58, segments: 14 },
            runtime.scene
        ),
        armorMaterial
    );
    head.position.y = 1.72;

    const visor = add(
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-visor`,
            { width: 0.58, height: 0.08, depth: 0.06 },
            runtime.scene
        ),
        visorMaterial
    );
    visor.position.set(0, 1.72, -0.3);

    for (const side of [-1, 1]) {
        const shoulder = add(
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-shoulder-${side}`,
                { width: 0.28, height: 0.22, depth: 0.42 },
                runtime.scene
            ),
            accentMaterial
        );
        shoulder.position.set(side * 0.58, 1.33, 0);

        const arm = add(
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-arm-${side}`,
                { width: 0.16, height: 0.76, depth: 0.18 },
                runtime.scene
            ),
            armorMaterial
        );
        arm.position.set(side * 0.64, 0.86, 0);

        const leg = add(
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-leg-${side}`,
                { width: 0.22, height: 0.72, depth: 0.24 },
                runtime.scene
            ),
            armorMaterial
        );
        leg.position.set(side * 0.22, 0.22, 0);

        const blade = add(
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-blade-${side}`,
                { width: 0.06, height: 1.15, depth: 0.08 },
                runtime.scene
            ),
            accentMaterial
        );
        blade.position.set(side * 0.82, 0.76, 0.24);
        blade.rotation.z = side * 0.24;
    }

    const ring = add(
        MeshBuilder.CreateTorus(
            `ronin-${player.playerId}-floor-ring`,
            { diameter: 1.62, thickness: 0.045, tessellation: 36 },
            runtime.scene
        ),
        accentMaterial
    );
    ring.position.y = 0.045;
    ring.rotation.x = Math.PI / 2;

    const trail = add(
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-motion-trail`,
            { width: 0.34, height: 0.06, depth: 1.4 },
            runtime.scene
        ),
        accentMaterial
    );
    trail.position.set(0, 0.18, 0.74);
    trail.setEnabled(false);

    const labelTexture = new DynamicTexture(
        `ronin-${player.playerId}-label-texture`,
        { width: 512, height: 128 },
        runtime.scene,
        false
    );
    const label = MeshBuilder.CreatePlane(
        `ronin-${player.playerId}-label`,
        { width: 2.3, height: 0.58 },
        runtime.scene
    );
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.parent = root;
    label.position.y = 2.25;
    label.material = labelMaterial(runtime.scene, `ronin-${player.playerId}-label-material`, labelTexture);
    updateAvatarLabel({ labelTexture } as AvatarBundle, character, player);

    const target = snapshotPositionForPlayer(runtime.snapshot.value, player);
    root.position.copyFrom(target);
    return {
        playerId: player.playerId,
        root,
        parts,
        ring,
        label,
        labelTexture,
        trail,
        target,
        lastPosition: target.clone(),
        lastMovedAtMs: performance.now()
    };
}

function updateNextRuntime(runtime: RelicSceneNextRuntime): void {
    runtime.pulsePhase.value += runtime.engine.getDeltaTime() / 1000;
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

function updateLocalRoam(runtime: RelicSceneNextRuntime): void {
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
    if (!cameraModeAllowsMovement(runtime.cameraMode.value)) {
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

function updateAvatarPositions(runtime: RelicSceneNextRuntime): void {
    const snapshot = runtime.snapshot.value;
    if (!snapshot) {
        return;
    }
    const nowEpochMs = Date.now();
    const nowMs = performance.now();
    for (const player of snapshot.players) {
        const avatar = runtime.avatars.get(player.playerId);
        if (!avatar || player.escaped || player.defeated) {
            continue;
        }
        let target = avatar.target;
        if (player.playerId === runtime.localPlayerId.value && snapshot.phase !== 'lobby') {
            const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
            if (room) {
                const world = facilityRoomPosition(room);
                target = new Vector3(world.x + runtime.roamOffset.x, AVATAR_Y, world.z + runtime.roamOffset.z);
            }
        }
        else {
            let estimate = runtime.motion.buffer.sample(player.playerId, nowEpochMs);
            const estimateRoomId = estimate?.metadata?.roomId;
            if (!isRelicMotionEstimateFreshForPlayer(estimate, player.roomId, nowEpochMs)) {
                if (estimateRoomId && estimateRoomId !== player.roomId) {
                    runtime.motion.buffer.remove(player.playerId);
                    runtime.motion.kinematics.remove(player.playerId);
                }
                estimate = undefined;
            }
            if (estimate) {
                target = new Vector3(estimate.position[0], estimate.position[1], estimate.position[2]);
                if (estimate.rotation) {
                    avatar.root.rotation.y = estimate.rotation[1];
                }
                runtime.motion.diagnostics.lastEstimateMode = estimate.mode;
                runtime.motion.diagnostics.lastConfidence = estimate.confidence;
                runtime.motion.diagnostics.lastSampleAgeMs = Math.max(0, nowEpochMs - estimate.observedAtEpochMs);
            }
        }

        const delta = target.subtract(avatar.root.position);
        const smoothing = player.playerId === runtime.localPlayerId.value ? 0.72 : 0.42;
        avatar.root.position.addInPlace(delta.scale(smoothing));
        const moved = avatar.root.position.subtract(avatar.lastPosition).lengthSquared() > 0.0005;
        if (moved) {
            avatar.lastMovedAtMs = nowMs;
            if (player.playerId === runtime.localPlayerId.value) {
                avatar.root.rotation.y = runtime.cameraYaw.value;
            }
        }
        const recentMove = nowMs - avatar.lastMovedAtMs < 180;
        const hiddenForFirstPerson = runtime.cameraMode.value === 'first-person' &&
            player.playerId === runtime.localPlayerId.value;
        for (const part of avatar.parts) {
            part.setEnabled(!hiddenForFirstPerson);
        }
        avatar.label.setEnabled(!hiddenForFirstPerson);
        avatar.trail.setEnabled(!hiddenForFirstPerson && recentMove);
        avatar.ring.scaling.setAll(1 + Math.sin(runtime.pulsePhase.value * 4.6) * 0.035);
        avatar.root.position.y = target.y + (recentMove ? Math.sin(nowMs / 82) * 0.045 : 0);
        avatar.lastPosition.copyFrom(avatar.root.position);
    }
    runtime.firstPersonRig.root.setEnabled(runtime.cameraMode.value === 'first-person');
}

function updateRelicMeshes(runtime: RelicSceneNextRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === runtime.localPlayerId.value);
    const localAvatar = localPlayer ? runtime.avatars.get(localPlayer.playerId) : undefined;
    let nearby: RelicPickupPrompt | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const now = performance.now();

    for (const [relicId, bundle] of runtime.relics.entries()) {
        const relic = snapshot?.relics.find((candidate) => candidate.id === relicId);
        if (!snapshot || !relic || relic.carriedBy || relic.escapedBy) {
            continue;
        }
        const pulse = 1 + Math.sin(runtime.pulsePhase.value * 4.1 + hashText(relic.id) * 0.01) * 0.06;
        bundle.root.rotation.y += runtime.engine.getDeltaTime() / 1000 * (0.42 + relic.value * 0.012);
        bundle.root.position.y = bundle.baseY + Math.sin(now / 360 + relic.value) * 0.08;
        for (const part of bundle.parts) {
            if (part !== bundle.label) {
                part.scaling.setAll(pulse);
            }
        }
        if (
            snapshot.phase === 'planning' &&
            localPlayer &&
            localAvatar &&
            localPlayer.roomId === relic.roomId &&
            !localPlayer.escaped &&
            !localPlayer.defeated
        ) {
            const distance = Vector3.Distance(localAvatar.root.position, bundle.root.position);
            if (distance <= PICKUP_RADIUS && distance < nearestDistance) {
                nearestDistance = distance;
                nearby = {
                    relicId: relic.id,
                    name: relic.name,
                    value: relic.value
                };
            }
        }
    }

    if (runtime.nearbyRelic.value?.relicId !== nearby?.relicId) {
        runtime.nearbyRelic.value = nearby;
        runtime.onPickupPromptChange.value(nearby);
    }
}

function syncReviewPlayback(runtime: RelicSceneNextRuntime, snapshot: RelicPublicSnapshot): void {
    if (snapshot.phase !== 'review') {
        resetReviewPlayback(runtime);
        return;
    }
    const key = reviewPlaybackKey(snapshot);
    if (runtime.review.key === key) {
        return;
    }
    runtime.review = {
        key,
        queue: buildReviewQueue(snapshot),
        index: 0,
        cueStartedAtMs: undefined,
        completed: false,
        notifiedKey: runtime.review.notifiedKey
    };
    runtime.reviewAvatarMotions.clear();
}

function resetReviewPlayback(runtime: RelicSceneNextRuntime): void {
    runtime.review = {
        key: undefined,
        queue: [],
        index: 0,
        cueStartedAtMs: undefined,
        completed: false,
        notifiedKey: runtime.review.notifiedKey
    };
    runtime.reviewAvatarMotions.clear();
}

function buildReviewQueue(snapshot: RelicPublicSnapshot): ReviewPlaybackCue[] {
    const seen = new Set<string>();
    return snapshot.events
        .filter((event) => event.round === snapshot.round && !!event.animationCue)
        .sort((left, right) =>
            left.createdAtEpochMs === right.createdAtEpochMs
                ? left.id.localeCompare(right.id)
                : left.createdAtEpochMs - right.createdAtEpochMs
        )
        .flatMap((event) => {
            if (!event.animationCue || seen.has(event.id)) {
                return [];
            }
            seen.add(event.id);
            return [{
                eventId: event.id,
                event,
                cue: event.animationCue,
                durationMs: event.animationCue.durationMs ?? defaultReviewCueDuration(event.animationCue.type)
            }];
        });
}

function updateReviewPlayback(runtime: RelicSceneNextRuntime): void {
    const review = runtime.review;
    if (!review.key || review.completed) {
        return;
    }

    const now = performance.now();
    applyReviewAvatarMotions(runtime, now);
    const item = review.queue[review.index];
    if (!item) {
        completeReviewPlayback(runtime);
        return;
    }

    if (review.cueStartedAtMs === undefined) {
        review.cueStartedAtMs = now;
        startReviewCue(runtime, item, now);
    }

    if (now - review.cueStartedAtMs >= item.durationMs + REVIEW_CUE_GAP_MS) {
        review.index += 1;
        review.cueStartedAtMs = undefined;
        if (review.index >= review.queue.length) {
            completeReviewPlayback(runtime);
        }
    }
}

function completeReviewPlayback(runtime: RelicSceneNextRuntime): void {
    const key = runtime.review.key;
    runtime.review.completed = true;
    runtime.review.cueStartedAtMs = undefined;
    runtime.reviewAvatarMotions.clear();
    if (key && runtime.reviewDirector.value && runtime.review.notifiedKey !== key) {
        runtime.review.notifiedKey = key;
        runtime.onReviewPlaybackComplete.value?.();
    }
}

function startReviewCue(
    runtime: RelicSceneNextRuntime,
    item: ReviewPlaybackCue,
    startedAtMs: number
): void {
    const cue = item.cue;
    const roomId = cue.roomId ?? roomIdForCuePlayer(runtime.snapshot.value, cue.playerId);
    runtime.focusRoomId.value = roomId;
    const position = cuePosition(runtime, cue);
    switch (cue.type) {
        case 'camera_move': {
            if (cue.playerId && cue.fromRoomId && cue.roomId) {
                const fromRoom = runtime.snapshot.value?.map.find((room) => room.id === cue.fromRoomId);
                const toRoom = runtime.snapshot.value?.map.find((room) => room.id === cue.roomId);
                if (fromRoom && toRoom) {
                    const from = facilityRoomPosition(fromRoom).add(new Vector3(0, AVATAR_Y, 0));
                    const to = facilityRoomPosition(toRoom).add(new Vector3(0, AVATAR_Y, 0));
                    runtime.reviewAvatarMotions.set(cue.playerId, {
                        playerId: cue.playerId,
                        from,
                        to,
                        startedAtMs,
                        durationMs: item.durationMs
                    });
                    spawnBeamEffect(runtime, from, to, runtime.materials.cyan, item.durationMs);
                }
            }
            spawnPulseEffect(
                runtime,
                `review-move-${item.eventId}`,
                position,
                runtime.materials.cyan,
                item.durationMs,
                2.3
            );
            return;
        }
        case 'search_altar':
            spawnPulseEffect(
                runtime,
                `review-search-${item.eventId}`,
                position,
                runtime.materials.amber,
                item.durationMs,
                2.8
            );
            spawnBurstEffect(
                runtime,
                `review-search-scan-${item.eventId}`,
                position.add(new Vector3(0, 0.8, 0)),
                runtime.materials.white,
                item.durationMs
            );
            return;
        case 'relic_reveal':
            spawnPulseEffect(
                runtime,
                `review-reveal-${item.eventId}`,
                position,
                runtime.materials.green,
                item.durationMs,
                3.2
            );
            spawnBurstEffect(
                runtime,
                `review-reveal-burst-${item.eventId}`,
                position.add(new Vector3(0, 0.9, 0)),
                runtime.materials.amber,
                item.durationMs
            );
            return;
        case 'relic_pickup':
            spawnPulseEffect(
                runtime,
                `review-pickup-${item.eventId}`,
                position,
                runtime.materials.magenta,
                item.durationMs,
                3.0
            );
            spawnBurstEffect(
                runtime,
                `review-pickup-burst-${item.eventId}`,
                position.add(new Vector3(0, 0.72, 0)),
                runtime.materials.white,
                item.durationMs
            );
            return;
        case 'steal_attempt':
            spawnPulseEffect(
                runtime,
                `review-steal-${item.eventId}`,
                position,
                runtime.materials.magenta,
                item.durationMs,
                2.9
            );
            spawnBurstEffect(
                runtime,
                `review-steal-burst-${item.eventId}`,
                position.add(new Vector3(0, 1, 0)),
                runtime.materials.danger,
                item.durationMs
            );
            return;
        case 'escape_run':
            spawnPulseEffect(
                runtime,
                `review-escape-${item.eventId}`,
                position,
                runtime.materials.green,
                item.durationMs,
                3.4
            );
            spawnBeamEffect(
                runtime,
                position,
                position.add(new Vector3(0, 0, 3.8)),
                runtime.materials.green,
                item.durationMs
            );
            return;
        case 'noise_pulse':
            spawnPulseEffect(
                runtime,
                `review-noise-${item.eventId}`,
                position,
                runtime.materials.violet,
                item.durationMs,
                cue.intensity === 'high' ? 5.6 : 4.2
            );
            return;
        case 'damage_shake':
            spawnPulseEffect(
                runtime,
                `review-damage-${item.eventId}`,
                position,
                runtime.materials.danger,
                item.durationMs,
                3.5
            );
            spawnBurstEffect(
                runtime,
                `review-damage-burst-${item.eventId}`,
                position.add(new Vector3(0, 1.1, 0)),
                runtime.materials.danger,
                item.durationMs
            );
            return;
        case 'room_collapse':
            spawnPulseEffect(
                runtime,
                `review-collapse-${item.eventId}`,
                position,
                runtime.materials.danger,
                item.durationMs,
                5.0
            );
            spawnBurstEffect(
                runtime,
                `review-collapse-burst-${item.eventId}`,
                position.add(new Vector3(0, 1.2, 0)),
                runtime.materials.amber,
                item.durationMs
            );
            return;
        case 'heart_relic_victory':
            spawnPulseEffect(
                runtime,
                `review-victory-${item.eventId}`,
                position,
                runtime.materials.white,
                item.durationMs,
                6.0
            );
            spawnBurstEffect(
                runtime,
                `review-victory-burst-${item.eventId}`,
                position.add(new Vector3(0, 1.4, 0)),
                runtime.materials.green,
                item.durationMs
            );
            return;
    }
}

function applyReviewAvatarMotions(runtime: RelicSceneNextRuntime, now: number): void {
    for (const [playerId, motion] of runtime.reviewAvatarMotions.entries()) {
        const avatar = runtime.avatars.get(playerId);
        if (!avatar) {
            runtime.reviewAvatarMotions.delete(playerId);
            continue;
        }
        const progress = clamp((now - motion.startedAtMs) / Math.max(1, motion.durationMs), 0, 1);
        const eased = smoothstep(progress);
        const position = Vector3.Lerp(motion.from, motion.to, eased);
        position.y += Math.sin(eased * Math.PI) * 0.28;
        avatar.root.setEnabled(true);
        avatar.root.position.copyFrom(position);
        const direction = motion.to.subtract(motion.from);
        if (direction.lengthSquared() > 0.001) {
            avatar.root.rotation.y = Math.atan2(direction.x, direction.z);
        }
        avatar.trail.setEnabled(progress < 0.92);
        if (progress >= 1) {
            runtime.reviewAvatarMotions.delete(playerId);
        }
    }
}

function updateSceneEffects(runtime: RelicSceneNextRuntime): void {
    const now = performance.now();
    for (let index = runtime.effects.length - 1; index >= 0; index -= 1) {
        const effect = runtime.effects[index];
        const progress = clamp((now - effect.startedAtMs) / Math.max(1, effect.durationMs), 0, 1);
        effect.update(progress);
        if (progress >= 1) {
            effect.dispose();
            runtime.effects.splice(index, 1);
        }
    }
}

function updateCamera(runtime: RelicSceneNextRuntime): void {
    const snapshot = runtime.snapshot.value;
    if (!snapshot) {
        runtime.camera.position = Vector3.Lerp(runtime.camera.position, new Vector3(-14, 16, -24), CAMERA_SMOOTHING);
        runtime.camera.setTarget(Vector3.Zero());
        runtime.firstPersonRig.root.setEnabled(false);
        return;
    }
    const aspectRatio = runtime.engine.getRenderWidth() / Math.max(1, runtime.engine.getRenderHeight());
    const localAvatar = runtime.localPlayerId.value
        ? runtime.avatars.get(runtime.localPlayerId.value)
        : undefined;
    const canUseAvatar = !!localAvatar && hasPlayableLocalHunter(snapshot, runtime.localPlayerId.value);
    if (
        (runtime.cameraMode.value === 'avatar' || runtime.cameraMode.value === 'first-person') &&
        !canUseAvatar
    ) {
        setRuntimeCameraMode(runtime, 'overview');
    }

    let pose = planNeonOverviewCameraPose({ snapshot, aspectRatio });
    let smoothing = CAMERA_SMOOTHING;
    const reviewCue = snapshot.phase === 'review' && !runtime.review.completed
        ? runtime.review.queue[runtime.review.index]?.cue
        : undefined;
    if (reviewCue) {
        pose = planNeonTacticalCameraPose({
            snapshot,
            localPlayerId: runtime.localPlayerId.value,
            selectedRoomId: reviewCue.roomId ?? roomIdForCuePlayer(snapshot, reviewCue.playerId),
            focusRoomId: reviewCue.roomId ?? roomIdForCuePlayer(snapshot, reviewCue.playerId),
            aspectRatio
        });
        smoothing = 0.26;
    }
    else if (runtime.cameraMode.value === 'avatar' && localAvatar && canUseAvatar) {
        pose = planNeonAvatarCameraPose({
            avatarPosition: localAvatar.root.position,
            cameraYaw: runtime.cameraYaw.value,
            cameraPitch: runtime.cameraPitch.value
        });
        smoothing = 0.28;
    }
    else if (runtime.cameraMode.value === 'first-person' && localAvatar && canUseAvatar) {
        pose = planNeonFirstPersonCameraPose({
            avatarPosition: localAvatar.root.position,
            cameraYaw: runtime.cameraYaw.value,
            cameraPitch: runtime.cameraPitch.value
        });
        smoothing = 0.56;
    }
    else if (runtime.cameraMode.value === 'flyover') {
        const startedAt = runtime.flyoverStartedAtMs.value ?? performance.now();
        runtime.flyoverStartedAtMs.value = startedAt;
        const progress = Math.min(1, (performance.now() - startedAt) / runtime.flyoverDurationMs.value);
        pose = planNeonFlyoverCameraPose({ snapshot, progress, aspectRatio });
        smoothing = runtime.reducedMotion.value ? 0.72 : 0.2;
        if (progress >= 1) {
            setRuntimeCameraMode(runtime, runtime.previousCameraMode.value);
        }
    }

    runtime.camera.position = Vector3.Lerp(runtime.camera.position, pose.position, smoothing);
    runtime.camera.fov += (pose.fov - runtime.camera.fov) * 0.14;
    runtime.camera.setTarget(pose.target);
}

function updateRoomHighlights(runtime: RelicSceneNextRuntime): void {
    const snapshot = runtime.snapshot.value;
    const selectedRoomId = runtime.selectedRoomId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === runtime.localPlayerId.value);
    for (const [roomId, bundle] of runtime.rooms.entries()) {
        const selected = roomId === selectedRoomId;
        const local = roomId === localPlayer?.roomId;
        const pulse = 0.18 + Math.sin(runtime.pulsePhase.value * 3.2) * 0.08;
        bundle.accent.emissiveColor = Color3.FromHexString(
            relicNeonAccentForRoom(
                snapshot?.map.find((room) => room.id === roomId) ?? {
                    kind: 'hallway',
                    collapsed: false,
                    unstable: false
                }
            ).emissive
        ).scale(selected ? 1.45 : local ? 1.05 : 0.62 + pulse);
        bundle.floor.scaling.y = selected ? 1.32 : 1;
    }
}

function updatePromptForSelection(runtime: RelicSceneNextRuntime, roomId?: string): void {
    if (!roomId) {
        runtime.onPromptChange.value(undefined);
        return;
    }
    const snapshot = runtime.snapshot.value;
    const room = snapshot?.map.find((candidate) => candidate.id === roomId);
    if (!snapshot || !room) {
        runtime.onPromptChange.value(undefined);
        return;
    }
    const move = sceneMoveActionForPickedRoom({
        snapshot,
        localPlayerId: runtime.localPlayerId.value,
        roomId
    });
    if (move) {
        const localPlayer = snapshot.players.find((player) => player.playerId === runtime.localPlayerId.value);
        const localRoom = snapshot.map.find((candidate) => candidate.id === localPlayer?.roomId);
        runtime.onPromptChange.value({
            kind: 'move',
            roomId,
            roomName: room.name,
            direction: localRoom ? directionBetweenRooms(localRoom, room) : 'north'
        });
        return;
    }
    const localPlayer = snapshot.players.find((player) => player.playerId === runtime.localPlayerId.value);
    if (localPlayer?.roomId === roomId && snapshot.phase === 'planning') {
        runtime.onPromptChange.value({
            kind: 'search',
            label: blackHumourSignForRoom(room),
            detail: 'Inspect the room. The facility insists this counts as optimism.'
        });
        return;
    }
    runtime.onPromptChange.value(undefined);
}

function snapshotPositionForPlayer(
    snapshot: RelicPublicSnapshot | undefined,
    player: RelicPlayer
): Vector3 {
    const room = snapshot?.map.find((candidate) => candidate.id === player.roomId);
    if (!snapshot || !room) {
        return new Vector3(0, AVATAR_Y, 0);
    }
    const world = facilityRoomPosition(room);
    const sameRoomIndex = snapshot.players
        .filter((candidate) => candidate.roomId === player.roomId && !candidate.escaped && !candidate.defeated)
        .findIndex((candidate) => candidate.playerId === player.playerId);
    const angle = (sameRoomIndex / 4) * Math.PI * 2;
    const radius = sameRoomIndex <= 0 ? 0 : 0.72;
    return new Vector3(
        world.x + Math.cos(angle) * radius,
        AVATAR_Y,
        world.z + Math.sin(angle) * radius
    );
}

function reviewPlaybackKey(snapshot: RelicPublicSnapshot): string {
    const cueEventIds = snapshot.events
        .filter((event) => event.round === snapshot.round && !!event.animationCue)
        .map((event) => event.id)
        .join(',');
    return `${snapshot.gameId}:${snapshot.round}:${snapshot.updatedAtEpochMs}:${cueEventIds}`;
}

function defaultReviewCueDuration(type: RelicAnimationCue['type']): number {
    switch (type) {
        case 'camera_move':
            return 760;
        case 'search_altar':
            return 760;
        case 'relic_reveal':
        case 'relic_pickup':
            return 980;
        case 'steal_attempt':
            return 860;
        case 'escape_run':
            return 1_250;
        case 'noise_pulse':
            return 820;
        case 'damage_shake':
            return 760;
        case 'room_collapse':
            return 1_200;
        case 'heart_relic_victory':
            return 2_200;
    }
}

function roomIdForCuePlayer(
    snapshot: RelicPublicSnapshot | undefined,
    playerId: string | undefined
): string | undefined {
    if (!snapshot || !playerId) {
        return undefined;
    }
    return snapshot.players.find((player) => player.playerId === playerId)?.roomId;
}

function cuePosition(runtime: RelicSceneNextRuntime, cue: RelicAnimationCue): Vector3 {
    const snapshot = runtime.snapshot.value;
    if (!snapshot) {
        return Vector3.Zero();
    }
    if (cue.relicId) {
        const relic = snapshot.relics.find((candidate) => candidate.id === cue.relicId);
        const room = relic ? snapshot.map.find((candidate) => candidate.id === relic.roomId) : undefined;
        if (relic && room) {
            const base = facilityRoomPosition(room);
            const offset = relicLocalOffset(relic);
            return new Vector3(base.x + offset.x, 0.6, base.z + offset.z);
        }
    }
    if (cue.playerId) {
        const avatar = runtime.avatars.get(cue.playerId);
        if (avatar) {
            return avatar.root.position.clone();
        }
    }
    const roomId = cue.roomId ?? roomIdForCuePlayer(snapshot, cue.playerId);
    const room = roomId ? snapshot.map.find((candidate) => candidate.id === roomId) : undefined;
    if (room) {
        const base = facilityRoomPosition(room);
        return new Vector3(base.x, 0.48, base.z);
    }
    return Vector3.Zero();
}

function spawnPulseEffect(
    runtime: RelicSceneNextRuntime,
    id: string,
    position: Vector3,
    material: PBRMaterial,
    durationMs: number,
    maxScale: number
): void {
    const ring = MeshBuilder.CreateTorus(
        `${id}-pulse`,
        { diameter: 1, thickness: 0.055, tessellation: 48 },
        runtime.scene
    );
    ring.position.set(position.x, 0.34, position.z);
    ring.rotation.x = Math.PI / 2;
    ring.material = material;
    runtime.effects.push({
        id,
        startedAtMs: performance.now(),
        durationMs,
        meshes: [ring],
        update(progress) {
            const scale = 0.2 + maxScale * smoothstep(progress);
            ring.scaling.set(scale, scale, scale);
            ring.position.y = 0.34 + progress * 0.18;
            ring.setEnabled(progress < 0.96);
        },
        dispose() {
            ring.dispose();
        }
    });
}

function spawnBurstEffect(
    runtime: RelicSceneNextRuntime,
    id: string,
    position: Vector3,
    material: PBRMaterial,
    durationMs: number
): void {
    const core = MeshBuilder.CreateSphere(`${id}-core`, { diameter: 0.32, segments: 12 }, runtime.scene);
    core.position.copyFrom(position);
    core.material = material;
    const shardA = MeshBuilder.CreateBox(`${id}-shard-a`, { width: 0.08, height: 0.72, depth: 0.08 }, runtime.scene);
    shardA.position.copyFrom(position.add(new Vector3(0.34, 0, 0.12)));
    shardA.material = material;
    const shardB = MeshBuilder.CreateBox(`${id}-shard-b`, { width: 0.08, height: 0.58, depth: 0.08 }, runtime.scene);
    shardB.position.copyFrom(position.add(new Vector3(-0.28, 0.04, -0.22)));
    shardB.material = material;
    const meshes = [core, shardA, shardB];
    runtime.effects.push({
        id,
        startedAtMs: performance.now(),
        durationMs,
        meshes,
        update(progress) {
            const eased = smoothstep(progress);
            core.scaling.setAll(1 + eased * 2.2);
            shardA.rotation.y += 0.12;
            shardB.rotation.y -= 0.1;
            shardA.position.y = position.y + eased * 1.1;
            shardB.position.y = position.y + eased * 0.88;
            for (const mesh of meshes) {
                mesh.setEnabled(progress < 0.94);
            }
        },
        dispose() {
            for (const mesh of meshes) {
                mesh.dispose();
            }
        }
    });
}

function spawnBeamEffect(
    runtime: RelicSceneNextRuntime,
    from: Vector3,
    to: Vector3,
    material: PBRMaterial,
    durationMs: number
): void {
    const delta = to.subtract(from);
    const length = Math.max(0.1, Math.sqrt(delta.x * delta.x + delta.z * delta.z));
    const beam = MeshBuilder.CreateBox(
        `review-beam-${runtime.effects.length}`,
        { width: length, height: 0.08, depth: 0.16 },
        runtime.scene
    );
    beam.position.set((from.x + to.x) / 2, 0.4, (from.z + to.z) / 2);
    beam.rotation.y = -Math.atan2(delta.z, delta.x);
    beam.material = material;
    runtime.effects.push({
        id: `beam-${runtime.effects.length}`,
        startedAtMs: performance.now(),
        durationMs,
        meshes: [beam],
        update(progress) {
            const eased = smoothstep(progress);
            beam.scaling.z = 1 + Math.sin(eased * Math.PI) * 1.6;
            beam.position.y = 0.4 + Math.sin(eased * Math.PI) * 0.18;
            beam.setEnabled(progress < 0.96);
        },
        dispose() {
            beam.dispose();
        }
    });
}

function writeDiagnostics(runtime: RelicSceneNextRuntime): void {
    const diagnostics = runtime.motion.diagnostics;
    runtime.canvas.dataset.sceneRuntime = 'next';
    runtime.canvas.dataset.sceneReady = 'true';
    runtime.canvas.dataset.sceneReadyMs = String(Math.round(performance.now()));
    runtime.canvas.dataset.sceneVisualTheme = 'neon-dystopian';
    runtime.canvas.dataset.assetPipeline = 'procedural';
    runtime.canvas.dataset.cameraMode = runtime.cameraMode.value;
    runtime.canvas.dataset.cameraControl = cameraModeAcceptsLook(runtime.cameraMode.value)
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

function createTextMaterial(
    scene: Scene,
    name: string,
    options: Readonly<{ title: string; detail: string; accent: string; }>
): StandardMaterial {
    const texture = new DynamicTexture(`${name}-texture`, { width: 768, height: 256 }, scene, false);
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 768, 256);
    ctx.fillStyle = 'rgba(5, 12, 22, 0.92)';
    ctx.fillRect(0, 0, 768, 256);
    ctx.strokeStyle = options.accent;
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, 752, 240);
    ctx.fillStyle = options.accent;
    ctx.font = '700 46px monospace';
    ctx.fillText(options.title, 34, 74);
    ctx.fillStyle = '#e6fbff';
    ctx.font = '600 34px monospace';
    wrapText(ctx, options.detail, 34, 132, 700, 42);
    texture.update();
    return labelMaterial(scene, `${name}-material`, texture);
}

function labelMaterial(scene: Scene, name: string, texture: DynamicTexture): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseTexture = texture;
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    return material;
}

function updateAvatarLabel(
    avatar: Pick<AvatarBundle, 'labelTexture'>,
    character: RelicCharacter,
    player: RelicPlayer
): void {
    const ctx = avatar.labelTexture.getContext();
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(5, 12, 22, 0.78)';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = character.colors.accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, 504, 120);
    ctx.fillStyle = '#eefcff';
    ctx.font = '700 34px monospace';
    ctx.fillText(player.username.slice(0, 18), 22, 50);
    ctx.fillStyle = '#9eeaff';
    ctx.font = '600 24px monospace';
    ctx.fillText(character.role.toUpperCase(), 22, 91);
    avatar.labelTexture.update();
}

function pbr(
    scene: Scene,
    name: string,
    albedo: string,
    emissive: string,
    emissiveScale: number,
    metallic: number,
    roughness: number,
    alpha = 1
): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = Color3.FromHexString(albedo);
    material.emissiveColor = Color3.FromHexString(emissive).scale(emissiveScale);
    material.metallic = metallic;
    material.roughness = roughness;
    material.alpha = alpha;
    material.backFaceCulling = alpha >= 1;
    return material;
}

function accentMaterialForRoom(scene: Scene, room: RelicRoom): PBRMaterial {
    const accent = relicNeonAccentForRoom(room);
    return pbr(
        scene,
        `next-room-accent-${room.id}`,
        accent.base,
        accent.emissive,
        room.collapsed ? 0.58 : room.unstable ? 1.35 : 1.08,
        0.08,
        0.18
    );
}

function standard(
    scene: Scene,
    name: string,
    diffuse: string,
    emissive: string,
    emissiveScale: number
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.FromHexString(diffuse);
    material.emissiveColor = Color3.FromHexString(emissive).scale(emissiveScale);
    return material;
}

type TextDrawingContext = Readonly<{
    fillText(text: string, x: number, y: number): void;
    measureText(text: string): Readonly<{ width: number; }>;
}>;

function wrapText(
    ctx: TextDrawingContext,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number
): void {
    const words = text.split(/\s+/);
    let line = '';
    let lineY = y;
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
            ctx.fillText(line, x, lineY);
            line = word;
            lineY += lineHeight;
        }
        else {
            line = test;
        }
    }
    if (line) {
        ctx.fillText(line, x, lineY);
    }
}

function dystopianObjectiveDetail(detail: string): string {
    if (detail.includes('castle')) {
        return detail.replaceAll('castle', 'facility');
    }
    if (detail.includes('ruin')) {
        return detail.replaceAll('ruin', 'facility');
    }
    return detail;
}

function isMoveKey(key: string): boolean {
    const value = key.toLowerCase();
    return value === 'w' ||
        value === 'a' ||
        value === 's' ||
        value === 'd' ||
        value === 'arrowup' ||
        value === 'arrowleft' ||
        value === 'arrowdown' ||
        value === 'arrowright' ||
        value === 'shift';
}

function isCameraRotateKey(key: string): boolean {
    const value = key.toLowerCase();
    return value === 'q' || value === 'e';
}

function isCameraModeCycleKey(key: string): boolean {
    return key.toLowerCase() === 'c';
}

function isFlyoverKey(key: string): boolean {
    return key.toLowerCase() === 'f';
}

function cameraModeAcceptsLook(mode: RelicSceneNextCameraMode): boolean {
    return mode === 'avatar' || mode === 'first-person';
}

function cameraModeAllowsMovement(mode: RelicSceneNextCameraMode): boolean {
    return mode === 'avatar' || mode === 'first-person';
}

function updateCameraYawFromKeys(runtime: RelicSceneNextRuntime): void {
    if (!cameraModeAcceptsLook(runtime.cameraMode.value)) {
        return;
    }
    const left = runtime.pressedKeys.has('q') ? 1 : 0;
    const right = runtime.pressedKeys.has('e') ? 1 : 0;
    if (left === right) {
        return;
    }
    runtime.cameraYaw.value = wrapAngle(runtime.cameraYaw.value + (left - right) * KEYBOARD_LOOK_STEP);
}

function applyCameraLook(runtime: RelicSceneNextRuntime, deltaX: number, deltaY: number): void {
    if (!cameraModeAcceptsLook(runtime.cameraMode.value)) {
        return;
    }
    runtime.cameraYaw.value = wrapAngle(runtime.cameraYaw.value + deltaX * POINTER_LOOK_SENSITIVITY);
    runtime.cameraPitch.value = clamp(
        runtime.cameraPitch.value - deltaY * POINTER_LOOK_SENSITIVITY * 0.75,
        -0.72,
        0.72
    );
}

function wrapAngle(value: number): number {
    const period = Math.PI * 2;
    return ((value % period) + period) % period;
}

function smoothstep(value: number): number {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}

function hashText(value: string): number {
    let hash = 0;
    for (const char of value) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return hash;
}

function isTypingTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
