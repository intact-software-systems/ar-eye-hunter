import { useEffect, useRef, useState } from 'react';
import '@babylonjs/core/Culling/ray.js';
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import {
    SSAO2RenderingPipeline
} from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import {
    DefaultRenderingPipeline
} from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { ColorCurves } from '@babylonjs/core/Materials/colorCurves.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
import type {
    RelicActionInput,
    RelicAnimationCue,
    RelicCharacter,
    RelicEvent,
    RelicPublicSnapshot,
    RelicRoom,
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { SceneInteractionPrompt } from './scene/SceneInteractionPrompt.tsx';
import { SceneObjectivePanel } from './scene/SceneObjectivePanel.tsx';
import {
    avatarCameraReturnState,
    blendRelicCameraPose,
    deriveRelicCameraMode,
    planRoomFlyoverCameraPose,
    planTacticalCameraPose,
    ROOM_FLYOVER_DURATION_MS,
    type RelicCameraPose,
    type RelicCameraMode,
    type RelicSceneCameraControl,
    type RelicSceneManualCameraMode,
} from './scene/cameraModes.ts';
import {
    avatarPoseOffsets,
    deriveRelicAvatarPresentation,
    type RelicAvatarPresentation,
} from './scene/avatarPresentation.ts';
import {
    lightingPresetById,
    selectRelicLightingPreset,
    type RelicLightingPreset,
    type RelicLightingPresetId,
} from './scene/lightingPresets.ts';
import { CURRENT_RELIC_ASSET_PIPELINE } from './scene/assetPipeline.ts';
import { selectActiveEffectRoomIds } from './scene/sceneCost.ts';
import { DOOR_WIDTH, FLOOR_Y, PLAYER_EYE_Y, ROOM_SIZE, } from './scene/constants.ts';
import { applyPointerLook, isRoamKey, yawToForward } from './scene/controls.ts';
import { resolveRoomRoam, roomCollisionBoxes } from './scene/collision.ts';
import { setRuntimePrompt, shouldExitInspection, startInspection, updateScenePrompt, } from './scene/interaction.ts';
import {
    broadcastLocalPosition,
    isRemotePositionFreshForPlayer,
    type RemotePosEntry,
    subscribeRelicScenePositionUpdates,
} from './scene/networking.ts';
import { sceneMoveActionForPickedRoom } from './scene/movement.ts';
import { deriveSceneObjective, roomHasResolvedClue, } from './scene/objectives.ts';
import { chooseLookRoom, directionBetweenRooms, roomClueHotspot, } from './scene/prompts.ts';
import { startCappedRenderLoop } from './scene/renderLoop.ts';
import {
    applyRoomMaterial,
    type CastleMaterials,
    createCastleCorridor,
    createCastleMaterials,
    createFlameTexture,
    createJapaneseLobbyScene,
    createRoomAtmosphereParticles,
    createRoomLights,
    createRoomProps,
    createRoomTorchParticles,
    roomWorldPosition,
} from './scene/rooms.ts';
import type {
    CardinalDirection,
    CollisionBox,
    InspectionFocus,
    PointerLookState,
    ScenePrompt,
} from './scene/types.ts';

const MOVE_PROMPT_HOLD_MS = 1200;
const SCENE_FRAME_INTERVAL_MS = 1000 / 45;
const PLAYER_LABEL_MODE: 'names' | 'details' | 'hidden' = 'names';
const DEFAULT_CAMERA_CONTROL: RelicSceneCameraControl = 'tactical';

type HeldMovePrompt = Readonly<{
    roomId: string;
    prompt: Extract<ScenePrompt, { kind: 'move' }>;
    expiresAtMs: number;
}>;

type SceneCameraFlyover = Readonly<{
    startedAtMs: number;
    returnPose: RelicCameraPose;
    returnControl: RelicSceneCameraControl;
    returnManualMode: RelicSceneManualCameraMode;
}>;

type RelicSceneProps = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    primedAction?: RelicActionInput;
    focusRoomId?: string;
    rtcReady?: boolean;
    inputEnabled?: boolean;
    onSelectRoom(roomId: string): void;
    onPrimeAction?(action: RelicActionInput): void;
}>;

type SceneRuntime = Readonly<{
    canvas: HTMLCanvasElement;
    engine: Engine;
    scene: Scene;
    camera: UniversalCamera;
    pipeline: DefaultRenderingPipeline;
    shadows: ShadowGenerator;
    lighting: RelicSceneLighting;
    createdAtMs: number;
    castleMaterials: CastleMaterials;
    introMeshes: readonly Mesh[];
    snapshot: { value?: RelicPublicSnapshot };
    localPlayerId: { value?: string };
    selectedRoomId: { value?: string };
    primedAction: { value?: RelicActionInput };
    objectiveTargetRoomId: { value?: string };
    pressedKeys: Set<string>;
    cameraYaw: { value: number };
    cameraPitch: { value: number };
    cameraMode: { value: RelicCameraMode };
    lastRoamInputMs: { value?: number };
    cameraTarget: Vector3;
    cameraControl: {
        selected: { value: RelicSceneCameraControl };
        manualMode: { value: RelicSceneManualCameraMode };
        flyover: { value?: SceneCameraFlyover };
        onChange: { value(mode: RelicSceneCameraControl): void };
    };
    pointerLook: PointerLookState;
    roamOffset: Vector3;
    roamRoomId: { value?: string };
    rooms: Map<string, Mesh>;
    roomMaterials: Map<string, PBRMaterial>;
    roomBlockers: Map<string, readonly CollisionBox[]>;
    roomLights: Map<string, readonly PointLight[]>;
    players: Map<string, Mesh>;
    playerMaterials: Map<string, PBRMaterial>;
    playerCharacterIds: Map<string, string>;
    playerTargets: Map<string, Vector3>;
    avatarParts: Map<string, readonly Mesh[]>;
    avatarMaterials: Map<string, readonly PBRMaterial[]>;
    avatarLastPositions: Map<string, Vector3>;
    avatarLastMovementMs: Map<string, number>;
    avatarPresentations: Map<string, RelicAvatarPresentation>;
    playerLabels: Map<string, Mesh>;
    playerLabelTextures: Map<string, DynamicTexture>;
    relics: Map<string, Mesh>;
    props: Map<string, readonly Mesh[]>;
    hands: readonly Mesh[];
    handMaterial: PBRMaterial;
    flameTexture: DynamicTexture;
    roomParticles: Map<string, readonly ParticleSystem[]>;
    links: Mesh[];
    flickerLights: PointLight[];
    effects: TimedEffect[];
    seenEventIds: Set<string>;
    eventCueQueue: RelicEvent[];
    nextEventCueAtMs: { value: number };
    eventPlaybackPrimed: { value: boolean };
    focusRoomId: { value?: string };
    rtcReady: { value: boolean };
    inputEnabled: { value: boolean };
    prompt: { value?: ScenePrompt };
    onPromptChange: { value(prompt?: ScenePrompt): void };
    movePromptHold: { value?: HeldMovePrompt };
    inspection: { value?: InspectionFocus };
    doorPromptMarker: Mesh;
    doorPromptMarkerMaterial: StandardMaterial;
    escapeMarker: Mesh;
    escapeMarkerMaterial: StandardMaterial;
    remotePositions: Map<string, RemotePosEntry>;
    lastPosBroadcastMs: { value: number };
}>;

type RelicSceneLighting = Readonly<{
    sun: DirectionalLight;
    hemi: HemisphericLight;
    shadows: ShadowGenerator;
    activePresetId: { value: RelicLightingPresetId };
}>;

type TimedEffect = Readonly<{
    startedAt: number;
    durationMs: number;
    update(progress: number, elapsedMs: number): void;
    dispose(): void;
}>;

export function RelicScene({
                               snapshot,
                               localPlayerId,
                               selectedRoomId,
                               primedAction,
                               focusRoomId,
                               rtcReady = false,
                               inputEnabled = true,
                               onSelectRoom,
                               onPrimeAction,
                           }: RelicSceneProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<SceneRuntime | undefined>(undefined);
    const [sceneError, setSceneError] = useState<string | undefined>();
    const [scenePrompt, setScenePrompt] = useState<ScenePrompt | undefined>();
    const [cameraControl, setCameraControl] = useState<RelicSceneCameraControl>(DEFAULT_CAMERA_CONTROL);
    const snapshotRef = useRef(snapshot);
    const localPlayerIdRef = useRef(localPlayerId);
    const selectedRoomIdRef = useRef(selectedRoomId);
    const primedActionRef = useRef(primedAction);
    const rtcReadyRef = useRef(rtcReady);
    const inputEnabledRef = useRef(inputEnabled);
    const onSelectRoomRef = useRef(onSelectRoom);
    const onPrimeActionRef = useRef(onPrimeAction);
    const sceneObjective = deriveSceneObjective({
        snapshot,
        localPlayerId,
        primedAction,
    });

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);

    useEffect(() => {
        localPlayerIdRef.current = localPlayerId;
    }, [localPlayerId]);

    useEffect(() => {
        selectedRoomIdRef.current = selectedRoomId;
    }, [selectedRoomId]);

    useEffect(() => {
        primedActionRef.current = primedAction;
        if (runtimeRef.current) {
            runtimeRef.current.primedAction.value = primedAction;
        }
    }, [primedAction]);

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
            if (!inputEnabled) {
                runtimeRef.current.pointerLook.active = false;
                runtimeRef.current.pressedKeys.clear();
                if (document.pointerLockElement === runtimeRef.current.canvas) {
                    document.exitPointerLock?.();
                }
            }
        }
    }, [inputEnabled]);

    useEffect(() => {
        if (runtimeRef.current) {
            runtimeRef.current.objectiveTargetRoomId.value = sceneObjective.targetRoomId;
        }
    }, [sceneObjective.targetRoomId]);

    useEffect(() => {
        onSelectRoomRef.current = onSelectRoom;
    }, [onSelectRoom]);

    useEffect(() => {
        onPrimeActionRef.current = onPrimeAction;
    }, [onPrimeAction]);

    useEffect(() => {
        if (runtimeRef.current) {
            runtimeRef.current.focusRoomId.value = focusRoomId;
        }
    }, [focusRoomId]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        let runtime: SceneRuntime;
        try {
            runtime = createRelicSceneRuntime({
                canvas,
                snapshot: snapshotRef.current,
                localPlayerId: localPlayerIdRef.current,
                selectedRoomId: selectedRoomIdRef.current,
                primedAction: primedActionRef.current,
                rtcReady: rtcReadyRef.current,
                inputEnabled: inputEnabledRef.current,
                objectiveTargetRoomId: sceneObjective.targetRoomId,
                onPromptChange: setScenePrompt,
                onCameraControlChange: setCameraControl,
            });
            setSceneError(undefined);
        } catch (error) {
            setSceneError(error instanceof Error ? error.message : String(error));
            runtimeRef.current = undefined;
            return;
        }
        runtimeRef.current = runtime;
        syncScene(
            runtime,
            snapshotRef.current,
            localPlayerIdRef.current,
            selectedRoomIdRef.current,
        );

        runtime.scene.onPointerObservable.add((event) => {
            if (event.event.type !== 'pointerdown') {
                return;
            }
            if (!inputEnabledRef.current) {
                return;
            }

            const metadata = event.pickInfo?.pickedMesh?.metadata as
                | Readonly<{ roomId?: unknown; primeAction?: unknown; clueHotspotId?: unknown }>
                | undefined;
            if (metadata?.primeAction === 'search') {
                const started = startInspection(
                    runtime,
                    typeof metadata.clueHotspotId === 'string'
                        ? metadata.clueHotspotId
                        : undefined,
                );
                if (!started) {
                    onPrimeActionRef.current?.({ kind: 'search' });
                }
                return;
            }

            const roomId = metadata?.roomId;
            if (typeof roomId === 'string') {
                const moveAction = sceneMoveActionForPickedRoom({
                    snapshot: runtime.snapshot.value,
                    localPlayerId: runtime.localPlayerId.value,
                    roomId,
                });
                if (moveAction) {
                    primeSceneRuntimeAction(runtime, moveAction, onPrimeActionRef, onSelectRoomRef);
                    runtime.inspection.value = undefined;
                    return;
                }

                onSelectRoomRef.current(roomId);
                runtime.inspection.value = undefined;
                return;
            }

            runtime.inspection.value = undefined;
        });

        const resize = () => runtime.engine.resize();
        const pointerdown = (event: PointerEvent) => {
            if (!runtime.inputEnabled.value) {
                return;
            }
            if (event.button !== 0 && event.pointerType === 'mouse') {
                return;
            }

            canvas.focus();
            if (!canStartPointerLook(runtime)) {
                return;
            }
            runtime.pointerLook.active = true;
            runtime.pointerLook.lastX = event.clientX;
            runtime.pointerLook.lastY = event.clientY;
            runtime.pointerLook.pointerId = event.pointerId;
            if (event.pointerType === 'mouse') {
                const lockRequest = canvas.requestPointerLock?.();
                if (lockRequest instanceof Promise) {
                    void lockRequest.catch(() => undefined);
                }
            } else {
                canvas.setPointerCapture(event.pointerId);
            }
        };
        const pointermove = (event: PointerEvent) => {
            if (!runtime.inputEnabled.value) {
                return;
            }
            const lookScale = runtime.inspection.value ? 0.35 : 1;
            if (document.pointerLockElement === canvas) {
                applyPointerLook(runtime, event.movementX * lookScale, event.movementY * lookScale);
                return;
            }

            if (!runtime.pointerLook.active || runtime.pointerLook.pointerId !== event.pointerId) {
                return;
            }

            applyPointerLook(
                runtime,
                (event.clientX - runtime.pointerLook.lastX) * lookScale,
                (event.clientY - runtime.pointerLook.lastY) * lookScale,
            );
            runtime.pointerLook.lastX = event.clientX;
            runtime.pointerLook.lastY = event.clientY;
        };
        const pointerup = (event: PointerEvent) => {
            if (runtime.pointerLook.pointerId === event.pointerId) {
                runtime.pointerLook.active = false;
                runtime.pointerLook.pointerId = undefined;
            }
            if (canvas.hasPointerCapture(event.pointerId)) {
                canvas.releasePointerCapture(event.pointerId);
            }
        };
        const pointerlockchange = () => {
            runtime.pointerLook.active = document.pointerLockElement === canvas;
        };
        const keydown = (event: KeyboardEvent) => {
            const target = event.target;

            const isTyping = target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                (target instanceof HTMLElement && target.isContentEditable);

            if (!runtime.inputEnabled.value) {
                return;
            }
            if (event.key === 'Escape' && runtime.inspection.value) {
                runtime.inspection.value = undefined;
                setRuntimePrompt(runtime, undefined);
                event.preventDefault();
                return;
            }
            if (!isTyping && isRoamKey(event.key)) {
                runtime.pressedKeys.add(event.key.toLowerCase());
                event.preventDefault();
            }
        };
        const keyup = (event: KeyboardEvent) => {
            runtime.pressedKeys.delete(event.key.toLowerCase());
        };
        window.addEventListener('resize', resize);
        canvas.addEventListener('pointerdown', pointerdown);
        canvas.addEventListener('pointermove', pointermove);
        canvas.addEventListener('pointerup', pointerup);
        canvas.addEventListener('pointercancel', pointerup);
        document.addEventListener('pointerlockchange', pointerlockchange);
        window.addEventListener('keydown', keydown);
        window.addEventListener('keyup', keyup);

        startCappedRenderLoop(runtime.engine, SCENE_FRAME_INTERVAL_MS, () => {
            updateRuntime(runtime);
            renderRuntimeScene(runtime);
        });

        return () => {
            window.removeEventListener('resize', resize);
            canvas.removeEventListener('pointerdown', pointerdown);
            canvas.removeEventListener('pointermove', pointermove);
            canvas.removeEventListener('pointerup', pointerup);
            canvas.removeEventListener('pointercancel', pointerup);
            document.removeEventListener('pointerlockchange', pointerlockchange);
            window.removeEventListener('keydown', keydown);
            window.removeEventListener('keyup', keyup);
            delete canvas.dataset.sceneReady;
            delete canvas.dataset.sceneReadyMs;
            delete canvas.dataset.assetPipeline;
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
            delete canvas.dataset.sceneDrawCalls;
            delete canvas.dataset.sceneFps;
            delete canvas.dataset.cameraControl;
            runtime.scene.dispose();
            runtime.engine.dispose();
            runtimeRef.current = undefined;
        };
    }, []);

    useEffect(() => {
        if (!rtcReady) {
            return;
        }

        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }

        return subscribeRelicScenePositionUpdates(runtime);
    }, [rtcReady]);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }

        syncScene(runtime, snapshot, localPlayerId, selectedRoomId);
        renderRuntimeScene(runtime);
    }, [localPlayerId, selectedRoomId, snapshot]);

    const roomStateKey = [localPlayerId, snapshot?.players.find((p) => p.playerId === localPlayerId)?.roomId].join(':');
    const localPlayerActive = snapshot?.players.some(
        (p) => p.playerId === localPlayerId && !p.escaped && !p.defeated,
    ) ?? false;

    if (sceneError) {
        return (
            <FallbackRelicScene
                snapshot={snapshot}
                localPlayerId={localPlayerId}
                selectedRoomId={selectedRoomId}
                onSelectRoom={onSelectRoom}
                reason={sceneError}
            />
        );
    }

    return (
        <>
            <canvas
                ref={canvasRef}
                className="relic-scene"
                aria-label="Relic Hunters castle"
                tabIndex={0}
            />
            <RoomStateOverlay key={roomStateKey} snapshot={snapshot} localPlayerId={localPlayerId}/>
            <TouchDPad active={inputEnabled && localPlayerActive}/>
            <SceneCameraControls
                active={!!snapshot && snapshot.phase !== 'lobby' && !!localPlayerId}
                selected={cameraControl}
                onSelect={(mode) => {
                    applySceneCameraControl(runtimeRef.current, mode);
                }}
            />
            <SceneInteractionPrompt
                prompt={scenePrompt}
                onPrimeAction={(action) => {
                    primeSceneRuntimeAction(runtimeRef.current, action, onPrimeActionRef, onSelectRoomRef);
                }}
            />
            <SceneObjectivePanel
                objective={sceneObjective}
                onPrimeAction={(action) => {
                    primeSceneRuntimeAction(runtimeRef.current, action, onPrimeActionRef, onSelectRoomRef);
                }}
            />
        </>
    );
}

function SceneCameraControls({
                                 active,
                                 selected,
                                 onSelect,
                             }: Readonly<{
    active: boolean;
    selected: RelicSceneCameraControl;
    onSelect(mode: RelicSceneCameraControl): void;
}>) {
    if (!active) {
        return null;
    }

    const options: readonly Readonly<{ mode: RelicSceneCameraControl; label: string }>[] = [
        { mode: 'flyover', label: 'Fly over rooms' },
        { mode: 'tactical', label: 'Tactical overview' },
        { mode: 'avatar', label: 'Avatar' },
    ];

    return (
        <div className="scene-camera-controls" role="group" aria-label="Camera controls">
            {options.map((option) => (
                <button
                    key={option.mode}
                    type="button"
                    className={selected === option.mode ? 'active' : ''}
                    aria-pressed={selected === option.mode}
                    onClick={() => onSelect(option.mode)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

function RoomStateOverlay({
                              snapshot,
                              localPlayerId,
                          }: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
}>) {
    if (!snapshot) return null;
    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);
    if (!localPlayer || localPlayer.escaped || localPlayer.defeated) return null;
    const room = snapshot.map.find((r) => r.id === localPlayer.roomId);
    if (!room) return null;
    const isSearched = snapshot.roomInvestigations?.some((inv) => inv.roomId === room.id);

    return (
        <>
            {room.unstable && !room.collapsed && (
                <div className="room-vignette vignette-unstable" aria-hidden="true"/>
            )}
            {room.kind === 'exit' && !localPlayer.escaped && (
                <div className="room-vignette vignette-exit" aria-hidden="true"/>
            )}
            {room.kind === 'monster' && !room.collapsed && (
                <div className="room-vignette vignette-monster" aria-hidden="true"/>
            )}
            {room.kind === 'trap' && !room.collapsed && (
                <div className="room-vignette vignette-trap" aria-hidden="true"/>
            )}
            <div className="room-kind-strip" aria-label="Room state">
                <span className={`room-kind-pill room-kind-${room.kind}`}>{room.kind}</span>
                {isSearched && (
                    <span className="room-kind-pill room-state-searched">searched</span>
                )}
                {room.unstable && !room.collapsed && (
                    <span className="room-kind-pill room-state-unstable">unstable</span>
                )}
            </div>
        </>
    );
}

function FallbackRelicScene({
                                snapshot,
                                localPlayerId,
                                selectedRoomId,
                                onSelectRoom,
                                reason,
                            }: RelicSceneProps & Readonly<{ reason: string }>) {
    if (!snapshot) {
        return (
            <div className="relic-scene relic-scene-fallback" aria-label="Relic Hunters tactical view">
                <div className="fallback-vista" title={reason}>
                    <strong>Relic Hunters</strong>
                    <span>The ruin waits beyond the gate.</span>
                </div>
            </div>
        );
    }

    const edges = snapshot.map.flatMap((room) =>
        room.neighbors
            .filter((neighborId) => room.id < neighborId)
            .map((neighborId) => ({
                from: room,
                to: snapshot.map.find((candidate) => candidate.id === neighborId),
            }))
            .filter((edge): edge is Readonly<{ from: RelicRoom; to: RelicRoom }> => !!edge.to)
    );

    return (
        <div className="relic-scene relic-scene-fallback" aria-label="Relic Hunters tactical view">
            <div className="fallback-map" title={reason}>
                <svg viewBox="0 0 100 100" aria-hidden="true">
                    {edges.map((edge) => {
                        const from = fallbackPoint(edge.from);
                        const to = fallbackPoint(edge.to);
                        return (
                            <line
                                key={`${edge.from.id}-${edge.to.id}`}
                                x1={from.x}
                                y1={from.y}
                                x2={to.x}
                                y2={to.y}
                            />
                        );
                    })}
                </svg>

                {snapshot.map.map((room) => {
                    const point = fallbackPoint(room);
                    const localPlayerHere = snapshot.players.some((player) =>
                        player.playerId === localPlayerId && player.roomId === room.id
                    );
                    return (
                        <button
                            type="button"
                            key={room.id}
                            className={[
                                'fallback-room',
                                room.id === selectedRoomId ? 'selected' : '',
                                room.unstable ? 'unstable' : '',
                                room.collapsed ? 'collapsed' : '',
                                localPlayerHere ? 'local' : '',
                            ].filter(Boolean).join(' ')}
                            style={{
                                left: `${point.x}%`,
                                top: `${point.y}%`,
                            }}
                            onClick={() => onSelectRoom(room.id)}
                        >
                            <span>{room.name}</span>
                        </button>
                    );
                })}

                {snapshot.players.map((player, index) => {
                    const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
                    const presentation = deriveRelicAvatarPresentation({
                        phase: snapshot.phase,
                        player,
                        submittedPlayerIds: snapshot.submittedPlayerIds,
                        isMoving: false,
                    });
                    if (!room || !presentation.visible) {
                        return null;
                    }

                    const point = fallbackPoint(room);
                    const character = findRelicCharacter(player.characterId);
                    const offset = fallbackPlayerOffset(index);
                    return (
                        <span
                            key={player.playerId}
                            className={[
                                'fallback-hunter',
                                player.playerId === localPlayerId ? 'local' : '',
                                `is-${presentation.status}`,
                            ].filter(Boolean).join(' ')}
                            style={{
                                left: `${point.x + offset.x}%`,
                                top: `${point.y + offset.y}%`,
                                background: character.colors.accent,
                                opacity: presentation.opacity,
                                transform: `translate(-50%, -50%) scale(${presentation.baseScale})`,
                            }}
                            title={`${player.username}: ${character.name}`}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function createRelicSceneRuntime({
                                     canvas,
                                     snapshot,
                                     localPlayerId,
                                     selectedRoomId,
                                     primedAction,
                                     rtcReady,
                                     inputEnabled,
                                     objectiveTargetRoomId,
                                     onPromptChange,
                                     onCameraControlChange,
                                 }: Readonly<{
    canvas: HTMLCanvasElement;
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    primedAction?: RelicActionInput;
    rtcReady: boolean;
    inputEnabled: boolean;
    objectiveTargetRoomId?: string;
    onPromptChange(prompt?: ScenePrompt): void;
    onCameraControlChange(mode: RelicSceneCameraControl): void;
}>): SceneRuntime {
    const engine = new Engine(canvas, true, {
        antialias: true,
        preserveDrawingBuffer: false,
        stencil: true,
        adaptToDeviceRatio: true,
        limitDeviceRatio: 2,
    });

    const initialLighting = lightingPresetById('day');
    const scene = new Scene(engine);
    scene.clearColor = color4FromHex(initialLighting.clearColor);
    scene.ambientColor = Color3.FromHexString(initialLighting.ambientColor);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = Color3.FromHexString(initialLighting.fogColor);
    scene.fogDensity = initialLighting.fogDensity;

    const camera = new UniversalCamera(
        'relic-camera',
        new Vector3(0, PLAYER_EYE_Y, -9),
        scene,
    );
    camera.setTarget(new Vector3(0, PLAYER_EYE_Y, 0));
    camera.fov = 0.94;
    camera.minZ = 0.05;
    camera.maxZ = 180;
    renderSceneFrame(scene, canvas);

    const pipeline = createRelicPostProcess(scene, camera);
    const lighting = createRelicSceneLighting(scene, initialLighting);
    installShadowRegistration(scene, lighting.shadows);
    installSkybox(scene);
    scene.environmentIntensity = initialLighting.environmentIntensity;
    canvas.dataset.lightingPreset = initialLighting.id;
    canvas.dataset.cameraControl = DEFAULT_CAMERA_CONTROL;

    const flameTexture = createFlameTexture(scene);
    const handMaterial = new PBRMaterial('first-person-hands-material', scene);
    const castleMaterials = createCastleMaterials(scene);
    const introMeshes = createJapaneseLobbyScene(scene);
    const {
        doorPromptMarker,
        doorPromptMarkerMaterial,
        escapeMarker,
        escapeMarkerMaterial,
    } = createObjectiveMarkers(scene);

    return {
        canvas,
        engine,
        scene,
        camera,
        pipeline,
        shadows: lighting.shadows,
        lighting,
        createdAtMs: performance.now(),
        castleMaterials,
        introMeshes,
        snapshot: { value: snapshot },
        localPlayerId: { value: localPlayerId },
        selectedRoomId: { value: selectedRoomId },
        primedAction: { value: primedAction },
        objectiveTargetRoomId: { value: objectiveTargetRoomId },
        pressedKeys: new Set(),
        cameraYaw: { value: 0 },
        cameraPitch: { value: 0 },
        cameraMode: { value: 'lobby' },
        lastRoamInputMs: { value: undefined },
        cameraTarget: new Vector3(0, PLAYER_EYE_Y, 0),
        cameraControl: {
            selected: { value: DEFAULT_CAMERA_CONTROL },
            manualMode: { value: 'auto' },
            flyover: { value: undefined },
            onChange: { value: onCameraControlChange },
        },
        pointerLook: {
            active: false,
            lastX: 0,
            lastY: 0,
        },
        roamOffset: new Vector3(0, 0, 0),
        roamRoomId: { value: undefined },
        rooms: new Map(),
        roomMaterials: new Map(),
        roomBlockers: new Map(),
        roomLights: new Map(),
        players: new Map(),
        playerMaterials: new Map(),
        playerCharacterIds: new Map(),
        playerTargets: new Map(),
        avatarParts: new Map(),
        avatarMaterials: new Map(),
        avatarLastPositions: new Map(),
        avatarLastMovementMs: new Map(),
        avatarPresentations: new Map(),
        playerLabels: new Map(),
        playerLabelTextures: new Map(),
        relics: new Map(),
        props: new Map(),
        hands: createFirstPersonHands(scene, handMaterial),
        handMaterial,
        flameTexture,
        roomParticles: new Map(),
        links: [],
        flickerLights: [],
        effects: [],
        seenEventIds: new Set(),
        eventCueQueue: [],
        nextEventCueAtMs: { value: 0 },
        eventPlaybackPrimed: { value: false },
        focusRoomId: { value: undefined },
        rtcReady: { value: rtcReady },
        inputEnabled: { value: inputEnabled },
        prompt: { value: undefined },
        onPromptChange: { value: onPromptChange },
        movePromptHold: { value: undefined },
        inspection: { value: undefined },
        doorPromptMarker,
        doorPromptMarkerMaterial,
        escapeMarker,
        escapeMarkerMaterial,
        remotePositions: new Map(),
        lastPosBroadcastMs: { value: 0 },
    };
}

function createRelicPostProcess(
    scene: Scene,
    camera: UniversalCamera,
): DefaultRenderingPipeline {
    const pipeline = new DefaultRenderingPipeline('relic-pipeline', true, scene, [camera]);

    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.72;
    pipeline.bloomWeight = 0.22;
    pipeline.bloomKernel = 24;
    pipeline.bloomScale = 0.66;

    pipeline.sharpenEnabled = true;
    pipeline.sharpen.edgeAmount = 0.64;
    pipeline.sharpen.colorAmount = 0.18;

    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.contrast = 1.16;
    pipeline.imageProcessing.exposure = 1.14;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;

    const curves = new ColorCurves();
    curves.globalSaturation = 18;
    curves.highlightsHue = 35;
    curves.highlightsDensity = 22;
    curves.shadowsHue = 215;
    curves.shadowsDensity = 16;
    pipeline.imageProcessing.colorCurvesEnabled = true;
    pipeline.imageProcessing.colorCurves = curves;

    pipeline.imageProcessing.vignetteEnabled = true;
    pipeline.imageProcessing.vignetteWeight = 0.92;
    pipeline.imageProcessing.vignetteStretch = 0.55;
    pipeline.imageProcessing.vignetteCameraFov = camera.fov;
    pipeline.imageProcessing.vignetteColor = new Color4(0.04, 0.02, 0.07, 0);

    pipeline.grainEnabled = true;
    pipeline.grain.intensity = 1.25;
    pipeline.grain.animated = true;

    try {
        const ssao = new SSAO2RenderingPipeline('relic-ssao', scene, { ssaoRatio: 0.75, blurRatio: 0.25 }, [camera]);
        ssao.radius = 1.25;
        ssao.totalStrength = 0.55;
        ssao.base = 0.04;
        ssao.maxZ = 40;
        ssao.samples = 8;
    } catch {
        // SSAO2 is not available in every browser context.
    }

    const glowLayer = new GlowLayer('relic-glow', scene);
    glowLayer.intensity = 0.72;

    return pipeline;
}

function createRelicSceneLighting(
    scene: Scene,
    preset: RelicLightingPreset,
): RelicSceneLighting {
    const sunLight = new DirectionalLight('relic-sun', vectorFromTuple(preset.sunDirection), scene);
    sunLight.position = vectorFromTuple(preset.sunPosition);
    sunLight.intensity = preset.sunIntensity;
    sunLight.diffuse = Color3.FromHexString(preset.sunDiffuse);
    sunLight.specular = Color3.FromHexString(preset.sunSpecular);

    const shadows = new ShadowGenerator(1024, sunLight);
    shadows.useBlurExponentialShadowMap = true;
    shadows.blurKernel = preset.shadowBlurKernel;
    shadows.darkness = preset.shadowDarkness;

    const light = new HemisphericLight('ruin-light', vectorFromTuple(preset.hemiDirection), scene);
    light.intensity = preset.hemiIntensity;
    light.diffuse = Color3.FromHexString(preset.hemiDiffuse);
    light.groundColor = Color3.FromHexString(preset.hemiGround);

    return {
        sun: sunLight,
        hemi: light,
        shadows,
        activePresetId: { value: preset.id },
    };
}

function installShadowRegistration(scene: Scene, shadows: ShadowGenerator): void {
    scene.onNewMeshAddedObservable.add((mesh) => {
        if (mesh.name.startsWith('relic-skybox') || mesh.name.startsWith('label-')) return;
        shadows.addShadowCaster(mesh, false);
        mesh.receiveShadows = true;
    });
}

function installSkybox(scene: Scene): void {
    const envTexture = buildSkyEnvironmentTexture(scene);
    scene.environmentTexture = envTexture;
    scene.environmentIntensity = 0.58;

    const skybox = MeshBuilder.CreateBox('relic-skybox', { size: 750 }, scene);
    const skyMat = new StandardMaterial('relic-skybox-mat', scene);
    skyMat.backFaceCulling = false;
    skyMat.disableLighting = true;
    const skyboxTex = envTexture.clone();
    skyboxTex.coordinatesMode = 5; // Texture.SKYBOX_MODE
    skyMat.reflectionTexture = skyboxTex;
    skyMat.diffuseColor = new Color3(0, 0, 0);
    skyMat.specularColor = new Color3(0, 0, 0);
    skybox.material = skyMat;
    skybox.infiniteDistance = true;
    skybox.isPickable = false;
}

function createObjectiveMarkers(scene: Scene): Readonly<{
    doorPromptMarker: Mesh;
    doorPromptMarkerMaterial: StandardMaterial;
    escapeMarker: Mesh;
    escapeMarkerMaterial: StandardMaterial;
}> {
    const doorPromptMarkerMaterial = new StandardMaterial('doorway-prompt-marker-material', scene);
    doorPromptMarkerMaterial.diffuseColor = Color3.FromHexString('#8ee7f5');
    doorPromptMarkerMaterial.emissiveColor = Color3.FromHexString('#8ee7f5').scale(0.62);
    doorPromptMarkerMaterial.specularColor = Color3.FromHexString('#fef08a').scale(0.26);
    doorPromptMarkerMaterial.alpha = 0.72;

    const doorPromptMarker = MeshBuilder.CreateTorus(
        'doorway-prompt-marker',
        {
            diameter: DOOR_WIDTH * 0.72,
            thickness: 0.045,
            tessellation: 42,
        },
        scene,
    );
    doorPromptMarker.material = doorPromptMarkerMaterial;
    doorPromptMarker.rotation.x = Math.PI / 2;
    doorPromptMarker.setEnabled(false);

    const escapeMarkerMaterial = new StandardMaterial('escape-objective-marker-material', scene);
    escapeMarkerMaterial.diffuseColor = Color3.FromHexString('#a3e635');
    escapeMarkerMaterial.emissiveColor = Color3.FromHexString('#a3e635').scale(0.52);
    escapeMarkerMaterial.specularColor = Color3.FromHexString('#fef08a').scale(0.32);
    escapeMarkerMaterial.alpha = 0.68;

    const escapeMarker = MeshBuilder.CreateTorus(
        'escape-objective-marker',
        {
            diameter: 1.52,
            thickness: 0.052,
            tessellation: 48,
        },
        scene,
    );
    escapeMarker.material = escapeMarkerMaterial;
    escapeMarker.rotation.x = Math.PI / 2;
    escapeMarker.setEnabled(false);

    return {
        doorPromptMarker,
        doorPromptMarkerMaterial,
        escapeMarker,
        escapeMarkerMaterial,
    };
}

function renderRuntimeScene(runtime: SceneRuntime): void {
    resetDrawCallCounter(runtime.engine);
    renderSceneFrame(runtime.scene, runtime.canvas);
    publishSceneAssetMetrics(runtime);
}

function renderSceneFrame(scene: Scene, canvas: HTMLCanvasElement): void {
    scene.render();
    if (canvas.dataset.sceneReady !== 'true' && renderedFrameHasVisiblePixel(canvas)) {
        canvas.dataset.sceneReady = 'true';
    }
}

function publishSceneAssetMetrics(runtime: SceneRuntime): void {
    const activeMeshes = runtime.scene.getActiveMeshes();
    const drawCalls = drawCallCount(runtime.engine);
    runtime.canvas.dataset.assetPipeline = CURRENT_RELIC_ASSET_PIPELINE.strategy;
    runtime.canvas.dataset.sceneMeshCount = String(runtime.scene.meshes.length);
    runtime.canvas.dataset.sceneActiveMeshCount = String(activeMeshes.length);
    runtime.canvas.dataset.sceneMaterialCount = String(runtime.scene.materials.length);
    runtime.canvas.dataset.sceneParticleSystemCount = String(runtime.scene.particleSystems.length);
    runtime.canvas.dataset.sceneActiveParticleSystemCount = String(activeParticleSystemCount(runtime));
    runtime.canvas.dataset.sceneActiveRoomLightCount = String(activeRoomLightCount(runtime));
    const batching = sceneStaticBatchMetrics(runtime);
    runtime.canvas.dataset.sceneStaticBatchCount = String(batching.batchCount);
    runtime.canvas.dataset.sceneBatchedMeshCount = String(batching.batchedMeshCount);
    runtime.canvas.dataset.sceneActiveEffectCount = String(runtime.effects.length);
    runtime.canvas.dataset.sceneEffectMeshCount = String(sceneEffectMeshCount(runtime));
    runtime.canvas.dataset.sceneDrawCalls = typeof drawCalls === 'number' ? String(Math.round(drawCalls)) : '';
    runtime.canvas.dataset.sceneFps = String(Math.round(runtime.engine.getFps()));
    if (runtime.canvas.dataset.sceneReady === 'true' && !runtime.canvas.dataset.sceneReadyMs) {
        runtime.canvas.dataset.sceneReadyMs = String(Math.round(performance.now() - runtime.createdAtMs));
    }
}

function activeParticleSystemCount(runtime: SceneRuntime): number {
    return runtime.scene.particleSystems.filter((system) => system.isStarted()).length;
}

function activeRoomLightCount(runtime: SceneRuntime): number {
    let active = 0;
    for (const lights of runtime.roomLights.values()) {
        active += lights.filter((light) => light.isEnabled()).length;
    }
    return active;
}

function sceneStaticBatchMetrics(runtime: SceneRuntime): Readonly<{
    batchCount: number;
    batchedMeshCount: number;
}> {
    let batchCount = 0;
    let batchedMeshCount = 0;
    for (const mesh of runtime.scene.meshes) {
        const metadata = mesh.metadata as
            | Readonly<{ staticBatch?: unknown; batchedMeshCount?: unknown }>
            | undefined;
        if (metadata?.staticBatch !== true) {
            continue;
        }
        batchCount += 1;
        batchedMeshCount += typeof metadata.batchedMeshCount === 'number'
            ? metadata.batchedMeshCount
            : 0;
    }
    return { batchCount, batchedMeshCount };
}

function sceneEffectMeshCount(runtime: SceneRuntime): number {
    return runtime.scene.meshes.filter((mesh) => mesh.name.startsWith('effect-')).length;
}

function drawCallCount(engine: Engine): number | undefined {
    const counter = (engine as unknown as {
        _drawCalls?: Readonly<{
            current?: number;
            lastSecAverage?: number;
        }>;
    })._drawCalls;
    const value = counter?.current ?? counter?.lastSecAverage;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resetDrawCallCounter(engine: Engine): void {
    const counter = (engine as unknown as {
        _drawCalls?: Readonly<{ fetchNewFrame?(): void }>;
    })._drawCalls;
    counter?.fetchNewFrame?.();
}

function renderedFrameHasVisiblePixel(canvas: HTMLCanvasElement): boolean {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) {
        return false;
    }

    try {
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (width <= 0 || height <= 0) {
            return false;
        }

        const pixels = new Uint8Array(4);
        const samples: readonly Readonly<[number, number]>[] = [
            [0.5, 0.5],
            [0.34, 0.42],
            [0.66, 0.42],
            [0.5, 0.28],
            [0.5, 0.72],
        ];
        for (const [xRatio, yRatio] of samples) {
            gl.readPixels(
                Math.min(width - 1, Math.max(0, Math.floor(width * xRatio))),
                Math.min(height - 1, Math.max(0, Math.floor(height * yRatio))),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels,
            );
            if (pixels[3] > 0 && (pixels[0] > 4 || pixels[1] > 4 || pixels[2] > 4)) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

function syncScene(
    runtime: SceneRuntime,
    snapshot: RelicPublicSnapshot | undefined,
    localPlayerId: string | undefined,
    selectedRoomId: string | undefined,
): void {
    if (!snapshot) {
        runtime.snapshot.value = undefined;
        runtime.localPlayerId.value = localPlayerId;
        runtime.selectedRoomId.value = selectedRoomId;
        return;
    }

    runtime.snapshot.value = snapshot;
    runtime.localPlayerId.value = localPlayerId;
    runtime.selectedRoomId.value = selectedRoomId;
    syncLinks(runtime, snapshot.map);
    syncRooms(runtime, snapshot.map, selectedRoomId);
    syncPlayers(runtime, snapshot);
    syncRelics(runtime, snapshot);
    syncEventEffects(runtime, snapshot);
}

function primeSceneRuntimeAction(
    runtime: SceneRuntime | undefined,
    action: RelicActionInput,
    onPrimeActionRef: { current: RelicSceneProps['onPrimeAction'] },
    onSelectRoomRef: { current(roomId: string): void },
): void {
    if (runtime) {
        spawnPrimeActionEffect(runtime, action);
    }
    onPrimeActionRef.current?.(action);
    if (action.kind === 'move' && action.targetRoomId) {
        onSelectRoomRef.current(action.targetRoomId);
    }
}

function applySceneCameraControl(
    runtime: SceneRuntime | undefined,
    mode: RelicSceneCameraControl,
): void {
    if (!runtime) {
        return;
    }

    runtime.inspection.value = undefined;
    if (mode === 'flyover') {
        runtime.cameraControl.flyover.value = {
            startedAtMs: performance.now(),
            returnPose: currentCameraPose(runtime),
            returnControl: runtime.cameraControl.selected.value,
            returnManualMode: runtime.cameraControl.manualMode.value,
        };
        setSceneCameraControl(runtime, 'flyover', runtime.cameraControl.manualMode.value);
        return;
    }

    runtime.cameraControl.flyover.value = undefined;
    runtime.lastRoamInputMs.value = mode === 'avatar'
        ? performance.now()
        : undefined;
    setSceneCameraControl(runtime, mode, mode);
}

function setSceneCameraControl(
    runtime: SceneRuntime,
    selected: RelicSceneCameraControl,
    manualMode: RelicSceneManualCameraMode,
): void {
    runtime.cameraControl.selected.value = selected;
    runtime.cameraControl.manualMode.value = manualMode;
    runtime.canvas.dataset.cameraControl = selected;
    runtime.cameraControl.onChange.value(selected);
}

function currentCameraPose(runtime: SceneRuntime): RelicCameraPose {
    return {
        position: runtime.camera.position.clone(),
        target: runtime.cameraTarget.clone(),
        fov: runtime.camera.fov,
    };
}

function syncLinks(runtime: SceneRuntime, rooms: readonly RelicRoom[]): void {
    if (runtime.links.length > 0) {
        return;
    }

    for (const room of rooms) {
        for (const neighborId of room.neighbors) {
            if (room.id > neighborId) {
                continue;
            }

            const neighbor = rooms.find((candidate) => candidate.id === neighborId);
            if (!neighbor) {
                continue;
            }

            runtime.links.push(...createCastleCorridor(runtime, room, neighbor));
        }
    }
}

function syncRooms(
    runtime: SceneRuntime,
    rooms: readonly RelicRoom[],
    selectedRoomId: string | undefined,
): void {
    for (const room of rooms) {
        let mesh = runtime.rooms.get(room.id);
        if (!mesh) {
            mesh = MeshBuilder.CreateBox(
                `room-${room.id}`,
                {
                    width: ROOM_SIZE,
                    height: 0.12,
                    depth: ROOM_SIZE,
                },
                runtime.scene,
            );
            const world = roomWorldPosition(room);
            mesh.position.set(world.x, FLOOR_Y, world.z);
            mesh.metadata = { roomId: room.id };
            runtime.rooms.set(room.id, mesh);
            runtime.props.set(room.id, createRoomProps(runtime, room, rooms, mesh));
            runtime.roomBlockers.set(room.id, roomCollisionBoxes(room));
            runtime.roomLights.set(room.id, createRoomLights(runtime, room));
            runtime.roomParticles.set(room.id, [
                ...createRoomTorchParticles(runtime.scene, room, runtime.flameTexture),
                ...createRoomAtmosphereParticles(runtime.scene, room, runtime.flameTexture),
            ]);
        }

        let material = runtime.roomMaterials.get(room.id);
        if (!material) {
            material = new PBRMaterial(`room-material-${room.id}`, runtime.scene);
            runtime.roomMaterials.set(room.id, material);
        }
        applyRoomMaterial(material, room, room.id === selectedRoomId);
        mesh.material = material;
        mesh.scaling.y = room.collapsed ? 0.58 : 1;
        mesh.rotation.z = room.unstable && !room.collapsed ? 0.015 : 0;
        for (const prop of runtime.props.get(room.id) ?? []) {
            prop.setEnabled(true);
        }
    }
}

function syncPlayers(
    runtime: SceneRuntime,
    snapshot: RelicPublicSnapshot,
): void {
    const seen = new Set<string>();
    for (const [index, player] of snapshot.players.entries()) {
        seen.add(player.playerId);
        let mesh = runtime.players.get(player.playerId);
        if (!mesh || runtime.playerCharacterIds.get(player.playerId) !== player.characterId) {
            disposeAvatar(runtime, player.playerId);
            const avatar = createPlayerAvatar(runtime, player);
            mesh = avatar.root;
            runtime.players.set(player.playerId, mesh);
            runtime.avatarParts.set(player.playerId, avatar.parts);
            runtime.avatarMaterials.set(player.playerId, avatar.materials);
            runtime.playerMaterials.set(player.playerId, avatar.materials[0]);
            runtime.playerCharacterIds.set(player.playerId, player.characterId);
            const { plane, texture } = createPlayerLabel(runtime, player);
            runtime.playerLabels.set(player.playerId, plane);
            runtime.playerLabelTextures.set(player.playerId, texture);
        }

        const character = findRelicCharacter(player.characterId);
        const labelTexture = runtime.playerLabelTextures.get(player.playerId);
        if (labelTexture) {
            drawPlayerLabel(
                labelTexture,
                player.username,
                player.health,
                player.relicIds.length,
                character.colors.accent,
            );
        }

        if (snapshot.phase === 'lobby') {
            // Show all hunters lined up in the castle courtyard, visible from lobby camera
            const spacing = 1.8;
            const totalWidth = (snapshot.players.length - 1) * spacing;
            const startX = -totalWidth / 2;
            const target = new Vector3(startX + index * spacing, 0.65, 1.8);
            if (!runtime.playerTargets.has(player.playerId)) {
                mesh.position.copyFrom(target);
            }
            runtime.playerTargets.set(player.playerId, target);
            setAvatarEnabled(runtime, player.playerId, true);
        } else {
            const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
            if (room) {
                const remote = runtime.remotePositions.get(player.playerId);
                if (remote?.roomId && remote.roomId !== player.roomId) {
                    runtime.remotePositions.delete(player.playerId);
                }

                const world = roomWorldPosition(room);
                const offset = toPlayerOffset(index);
                const target = new Vector3(world.x + offset.x, 0.65, world.z + offset.z);
                if (!runtime.playerTargets.has(player.playerId)) {
                    mesh.position.copyFrom(target);
                }
                runtime.playerTargets.set(player.playerId, target);
            }
            setAvatarEnabled(runtime, player.playerId, true);
        }
    }

    for (const [playerId, mesh] of runtime.players.entries()) {
        if (!seen.has(playerId)) {
            disposeAvatar(runtime, playerId);
        }
    }
}

function createPlayerAvatar(
    runtime: SceneRuntime,
    player: RelicPublicSnapshot['players'][number],
): Readonly<{
    root: Mesh;
    parts: readonly Mesh[];
    materials: readonly PBRMaterial[];
}> {
    const character = findRelicCharacter(player.characterId);
    const pid = player.playerId;
    const isBulwark = character.silhouette === 'bulwark';

    // Three-tier PBR materials: cloth (soft), armour plate (semi-metal), gold trim (mirror)
    const primary   = materialFromHex(runtime.scene, `av-pri-${pid}`, character.colors.primary,   0.02, 0.04, 0.62);
    const secondary = materialFromHex(runtime.scene, `av-sec-${pid}`, character.colors.secondary, 0.01, 0.62, 0.28);
    const accent    = materialFromHex(runtime.scene, `av-acc-${pid}`, character.colors.accent,    0.10, 0.92, 0.12);
    const blade     = materialFromHex(runtime.scene, `av-bld-${pid}`, '#a8b8bc',                  0.00, 0.88, 0.22);

    // === ROOT: readable low-poly hunter body ===
    const root = MeshBuilder.CreateCylinder(`av-body-${pid}`, {
        height: 0.66,
        diameterTop:    isBulwark ? 0.54 : 0.46,
        diameterBottom: isBulwark ? 0.80 : 0.70,
        tessellation: 10,
    }, runtime.scene);
    root.material = primary;
    root.metadata = { playerId: pid };

    const parts: Mesh[] = [root];
    const mats: PBRMaterial[] = [primary, secondary, accent, blade];

    const addPart = (mesh: Mesh, material: PBRMaterial) => {
        mesh.parent = root;
        mesh.material = material;
        mesh.metadata = { playerId: pid };
        parts.push(mesh);
        return mesh;
    };

    // Hakama fold accent band
    addPart(MeshBuilder.CreateCylinder(`av-band-${pid}`, {
        height: 0.08, diameterTop: isBulwark ? 0.60 : 0.52, diameterBottom: isBulwark ? 0.60 : 0.52, tessellation: 10,
    }, runtime.scene), accent).position.y = 0.16;

    const floorMark = addPart(MeshBuilder.CreateCylinder(`av-floor-mark-${pid}`, {
        height: 0.018, diameter: isBulwark ? 0.88 : 0.78, tessellation: 28,
    }, runtime.scene), accent);
    floorMark.position.y = -0.57;
    floorMark.scaling.z = 0.68;

    // === LEGS ===
    for (const [side, xOff] of [[-1, -0.10], [1, 0.10]] as [number, number][]) {
        // Suneate (shin guard)
        addPart(MeshBuilder.CreateCylinder(`av-shin-${side}-${pid}`, {
            height: 0.35, diameterTop: 0.17, diameterBottom: 0.14, tessellation: 7,
        }, runtime.scene), secondary).position.set(xOff, -0.32, 0.01);

        // Tabi boot
        const boot = addPart(MeshBuilder.CreateBox(`av-boot-${side}-${pid}`, {
            width: 0.19, height: 0.12, depth: 0.27,
        }, runtime.scene), primary);
        boot.position.set(xOff, -0.53, 0.05);
    }

    // === TORSO ===
    // Koshi-obi (hip sash)
    addPart(MeshBuilder.CreateCylinder(`av-waist-${pid}`, {
        height: 0.14, diameterTop: isBulwark ? 0.64 : 0.54, diameterBottom: isBulwark ? 0.66 : 0.56, tessellation: 10,
    }, runtime.scene), accent).position.y = 0.42;

    // Dō (chest armour plate)
    const chest = addPart(MeshBuilder.CreateBox(`av-chest-${pid}`, {
        width: isBulwark ? 0.60 : 0.50, height: 0.52, depth: 0.35,
    }, runtime.scene), secondary);
    chest.position.y = 0.78;

    // Lamellar rows on chest (two horizontal accent strips)
    addPart(MeshBuilder.CreateBox(`av-chest-rim1-${pid}`, {
        width: isBulwark ? 0.62 : 0.54, height: 0.065, depth: 0.36,
    }, runtime.scene), accent).position.y = 0.86;
    addPart(MeshBuilder.CreateBox(`av-chest-rim2-${pid}`, {
        width: isBulwark ? 0.62 : 0.54, height: 0.06, depth: 0.36,
    }, runtime.scene), accent).position.y = 0.62;

    const backBanner = addPart(MeshBuilder.CreateBox(`av-back-banner-${pid}`, {
        width: 0.16, height: 0.66, depth: 0.045,
    }, runtime.scene), accent);
    backBanner.position.set(0, 0.82, -0.23);

    // Neck cylinder
    addPart(MeshBuilder.CreateCylinder(`av-neck-${pid}`, {
        height: 0.16, diameter: 0.20, tessellation: 8,
    }, runtime.scene), primary).position.y = 1.10;

    // === ARMS (left and right) ===
    for (const [side, sign] of [[-1, -1], [1, 1]] as [number, number][]) {
        // Ō-sode (large shoulder board)
        const sode = addPart(MeshBuilder.CreateBox(`av-sode-${side}-${pid}`, {
            width: 0.14, height: 0.44, depth: 0.36,
        }, runtime.scene), secondary);
        sode.position.set(sign * 0.42, 0.84, -0.02);
        sode.rotation.z = sign * 0.28;

        // Sode lamellar accent
        const sodeRim = addPart(MeshBuilder.CreateBox(`av-sode-rim-${side}-${pid}`, {
            width: 0.15, height: 0.065, depth: 0.36,
        }, runtime.scene), accent);
        sodeRim.position.set(sign * 0.42, 0.71, -0.02);
        sodeRim.rotation.z = sign * 0.28;

        // Upper arm
        const uArm = addPart(MeshBuilder.CreateCylinder(`av-uarm-${side}-${pid}`, {
            height: 0.30, diameterTop: 0.13, diameterBottom: 0.16, tessellation: 7,
        }, runtime.scene), primary);
        uArm.position.set(sign * 0.39, 0.62, 0.01);
        uArm.rotation.z = sign * 0.75;

        // Lower arm / kote (armoured gauntlet)
        const lArm = addPart(MeshBuilder.CreateCylinder(`av-larm-${side}-${pid}`, {
            height: 0.28, diameterTop: 0.11, diameterBottom: 0.13, tessellation: 7,
        }, runtime.scene), secondary);
        lArm.position.set(sign * 0.51, 0.43, 0.04);
        lArm.rotation.z = sign * 0.94;
        lArm.rotation.x = 0.12;
    }

    // === HEAD ===
    // Kabuto dome (flattened sphere)
    const kabuto = addPart(MeshBuilder.CreateSphere(`av-kabuto-${pid}`, {
        diameter: 0.48, segments: 12,
    }, runtime.scene), accent);
    kabuto.position.y = 1.32;
    kabuto.scaling.set(1.0, 0.72, 1.0);

    // Hachi brow ridge
    addPart(MeshBuilder.CreateBox(`av-hachi-${pid}`, {
        width: 0.50, height: 0.08, depth: 0.42,
    }, runtime.scene), secondary).position.y = 1.22;

    // Shikoro — inner neckguard disc
    const shikoro = addPart(MeshBuilder.CreateDisc(`av-shikoro-${pid}`, {
        radius: 0.34, tessellation: 20,
    }, runtime.scene), secondary);
    shikoro.position.y = 1.14;
    shikoro.rotation.x = Math.PI / 2;

    // Shikoro outer accent ring
    const shikoroRing = addPart(MeshBuilder.CreateDisc(`av-shikoro-ring-${pid}`, {
        radius: 0.38, tessellation: 20,
    }, runtime.scene), accent);
    shikoroRing.position.y = 1.10;
    shikoroRing.rotation.x = Math.PI / 2;

    // Fukigaeshi — ear flap plates (left and right)
    for (const [side, sign] of [[-1, -1], [1, 1]] as [number, number][]) {
        const fuki = addPart(MeshBuilder.CreateBox(`av-fuki-${side}-${pid}`, {
            width: 0.075, height: 0.20, depth: 0.17,
        }, runtime.scene), secondary);
        fuki.position.set(sign * 0.26, 1.27, -0.01);
        fuki.rotation.z = sign * 0.55;
    }

    // Menpo — lower face mask
    const menpo = addPart(MeshBuilder.CreateBox(`av-menpo-${pid}`, {
        width: 0.34, height: 0.22, depth: 0.20,
    }, runtime.scene), secondary);
    menpo.position.set(0, 1.16, 0.12);

    // Menpo nose bridge
    const noseBridge = addPart(MeshBuilder.CreateBox(`av-nose-${pid}`, {
        width: 0.065, height: 0.11, depth: 0.11,
    }, runtime.scene), accent);
    noseBridge.position.set(0, 1.23, 0.22);

    // Maedate (front crest — tall dramatic plate)
    const crest = addPart(MeshBuilder.CreateBox(`av-crest-${pid}`, {
        width: 0.075, height: 0.38, depth: 0.06,
    }, runtime.scene), accent);
    crest.position.set(0, 1.55, 0.17);
    crest.rotation.x = -0.22;

    // === KATANA at hip (daisho carry) ===
    const saya = addPart(MeshBuilder.CreateBox(`av-saya-${pid}`, {
        width: 0.065, height: 0.82, depth: 0.085,
    }, runtime.scene), primary);
    saya.position.set(-0.28, 0.36, 0.17);
    saya.rotation.z = 0.30;

    const tsuba = addPart(MeshBuilder.CreateCylinder(`av-tsuba-${pid}`, {
        height: 0.03, diameter: 0.14, tessellation: 10,
    }, runtime.scene), accent);
    tsuba.position.set(-0.13, 0.68, 0.17);
    tsuba.rotation.x = Math.PI / 2;

    const tsuka = addPart(MeshBuilder.CreateBox(`av-tsuka-${pid}`, {
        width: 0.06, height: 0.26, depth: 0.085,
    }, runtime.scene), primary);
    tsuka.position.set(-0.04, 0.78, 0.17);
    tsuka.rotation.z = 0.30;

    const signature = addSignatureProp(runtime, root, character, pid, accent, blade);
    parts.push(...signature);

    return { root, parts, materials: mats };
}

function addSignatureProp(
    runtime: SceneRuntime,
    root: Mesh,
    character: RelicCharacter,
    playerId: string,
    material: PBRMaterial,
    bladeMaterial: PBRMaterial,
): readonly Mesh[] {
    const parts: Mesh[] = [];
    const add = (mesh: Mesh, mat: PBRMaterial = material) => {
        mesh.parent = root;
        mesh.material = mat;
        mesh.metadata = { playerId };
        parts.push(mesh);
        return mesh;
    };

    switch (character.silhouette) {
        case 'vanguard':
        case 'bulwark': {
            // Large round shield (tate) held at left side
            const shield = add(MeshBuilder.CreateCylinder(
                `avatar-shield-${playerId}`,
                { height: 0.085, diameter: 0.68, tessellation: 7 },
                runtime.scene,
            ));
            shield.position.set(-0.50, 0.25, 0.13);
            shield.rotation.z = Math.PI / 2;
            // Shield boss (centre umbo)
            add(MeshBuilder.CreateSphere(`avatar-shield-boss-${playerId}`, { diameter: 0.16, segments: 8 }, runtime.scene))
                .position.set(-0.56, 0.25, 0.13);
            break;
        }
        case 'scout':
        case 'stormrunner': {
            // Paper lantern held at side
            const lantern = add(MeshBuilder.CreateSphere(
                `avatar-lantern-${playerId}`,
                { diameter: 0.28, segments: 10 },
                runtime.scene,
            ));
            lantern.position.set(0.48, 0.16, 0.28);
            lantern.scaling.set(1, 1.3, 1);
            // Lantern cord
            add(MeshBuilder.CreateCylinder(`avatar-lantern-cord-${playerId}`, { height: 0.18, diameter: 0.025, tessellation: 4 }, runtime.scene))
                .position.set(0.48, 0.36, 0.28);
            break;
        }
        case 'scholar':
        case 'seer': {
            // Magical halo ring above head
            const halo = add(MeshBuilder.CreateTorus(
                `avatar-halo-${playerId}`,
                { diameter: 0.68, thickness: 0.04, tessellation: 28 },
                runtime.scene,
            ));
            halo.position.set(0, 1.68, 0);
            halo.rotation.x = Math.PI / 2;
            // Inner halo ring (smaller, different accent)
            add(MeshBuilder.CreateTorus(`avatar-halo-inner-${playerId}`, { diameter: 0.44, thickness: 0.025, tessellation: 20 }, runtime.scene))
                .position.set(0, 1.73, 0);
            (parts[parts.length - 1]).rotation.x = Math.PI / 2;
            break;
        }
        case 'trapbreaker': {
            // Long polearm / tool carried at side
            const tool = add(MeshBuilder.CreateBox(
                `avatar-tool-${playerId}`,
                { width: 0.07, height: 0.88, depth: 0.085 },
                runtime.scene,
            ));
            tool.position.set(0.52, 0.14, 0);
            tool.rotation.z = 0.28;
            // Tool head
            add(MeshBuilder.CreateBox(`avatar-tool-head-${playerId}`, { width: 0.20, height: 0.15, depth: 0.12 }, runtime.scene), bladeMaterial)
                .position.set(0.68, 0.66, 0);
            break;
        }
        case 'duelist':
        case 'hexblade': {
            // Second drawn blade held in right hand (nito style)
            const drawn = add(MeshBuilder.CreateBox(
                `avatar-drawn-${playerId}`,
                { width: 0.055, height: 0.92, depth: 0.07 },
                runtime.scene,
            ), bladeMaterial);
            drawn.position.set(0.50, 0.30, 0.06);
            drawn.rotation.z = -0.38;
            // Tsuba on drawn blade
            add(MeshBuilder.CreateCylinder(`avatar-drawn-tsuba-${playerId}`, { height: 0.026, diameter: 0.13, tessellation: 8 }, runtime.scene))
                .position.set(0.34, 0.72, 0.06);
            (parts[parts.length - 1]).rotation.x = Math.PI / 2;
            break;
        }
        case 'trickster': {
            // Twin kunai knives
            for (const side of [-1, 1]) {
                const knife = add(MeshBuilder.CreateBox(
                    `avatar-knife-${playerId}-${side}`,
                    { width: 0.052, height: 0.48, depth: 0.06 },
                    runtime.scene,
                ), bladeMaterial);
                knife.position.set(side * 0.46, 0.20, 0.12);
                knife.rotation.z = side * 0.52;
            }
            break;
        }
    }

    return parts;
}

function createPlayerLabel(
    runtime: SceneRuntime,
    player: RelicPublicSnapshot['players'][number],
): { plane: Mesh; texture: DynamicTexture } {
    const texture = new DynamicTexture(
        `label-texture-${player.playerId}`,
        { width: 256, height: 64 },
        runtime.scene,
        false,
    );
    const mat = new StandardMaterial(`label-mat-${player.playerId}`, runtime.scene);
    mat.diffuseTexture = texture;
    mat.emissiveTexture = texture;
    mat.emissiveColor = Color3.White();
    mat.backFaceCulling = false;
    mat.useAlphaFromDiffuseTexture = true;
    mat.alpha = 0.92;

    const plane = MeshBuilder.CreatePlane(
        `label-plane-${player.playerId}`,
        { width: 1.0, height: 0.25 },
        runtime.scene,
    );
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.material = mat;
    plane.setEnabled(false);
    return { plane, texture };
}

function drawPlayerLabel(
    texture: DynamicTexture,
    username: string,
    health: number,
    relicCount: number,
    accentHex: string,
): void {
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    const w = 256;
    const h = 64;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(14, 12, 10, 0.78)';
    ctx.fillRect(4, 4, w - 8, h - 8);

    ctx.font = PLAYER_LABEL_MODE === 'details'
        ? 'bold 17px sans-serif'
        : 'bold 22px sans-serif';
    ctx.fillStyle = accentHex;
    ctx.textAlign = 'center';
    ctx.textBaseline = PLAYER_LABEL_MODE === 'details' ? 'top' : 'middle';
    const label = username.length > 14 ? `${username.slice(0, 12)}…` : username;
    ctx.fillText(label, w / 2, PLAYER_LABEL_MODE === 'details' ? 8 : h / 2);

    if (PLAYER_LABEL_MODE !== 'details') {
        texture.update();
        return;
    }

    const barX = 18;
    const barY = 38;
    const barW = w - 36;
    const barH = 8;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(barX, barY, barW, barH);
    const hFrac = Math.max(0, Math.min(1, health / 3));
    ctx.fillStyle = hFrac > 0.65 ? '#4ade80' : hFrac > 0.32 ? '#fbbf24' : '#f87171';
    ctx.fillRect(barX, barY, Math.round(barW * hFrac), barH);

    if (relicCount > 0) {
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#f2c14e';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(`◆${relicCount}`, w - 18, 8);
    }

    texture.update();
}

function setAvatarEnabled(
    runtime: SceneRuntime,
    playerId: string,
    enabled: boolean,
    labelVisible = enabled,
): void {
    for (const part of runtime.avatarParts.get(playerId) ?? []) {
        part.setEnabled(enabled);
    }
    runtime.playerLabels.get(playerId)?.setEnabled(labelVisible && PLAYER_LABEL_MODE !== 'hidden');
}

function disposeAvatar(runtime: SceneRuntime, playerId: string): void {
    for (const part of runtime.avatarParts.get(playerId) ?? []) {
        part.dispose();
    }
    for (const material of runtime.avatarMaterials.get(playerId) ?? []) {
        material.dispose();
    }
    runtime.playerLabels.get(playerId)?.dispose();
    runtime.playerLabelTextures.get(playerId)?.dispose();
    runtime.players.delete(playerId);
    runtime.playerMaterials.delete(playerId);
    runtime.playerTargets.delete(playerId);
    runtime.playerCharacterIds.delete(playerId);
    runtime.avatarParts.delete(playerId);
    runtime.avatarMaterials.delete(playerId);
    runtime.avatarLastPositions.delete(playerId);
    runtime.avatarLastMovementMs.delete(playerId);
    runtime.avatarPresentations.delete(playerId);
    runtime.playerLabels.delete(playerId);
    runtime.playerLabelTextures.delete(playerId);
}

function syncRelics(runtime: SceneRuntime, snapshot: RelicPublicSnapshot): void {
    const seen = new Set<string>();
    for (const relic of snapshot.relics) {
        if (relic.carriedBy || relic.escapedBy || !relic.foundBy) {
            continue;
        }
        seen.add(relic.id);
        let mesh = runtime.relics.get(relic.id);
        if (!mesh) {
            mesh = MeshBuilder.CreateBox(
                `relic-${relic.id}`,
                { size: 0.3 },
                runtime.scene,
            );
            const material = new PBRMaterial(`relic-material-${relic.id}`, runtime.scene);
            material.albedoColor = Color3.FromHexString('#f1c453');
            material.emissiveColor = Color3.FromHexString('#f2c14e').scale(0.52);
            material.metallic = 0.82;
            material.roughness = 0.18;
            mesh.material = material;
            mesh.position.y = 0.72;
            runtime.relics.set(relic.id, mesh);
        }
        const room = snapshot.map.find((candidate) => candidate.id === relic.roomId);
        if (room) {
            const world = roomWorldPosition(room);
            mesh.position.x = world.x;
            mesh.position.z = world.z;
        }
    }

    for (const [relicId, mesh] of runtime.relics.entries()) {
        if (!seen.has(relicId)) {
            mesh.dispose();
            runtime.relics.delete(relicId);
        }
    }
}

function createFirstPersonHands(
    scene: Scene,
    material: PBRMaterial,
): readonly Mesh[] {
    material.albedoColor = Color3.FromHexString('#0f766e');
    material.emissiveColor = Color3.FromHexString('#f2c14e').scale(0.08);
    material.metallic = 0.05;
    material.roughness = 0.85;

    return [-1, 1].map((side) => {
        const hand = MeshBuilder.CreateCapsule(
            `first-person-hand-${side}`,
            {
                height: 0.42,
                radius: 0.075,
                tessellation: 10,
            },
            scene,
        );
        hand.material = material;
        hand.rotation.x = Math.PI / 2;
        hand.setEnabled(false);
        return hand;
    });
}

function syncEventEffects(runtime: SceneRuntime, snapshot: RelicPublicSnapshot): void {
    if (!runtime.eventPlaybackPrimed.value) {
        for (const event of snapshot.events) {
            runtime.seenEventIds.add(event.id);
        }
        runtime.eventPlaybackPrimed.value = true;
        return;
    }

    for (const event of snapshot.events) {
        if (runtime.seenEventIds.has(event.id)) {
            continue;
        }

        runtime.seenEventIds.add(event.id);
        if (event.animationCue) {
            runtime.eventCueQueue.push(event);
        }
    }
}

function updateRuntime(runtime: SceneRuntime): void {
    updateSceneVisibility(runtime);
    updateCameraPose(runtime);
    updatePlayerPositions(runtime);
    updateInteractionHighlights(runtime);
    updateFirstPersonHands(runtime);
    updateLightFlicker(runtime);
    updateQueuedEventCues(runtime);
    updateEffects(runtime);
    updateRelics(runtime);
    updateAvatarCompulsionState(runtime);
    updateDynamicPostProcess(runtime);
    if (runtime.inputEnabled.value) {
        broadcastLocalPosition(runtime);
    }
}

function updateSceneVisibility(runtime: SceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    const showIntro = !snapshot || !localPlayer || snapshot.phase === 'lobby';
    const activeEffectRoomIds = new Set(selectActiveEffectRoomIds({
        snapshot,
        localPlayerId,
        selectedRoomId: runtime.selectedRoomId.value,
        objectiveTargetRoomId: runtime.objectiveTargetRoomId.value,
        focusRoomId: runtime.focusRoomId.value,
    }));

    for (const mesh of runtime.introMeshes) {
        mesh.setEnabled(showIntro);
    }
    for (const mesh of runtime.rooms.values()) {
        mesh.setEnabled(!showIntro);
    }
    for (const mesh of runtime.links) {
        mesh.setEnabled(!showIntro);
    }
    for (const mesh of runtime.relics.values()) {
        mesh.setEnabled(!showIntro);
    }
    if (showIntro) {
        for (const parts of runtime.avatarParts.values()) {
            for (const mesh of parts) {
                mesh.setEnabled(false);
            }
        }
    }
    for (const props of runtime.props.values()) {
        for (const mesh of props) {
            mesh.setEnabled(!showIntro);
        }
    }
    for (const [roomId, lights] of runtime.roomLights.entries()) {
        const roomEffectsEnabled = !showIntro && activeEffectRoomIds.has(roomId);
        for (const light of lights) {
            light.setEnabled(roomEffectsEnabled);
        }
    }
    for (const [roomId, particles] of runtime.roomParticles.entries()) {
        const roomEffectsEnabled = !showIntro && activeEffectRoomIds.has(roomId);
        for (const system of particles) {
            if (!roomEffectsEnabled) {
                if (system.isStarted()) system.stop();
            } else {
                if (!system.isStarted()) system.start();
            }
        }
    }
}

function updatePlayerPositions(runtime: SceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((p) => p.playerId === localPlayerId);
    const dt = runtime.engine.getDeltaTime();
    const factor = Math.min(1, dt / 85);
    const rtcFactor = Math.min(1, dt / 32);
    const now = performance.now();

    for (const [playerId, mesh] of runtime.players.entries()) {
        const player = snapshot?.players.find((candidate) => candidate.playerId === playerId);
        if (!snapshot || !player) continue;

        if (snapshot.phase !== 'lobby' && playerId === localPlayerId && localPlayer && !localPlayer.escaped && !localPlayer.defeated) {
            // Local avatar: positioned directly from roamOffset so it matches the camera without lag
            const room = snapshot?.map.find((r) => r.id === localPlayer.roomId);
            if (room) {
                const world = roomWorldPosition(room);
                mesh.position.set(
                    world.x + runtime.roamOffset.x,
                    0.65,
                    world.z + runtime.roamOffset.z,
                );
                mesh.rotation.y = runtime.cameraYaw.value;
            }
        } else {
            const remote = player.escaped || player.defeated || snapshot.phase === 'lobby'
                ? undefined
                : runtime.remotePositions.get(playerId);
            if (isRemotePositionFreshForPlayer(remote, player.roomId, now)) {
                // Live WebRTC position — lerp quickly toward it
                mesh.position.x += (remote.x - mesh.position.x) * rtcFactor;
                mesh.position.y += (0.65 - mesh.position.y) * rtcFactor;
                mesh.position.z += (remote.z - mesh.position.z) * rtcFactor;
                mesh.rotation.y = remote.yaw;
            } else {
                // Fallback: lerp to snapshot-derived room centre target
                const target = runtime.playerTargets.get(playerId);
                if (!target) continue;
                const delta = target.subtract(mesh.position);
                if (delta.lengthSquared() < 0.002) {
                    mesh.position.copyFrom(target);
                } else {
                    mesh.position.addInPlace(delta.scale(factor));
                }
            }
        }

        const presentation = updateAvatarPresentation(runtime, snapshot, player, mesh, now);
        const label = runtime.playerLabels.get(playerId);
        if (label?.isEnabled()) {
            label.position.set(
                mesh.position.x,
                mesh.position.y + 1.56 * presentation.baseScale,
                mesh.position.z,
            );
        }
    }
}

function updateAvatarPresentation(
    runtime: SceneRuntime,
    snapshot: RelicPublicSnapshot,
    player: RelicPublicSnapshot['players'][number],
    mesh: Mesh,
    now: number,
): RelicAvatarPresentation {
    const previousPosition = runtime.avatarLastPositions.get(player.playerId);
    const movedDistanceSq = previousPosition ? Vector3.DistanceSquared(previousPosition, mesh.position) : 0;
    const isMoving = movedDistanceSq > 0.00028;
    if (isMoving) {
        runtime.avatarLastMovementMs.set(player.playerId, now);
    }
    const lastMovementMs = runtime.avatarLastMovementMs.get(player.playerId);
    const lastMovedAgoMs = typeof lastMovementMs === 'number' ? now - lastMovementMs : undefined;
    const presentation = deriveRelicAvatarPresentation({
        phase: snapshot.phase,
        player,
        submittedPlayerIds: snapshot.submittedPlayerIds,
        isMoving,
        lastMovedAgoMs,
    });
    const pose = avatarPoseOffsets({
        presentation,
        nowMs: now,
        lastMovedAgoMs,
    });

    runtime.avatarLastPositions.set(player.playerId, mesh.position.clone());
    runtime.avatarPresentations.set(player.playerId, presentation);
    setAvatarEnabled(runtime, player.playerId, presentation.visible, presentation.labelVisible);

    const scale = presentation.baseScale;
    mesh.scaling.set(scale, scale * pose.scaleY, scale);
    mesh.position.y = 0.65 + pose.yOffset;
    mesh.rotation.x = pose.pitch;
    mesh.rotation.z = pose.roll;

    for (const part of runtime.avatarParts.get(player.playerId) ?? []) {
        part.visibility = presentation.opacity;
    }

    return presentation;
}

function updateCameraPose(runtime: SceneRuntime): void {
    const now = performance.now();
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer || snapshot.phase === 'lobby') {
        setCameraMode(runtime, 'lobby');
        setRuntimePrompt(runtime, undefined);
        // Cinematic slow orbit around the Japanese lobby
        const t = now / 1000;
        const camX = Math.sin(t * 0.18) * 5.2;
        const camZ = -9.4 + Math.sin(t * 0.11) * 1.8;
        const camY = 1.76 + Math.sin(t * 0.14) * 0.32;
        const lookX = Math.sin(t * 0.08) * 1.4;
        const lookZ = 5.2 + Math.sin(t * 0.13) * 2.2;
        const lookY = 2.6 + Math.sin(t * 0.09) * 0.38;
        runtime.camera.fov += (0.9 - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 300);
        moveCameraToward(runtime, new Vector3(camX, camY, camZ), new Vector3(lookX, lookY, lookZ), 1800);
        return;
    }

    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) {
        return;
    }

    // Spectator camera: pan to event focus room when no keys are held.
    const focusRoomId = runtime.focusRoomId.value;
    const isRoaming = isAvatarCameraInputActive(runtime);
    if (isRoaming) {
        runtime.lastRoamInputMs.value = now;
    }
    const avatarReturn = avatarCameraReturnState({
        snapshotPhase: snapshot.phase,
        lastRoamInputMs: runtime.lastRoamInputMs.value,
        nowMs: now,
    });
    const mode = deriveRelicCameraMode({
        snapshot,
        localPlayerId,
        isRoaming: isRoaming || avatarReturn.phase === 'follow',
        isInspecting: !!runtime.inspection.value,
        focusRoomId,
    });
    setCameraMode(runtime, mode);
    if (mode === 'event-focus' && focusRoomId) {
        const focusRoom = snapshot.map.find((candidate) => candidate.id === focusRoomId);
        if (focusRoom) {
            const fw = roomWorldPosition(focusRoom);
            runtime.camera.fov += (0.88 - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 260);
            moveCameraToward(
                runtime,
                new Vector3(fw.x - 0.6, 5.4, fw.z - 4.2),
                new Vector3(fw.x, 0.8, fw.z),
                220,
            );
            return;
        }
    }

    const targetRoom = chooseLookRoom(snapshot, room, runtime.selectedRoomId.value);
    const roomWorld = roomWorldPosition(room);
    const targetWorld = targetRoom ? roomWorldPosition(targetRoom) : undefined;
    const forward = targetRoom
        ? new Vector3(targetWorld!.x - roomWorld.x, 0, targetWorld!.z - roomWorld.z).normalize()
        : new Vector3(0, 0, 1);
    const roamForward = updateLocalRoomRoam(runtime, room, forward);
    const playerPosition = new Vector3(
        roomWorld.x + runtime.roamOffset.x,
        0.65,
        roomWorld.z + runtime.roamOffset.z,
    );
    const inspection = runtime.inspection.value?.roomId === room.id
        ? runtime.inspection.value
        : undefined;
    const flyover = runtime.cameraControl.flyover.value;
    if (flyover) {
        updateRoomFlyoverCamera(runtime, snapshot, flyover, now);
        return;
    }

    if (runtime.cameraControl.manualMode.value === 'avatar') {
        setCameraMode(runtime, 'roam');
        const followPose = planAvatarFollowCameraPose(playerPosition, roamForward, runtime.cameraPitch.value);
        runtime.camera.fov += (followPose.fov - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 220);
        moveCameraToward(runtime, followPose.position, followPose.target, 90);
        return;
    }

    if (runtime.cameraControl.manualMode.value === 'tactical') {
        setCameraMode(runtime, 'tactical');
        const tacticalPose = planTacticalCameraPose({
            snapshot,
            currentRoom: room,
            selectedRoomId: runtime.selectedRoomId.value,
            objectiveTargetRoomId: runtime.objectiveTargetRoomId.value,
            aspectRatio: runtime.engine.getRenderWidth() / Math.max(1, runtime.engine.getRenderHeight()),
        });
        moveCameraToward(runtime, tacticalPose.position, tacticalPose.target, 360);
        runtime.camera.fov += (tacticalPose.fov - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 360);
        return;
    }

    if (mode === 'inspection' && inspection) {
        const clueWorld = roomWorld.add(new Vector3(
            inspection.hotspot.x,
            0.78,
            inspection.hotspot.z,
        ));
        const toClue = new Vector3(
            inspection.hotspot.x - runtime.roamOffset.x,
            0,
            inspection.hotspot.z - runtime.roamOffset.z,
        );
        const direction = toClue.lengthSquared() > 0.01
            ? toClue.normalize()
            : roamForward;
        const desiredPosition = new Vector3(
            playerPosition.x + direction.x * 0.26,
            PLAYER_EYE_Y - 0.03,
            playerPosition.z + direction.z * 0.26,
        );
        runtime.camera.fov += (0.9 - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 220);
        moveCameraToward(runtime, desiredPosition, clueWorld, 72);
        return;
    }

    if (mode === 'tactical') {
        const tacticalPose = planTacticalCameraPose({
            snapshot,
            currentRoom: room,
            selectedRoomId: runtime.selectedRoomId.value,
            objectiveTargetRoomId: runtime.objectiveTargetRoomId.value,
            aspectRatio: runtime.engine.getRenderWidth() / Math.max(1, runtime.engine.getRenderHeight()),
        });
        if (avatarReturn.phase === 'zoom-out') {
            const avatarPose = planAvatarFollowCameraPose(playerPosition, roamForward, runtime.cameraPitch.value);
            const pose = blendRelicCameraPose(avatarPose, tacticalPose, avatarReturn.progress);
            moveCameraToward(runtime, pose.position, pose.target, 820);
            runtime.camera.fov += (pose.fov - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 820);
            return;
        }

        moveCameraToward(runtime, tacticalPose.position, tacticalPose.target, 160);
        runtime.camera.fov += (tacticalPose.fov - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 260);
        return;
    }

    // 3rd-person follow camera — stays behind and above the avatar
    const followPose = planAvatarFollowCameraPose(playerPosition, roamForward, runtime.cameraPitch.value);
    runtime.camera.fov += (followPose.fov - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 220);
    moveCameraToward(runtime, followPose.position, followPose.target, 90);
}

function planAvatarFollowCameraPose(
    playerPosition: Vector3,
    roamForward: Vector3,
    cameraPitch: number,
): RelicCameraPose {
    const camDistance = 5.5 + Math.cos(cameraPitch) * 2.0;
    const camHeight = 3.8 + Math.sin(cameraPitch) * 2.5;
    return {
        position: new Vector3(
            playerPosition.x - roamForward.x * camDistance,
            playerPosition.y + camHeight,
            playerPosition.z - roamForward.z * camDistance,
        ),
        target: new Vector3(playerPosition.x, playerPosition.y + 1.1, playerPosition.z),
        fov: 0.94,
    };
}

function updateRoomFlyoverCamera(
    runtime: SceneRuntime,
    snapshot: RelicPublicSnapshot,
    flyover: SceneCameraFlyover,
    nowMs: number,
): void {
    const progress = Math.min(1, (nowMs - flyover.startedAtMs) / ROOM_FLYOVER_DURATION_MS);
    const pose = planRoomFlyoverCameraPose({
        rooms: snapshot.map,
        progress,
        returnPose: flyover.returnPose,
    });

    setCameraMode(runtime, 'flyover');
    moveCameraToward(runtime, pose.position, pose.target, 160);
    runtime.camera.fov += (pose.fov - runtime.camera.fov) * Math.min(1, runtime.engine.getDeltaTime() / 180);

    if (progress >= 1) {
        runtime.cameraControl.flyover.value = undefined;
        setSceneCameraControl(runtime, flyover.returnControl, flyover.returnManualMode);
    }
}

function isAvatarCameraInputActive(runtime: SceneRuntime): boolean {
    return hasPressed(runtime, 'w') ||
        hasPressed(runtime, 'a') ||
        hasPressed(runtime, 's') ||
        hasPressed(runtime, 'd') ||
        hasPressed(runtime, 'q') ||
        hasPressed(runtime, 'e') ||
        hasPressed(runtime, 'arrowup') ||
        hasPressed(runtime, 'arrowdown') ||
        hasPressed(runtime, 'arrowleft') ||
        hasPressed(runtime, 'arrowright');
}

function updateLocalRoomRoam(
    runtime: SceneRuntime,
    room: RelicRoom,
    fallbackForward: Vector3,
): Vector3 {
    if (runtime.roamRoomId.value !== room.id) {
        runtime.roamRoomId.value = room.id;
        runtime.roamOffset.set(0, 0, 0);
        runtime.cameraYaw.value = Math.atan2(fallbackForward.x, fallbackForward.z);
        runtime.cameraPitch.value = 0;
        runtime.movePromptHold.value = undefined;
    }

    const deltaSeconds = Math.min(0.05, runtime.engine.getDeltaTime() / 1000);
    const turnDirection =
        (hasPressed(runtime, 'arrowright') || hasPressed(runtime, 'e') ? 1 : 0) -
        (hasPressed(runtime, 'arrowleft') || hasPressed(runtime, 'q') ? 1 : 0);
    runtime.cameraYaw.value += turnDirection * deltaSeconds * 2.45;

    const forward = yawToForward(runtime.cameraYaw.value);
    const right = new Vector3(forward.z, 0, -forward.x);
    const movement = new Vector3(0, 0, 0);

    if (hasPressed(runtime, 'w') || hasPressed(runtime, 'arrowup')) {
        movement.addInPlace(forward);
    }
    if (hasPressed(runtime, 's') || hasPressed(runtime, 'arrowdown')) {
        movement.subtractInPlace(forward);
    }
    if (hasPressed(runtime, 'd')) {
        movement.addInPlace(right);
    }
    if (hasPressed(runtime, 'a')) {
        movement.subtractInPlace(right);
    }

    const movingForward = hasPressed(runtime, 'w') || hasPressed(runtime, 'arrowup');

    if (movement.lengthSquared() > 0) {
        movement.normalize();
        const speed = (hasPressed(runtime, 'shift') ? 4.1 : 2.45) *
            (runtime.inspection.value ? 0.34 : 1);
        const next = runtime.roamOffset.add(movement.scale(speed * deltaSeconds));
        runtime.roamOffset.copyFrom(resolveRoomRoam(
            runtime.roomBlockers,
            room.id,
            runtime.roamOffset,
            next,
        ));
    }

    if (shouldExitInspection(runtime, room)) {
        runtime.inspection.value = undefined;
    }
    const movementPrompt = movingForward && !runtime.inspection.value
        ? movePromptForForwardIntent(runtime, room, forward)
        : undefined;
    if (movementPrompt) {
        runtime.movePromptHold.value = {
            roomId: room.id,
            prompt: movementPrompt,
            expiresAtMs: performance.now() + MOVE_PROMPT_HOLD_MS,
        };
        setRuntimePrompt(runtime, movementPrompt);
        return forward;
    }
    const heldPrompt = runtime.movePromptHold.value;
    if (heldPrompt && heldPrompt.roomId === room.id && heldPrompt.expiresAtMs > performance.now()) {
        setRuntimePrompt(runtime, heldPrompt.prompt);
        return forward;
    }
    if (heldPrompt && heldPrompt.expiresAtMs <= performance.now()) {
        runtime.movePromptHold.value = undefined;
    }
    updateScenePrompt(runtime, room, forward);
    return forward;
}

function movePromptForForwardIntent(
    runtime: SceneRuntime,
    room: RelicRoom,
    forward: Vector3,
): Extract<ScenePrompt, { kind: 'move' }> | undefined {
    const snapshot = runtime.snapshot.value;
    const localPlayer = snapshot?.players.find((player) =>
        player.playerId === runtime.localPlayerId.value
    );
    if (
        !snapshot ||
        !localPlayer ||
        localPlayer.escaped ||
        localPlayer.defeated ||
        snapshot.phase !== 'planning' ||
        snapshot.submittedPlayerIds.includes(localPlayer.playerId)
    ) {
        return undefined;
    }

    const preferredTargetId = runtime.primedAction.value?.kind === 'move'
        ? runtime.primedAction.value.targetRoomId
        : runtime.objectiveTargetRoomId.value;
    const openNeighbors = room.neighbors
        .map((neighborId) => snapshot.map.find((candidate) => candidate.id === neighborId))
        .filter((neighbor): neighbor is RelicRoom => !!neighbor && !neighbor.collapsed);
    const preferred = preferredTargetId
        ? openNeighbors.find((neighbor) => neighbor.id === preferredTargetId)
        : undefined;
    const candidates = preferred ? [preferred] : openNeighbors;

    return candidates
        .map((neighbor) => {
            const direction = directionBetweenRooms(room, neighbor);
            const vector = directionVector(direction);
            return {
                score: forward.x * vector.x + forward.z * vector.z,
                prompt: {
                    kind: 'move',
                    roomId: neighbor.id,
                    roomName: neighbor.name,
                    direction,
                } satisfies Extract<ScenePrompt, { kind: 'move' }>,
            };
        })
        .filter((candidate) => candidate.score > 0.34)
        .sort((left, right) => right.score - left.score)[0]?.prompt;
}

function updateInteractionHighlights(runtime: SceneRuntime): void {
    const room = currentLocalRoom(runtime);
    const prompt = runtime.prompt.value;
    const now = performance.now();

    updateDoorPromptMarker(runtime, room, prompt, now);
    updateClueHotspotHighlights(runtime, room, prompt, now);
    updateEscapeObjectiveMarker(runtime, room, now);
}

function updateDoorPromptMarker(
    runtime: SceneRuntime,
    room: RelicRoom | undefined,
    prompt: ScenePrompt | undefined,
    now: number,
): void {
    const direction = prompt?.kind === 'move'
        ? prompt.direction
        : primedMoveDirection(runtime, room) ?? objectiveMoveDirection(runtime, room);
    if (!room || !direction) {
        runtime.doorPromptMarker.setEnabled(false);
        return;
    }

    const roomWorld = roomWorldPosition(room);
    const local = doorPromptLocalPosition(direction);
    runtime.doorPromptMarker.position.set(
        roomWorld.x + local.x,
        0.22,
        roomWorld.z + local.z,
    );
    const promptActive = prompt?.kind === 'move';
    const pulse = 1 + Math.sin(now / 120) * 0.08;
    runtime.doorPromptMarker.scaling.set(pulse, pulse, pulse);
    runtime.doorPromptMarkerMaterial.alpha = promptActive
        ? 0.6 + Math.sin(now / 130) * 0.12
        : 0.34 + Math.sin(now / 170) * 0.06;
    runtime.doorPromptMarker.setEnabled(true);
}

function updateClueHotspotHighlights(
    runtime: SceneRuntime,
    room: RelicRoom | undefined,
    prompt: ScenePrompt | undefined,
    now: number,
): void {
    const primedSearch = runtime.primedAction.value?.kind === 'search';
    const activeClueId = room && prompt?.kind === 'search'
        ? prompt.hotspotId ?? roomClueHotspot(room).id
        : room && primedSearch
            ? roomClueHotspot(room).id
            : undefined;
    const resolvedClue = room && runtime.snapshot.value
        ? roomHasResolvedClue(runtime.snapshot.value, room.id)
        : false;
    const pulse = 1 + Math.sin(now / (prompt?.kind === 'search' && prompt.inspecting ? 95 : 145)) *
        (prompt?.kind === 'search' && prompt.inspecting ? 0.16 : 0.09);

    for (const props of runtime.props.values()) {
        for (const mesh of props) {
            const metadata = mesh.metadata as
                | Readonly<{ roomId?: unknown; clueHotspotId?: unknown; resolvedOnly?: unknown }>
                | undefined;
            if (typeof metadata?.clueHotspotId !== 'string') {
                continue;
            }

            const sameRoom = metadata.roomId === room?.id;
            const resolvedOnly = metadata.resolvedOnly === true;
            if (resolvedOnly) {
                mesh.setEnabled(!!sameRoom && resolvedClue);
                mesh.visibility = sameRoom && resolvedClue ? 0.78 : 0;
                mesh.scaling.set(pulse, pulse, pulse);
                continue;
            }

            const active = metadata.clueHotspotId === activeClueId &&
                sameRoom;
            const resolved = resolvedClue && sameRoom;
            mesh.visibility = active ? 1 : resolved ? 0.72 : 0.52;
            mesh.scaling.set(active ? pulse : 1, active ? pulse : 1, active ? pulse : 1);
        }
    }
}

function updateEscapeObjectiveMarker(
    runtime: SceneRuntime,
    room: RelicRoom | undefined,
    now: number,
): void {
    const snapshot = runtime.snapshot.value;
    const localPlayer = snapshot?.players.find((player) =>
        player.playerId === runtime.localPlayerId.value
    );
    if (
        !snapshot ||
        !localPlayer ||
        room?.kind !== 'exit' ||
        snapshot.phase !== 'planning' ||
        localPlayer.escaped ||
        localPlayer.defeated ||
        snapshot.submittedPlayerIds.includes(localPlayer.playerId)
    ) {
        runtime.escapeMarker.setEnabled(false);
        return;
    }

    const roomWorld = roomWorldPosition(room);
    const clue = roomClueHotspot(room);
    const primed = runtime.primedAction.value?.kind === 'escape';
    const pulse = 1 + Math.sin(now / (primed ? 92 : 145)) * (primed ? 0.14 : 0.07);
    runtime.escapeMarker.position.set(
        roomWorld.x + clue.x,
        0.24,
        roomWorld.z + clue.z,
    );
    runtime.escapeMarker.scaling.set(pulse, pulse, pulse);
    runtime.escapeMarkerMaterial.alpha = primed
        ? 0.66 + Math.sin(now / 110) * 0.12
        : 0.42 + Math.sin(now / 170) * 0.08;
    runtime.escapeMarker.setEnabled(true);
}

function currentLocalRoom(runtime: SceneRuntime): RelicRoom | undefined {
    const snapshot = runtime.snapshot.value;
    const localPlayer = snapshot?.players.find((player) =>
        player.playerId === runtime.localPlayerId.value
    );
    if (!snapshot || !localPlayer || localPlayer.escaped || localPlayer.defeated) {
        return undefined;
    }

    return snapshot.map.find((room) => room.id === localPlayer.roomId);
}

function doorPromptLocalPosition(direction: CardinalDirection): Vector3 {
    const edge = ROOM_SIZE / 2 - 0.42;
    switch (direction) {
        case 'north':
            return new Vector3(0, 0, -edge);
        case 'south':
            return new Vector3(0, 0, edge);
        case 'east':
            return new Vector3(edge, 0, 0);
        case 'west':
            return new Vector3(-edge, 0, 0);
    }
}

function directionVector(direction: CardinalDirection): Vector3 {
    switch (direction) {
        case 'north':
            return new Vector3(0, 0, -1);
        case 'south':
            return new Vector3(0, 0, 1);
        case 'east':
            return new Vector3(1, 0, 0);
        case 'west':
            return new Vector3(-1, 0, 0);
    }
}

function primedMoveDirection(
    runtime: SceneRuntime,
    room: RelicRoom | undefined,
): CardinalDirection | undefined {
    const targetRoomId = runtime.primedAction.value?.kind === 'move'
        ? runtime.primedAction.value.targetRoomId
        : undefined;
    const snapshot = runtime.snapshot.value;
    if (!room || !snapshot || !targetRoomId || !room.neighbors.includes(targetRoomId)) {
        return undefined;
    }

    const target = snapshot.map.find((candidate) => candidate.id === targetRoomId);
    return target ? directionBetweenRooms(room, target) : undefined;
}

function objectiveMoveDirection(
    runtime: SceneRuntime,
    room: RelicRoom | undefined,
): CardinalDirection | undefined {
    const targetRoomId = runtime.objectiveTargetRoomId.value;
    const snapshot = runtime.snapshot.value;
    if (!room || !snapshot || !targetRoomId || !room.neighbors.includes(targetRoomId)) {
        return undefined;
    }

    const target = snapshot.map.find((candidate) => candidate.id === targetRoomId);
    return target ? directionBetweenRooms(room, target) : undefined;
}

function hasPressed(runtime: SceneRuntime, key: string): boolean {
    return runtime.pressedKeys.has(key);
}

function canStartPointerLook(runtime: SceneRuntime): boolean {
    return runtime.cameraMode.value === 'roam' ||
        runtime.cameraMode.value === 'inspection';
}

function setCameraMode(runtime: SceneRuntime, mode: RelicCameraMode): void {
    runtime.cameraMode.value = mode;
    runtime.canvas.dataset.cameraMode = mode;
    if (!canStartPointerLook(runtime)) {
        runtime.pointerLook.active = false;
        runtime.pointerLook.pointerId = undefined;
        if (document.pointerLockElement === runtime.canvas) {
            document.exitPointerLock?.();
        }
    }
}

function moveCameraToward(
    runtime: SceneRuntime,
    desiredPosition: Vector3,
    desiredTarget: Vector3,
    dampingMs: number,
): void {
    const factor = Math.min(1, runtime.engine.getDeltaTime() / dampingMs);
    runtime.camera.position.addInPlace(desiredPosition.subtract(runtime.camera.position).scale(factor));
    const currentTarget = runtime.cameraTarget;
    const nextTarget = currentTarget.add(desiredTarget.subtract(currentTarget).scale(factor));
    runtime.cameraTarget.copyFrom(nextTarget);
    runtime.camera.setTarget(nextTarget);
}

function updateFirstPersonHands(runtime: SceneRuntime): void {
    // Hands are not used in 3rd-person mode
    for (const hand of runtime.hands) {
        hand.setEnabled(false);
    }
}

function updateRelics(runtime: SceneRuntime): void {
    const now = performance.now();
    for (const [relicId, mesh] of runtime.relics.entries()) {
        const seed = relicId.charCodeAt(0) * 0.618;
        mesh.position.y = 0.72 + Math.sin(now / 820 + seed) * 0.14;
        mesh.rotation.y = now / 1400 + seed;
        mesh.rotation.x = Math.sin(now / 1100 + seed) * 0.28;
    }
}

function updateAvatarCompulsionState(runtime: SceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    if (!snapshot) return;
    const now = performance.now();

    for (const [playerId, materials] of runtime.avatarMaterials.entries()) {
        const presentation = runtime.avatarPresentations.get(playerId);
        if (!presentation) continue;
        applyAvatarMaterialPresentation(materials, presentation, now);
    }
}

function applyAvatarMaterialPresentation(
    materials: readonly PBRMaterial[],
    presentation: RelicAvatarPresentation,
    now: number,
): void {
    const [primary, secondary, accent, blade] = materials;
    if (!primary || !secondary || !accent || !blade) return;

    const pulse = 0.5 + Math.sin(now / 520) * 0.5;
    const slowPulse = 0.5 + Math.sin(now / 1800) * 0.5;
    let roleColor = Color3.Black();
    let primaryGlow = 0.035;
    let secondaryGlow = 0.025;
    let accentGlow = 0.28;

    switch (presentation.emissiveRole) {
        case 'action':
            roleColor = new Color3(0.22 + pulse * 0.26, 0.14 + pulse * 0.16, 0.02);
            primaryGlow = 0.08;
            secondaryGlow = 0.06;
            accentGlow = 0.46 + pulse * 0.16;
            break;
        case 'locked':
            roleColor = new Color3(0.04 + slowPulse * 0.03, 0.08 + slowPulse * 0.04, 0.30 + slowPulse * 0.12);
            primaryGlow = 0.05;
            secondaryGlow = 0.04;
            accentGlow = 0.34 + slowPulse * 0.10;
            break;
        case 'escaped':
            roleColor = new Color3(0.05, 0.30 + slowPulse * 0.08, 0.18 + slowPulse * 0.08);
            primaryGlow = 0.05;
            secondaryGlow = 0.06;
            accentGlow = 0.42;
            break;
        case 'defeated':
            roleColor = new Color3(0.16, 0.025, 0.02);
            primaryGlow = 0.015;
            secondaryGlow = 0.012;
            accentGlow = 0.10;
            break;
        case 'idle':
        default:
            roleColor = Color3.Black();
            break;
    }

    primary.emissiveColor = Color3.Lerp(
        primary.emissiveColor,
        primary.albedoColor.scale(primaryGlow).add(roleColor),
        0.08,
    );
    secondary.emissiveColor = Color3.Lerp(
        secondary.emissiveColor,
        secondary.albedoColor.scale(secondaryGlow).add(roleColor.scale(0.55)),
        0.08,
    );
    accent.emissiveColor = Color3.Lerp(
        accent.emissiveColor,
        accent.albedoColor.scale(accentGlow).add(roleColor.scale(0.75)),
        0.10,
    );
    blade.emissiveColor = Color3.Lerp(
        blade.emissiveColor,
        blade.albedoColor.scale(presentation.emissiveRole === 'defeated' ? 0.03 : 0.12),
        0.08,
    );
}

function updateDynamicPostProcess(runtime: SceneRuntime): void {
    const room = currentLocalRoom(runtime);
    const preset = selectRelicLightingPreset({
        snapshot: runtime.snapshot.value,
        currentRoom: room,
    });
    applyLightingPreset(runtime, preset);

    runtime.pipeline.depthOfFieldEnabled = false;

    const roomExposure = !room ? 0
        : room.kind === 'monster' ? -0.03
            : room.kind === 'trap' ? -0.01
                : room.kind === 'shrine' ? 0.02
                    : room.kind === 'treasure' ? 0.04
                        : room.kind === 'exit' ? 0.03
                            : 0;
    const roomContrast = !room ? 0
        : room.kind === 'monster' ? 0.06
            : room.kind === 'trap' ? 0.04
                : room.kind === 'treasure' ? -0.02
                    : 0;
    const roomVignette = !room ? 0
        : room.kind === 'monster' ? 0.16
            : room.kind === 'trap' ? 0.08
                : room.kind === 'exit' ? -0.08
                    : 0;

    const tExp = clamp(preset.postProcess.exposure + roomExposure, 1.08, 1.28);
    const tContrast = clamp(preset.postProcess.contrast + roomContrast, 1.06, 1.30);
    const tVignette = clamp(preset.postProcess.vignetteWeight + roomVignette, 0.45, 1.12);

    const lerpSpeed = Math.min(1, runtime.engine.getDeltaTime() / 550);
    const ip = runtime.pipeline.imageProcessing;
    ip.exposure += (tExp - ip.exposure) * lerpSpeed;
    ip.contrast += (tContrast - ip.contrast) * lerpSpeed;
    ip.vignetteWeight += (tVignette - ip.vignetteWeight) * lerpSpeed;
    runtime.pipeline.bloomWeight += (preset.postProcess.bloomWeight - runtime.pipeline.bloomWeight) * lerpSpeed;
    runtime.pipeline.grain.intensity += (preset.postProcess.grainIntensity - runtime.pipeline.grain.intensity) *
        lerpSpeed;
}

function updateLightFlicker(runtime: SceneRuntime): void {
    const now = performance.now();
    const preset = lightingPresetById(runtime.lighting.activePresetId.value);
    for (const light of runtime.flickerLights) {
        if (!light.isEnabled()) {
            continue;
        }
        const metadata = light.metadata as
            | Readonly<{ baseIntensity?: number; flickerSeed?: number }>
            | undefined;
        const base = metadata?.baseIntensity ?? light.intensity;
        const seed = metadata?.flickerSeed ?? 0;
        const flame = Math.sin(now / 92 + seed) * 0.08 + Math.sin(now / 37 + seed * 0.37) * 0.045;
        light.intensity = Math.max(0.08, base * preset.roomLightMultiplier + flame);
    }
}

function applyLightingPreset(runtime: SceneRuntime, preset: RelicLightingPreset): void {
    const factor = Math.min(1, runtime.engine.getDeltaTime() / 700);
    runtime.lighting.activePresetId.value = preset.id;
    runtime.canvas.dataset.lightingPreset = preset.id;

    runtime.scene.clearColor = lerpColor4(runtime.scene.clearColor, color4FromHex(preset.clearColor), factor);
    runtime.scene.ambientColor = Color3.Lerp(
        runtime.scene.ambientColor,
        Color3.FromHexString(preset.ambientColor),
        factor,
    );
    runtime.scene.fogColor = Color3.Lerp(
        runtime.scene.fogColor,
        Color3.FromHexString(preset.fogColor),
        factor,
    );
    runtime.scene.fogDensity += (preset.fogDensity - runtime.scene.fogDensity) * factor;
    runtime.scene.environmentIntensity += (preset.environmentIntensity - runtime.scene.environmentIntensity) * factor;

    runtime.lighting.sun.direction = Vector3.Lerp(
        runtime.lighting.sun.direction,
        vectorFromTuple(preset.sunDirection),
        factor,
    );
    runtime.lighting.sun.position = Vector3.Lerp(
        runtime.lighting.sun.position,
        vectorFromTuple(preset.sunPosition),
        factor,
    );
    runtime.lighting.sun.intensity += (preset.sunIntensity - runtime.lighting.sun.intensity) * factor;
    runtime.lighting.sun.diffuse = Color3.Lerp(
        runtime.lighting.sun.diffuse,
        Color3.FromHexString(preset.sunDiffuse),
        factor,
    );
    runtime.lighting.sun.specular = Color3.Lerp(
        runtime.lighting.sun.specular,
        Color3.FromHexString(preset.sunSpecular),
        factor,
    );

    runtime.lighting.hemi.direction = Vector3.Lerp(
        runtime.lighting.hemi.direction,
        vectorFromTuple(preset.hemiDirection),
        factor,
    );
    runtime.lighting.hemi.intensity += (preset.hemiIntensity - runtime.lighting.hemi.intensity) * factor;
    runtime.lighting.hemi.diffuse = Color3.Lerp(
        runtime.lighting.hemi.diffuse,
        Color3.FromHexString(preset.hemiDiffuse),
        factor,
    );
    runtime.lighting.hemi.groundColor = Color3.Lerp(
        runtime.lighting.hemi.groundColor,
        Color3.FromHexString(preset.hemiGround),
        factor,
    );
    runtime.lighting.shadows.darkness += (preset.shadowDarkness - runtime.lighting.shadows.darkness) * factor;
    runtime.lighting.shadows.blurKernel = preset.shadowBlurKernel;
}

function updateEffects(runtime: SceneRuntime): void {
    const now = performance.now();
    for (let index = runtime.effects.length - 1; index >= 0; index -= 1) {
        const effect = runtime.effects[index];
        const elapsedMs = now - effect.startedAt;
        const progress = Math.min(1, elapsedMs / effect.durationMs);
        effect.update(progress, elapsedMs);
        if (progress >= 1) {
            effect.dispose();
            runtime.effects.splice(index, 1);
        }
    }
}

function updateQueuedEventCues(runtime: SceneRuntime): void {
    const now = performance.now();
    if (now < runtime.nextEventCueAtMs.value) {
        return;
    }

    const event = runtime.eventCueQueue.shift();
    if (!event?.animationCue) {
        return;
    }

    const cue = event.animationCue;
    if (cue.roomId) {
        runtime.focusRoomId.value = cue.roomId;
    } else if (cue.playerId) {
        const snapshot = runtime.snapshot.value;
        const player = snapshot?.players.find((candidate) => candidate.playerId === cue.playerId);
        runtime.focusRoomId.value = player?.roomId ?? runtime.focusRoomId.value;
    }

    spawnCueEffect(runtime, cue);
    runtime.nextEventCueAtMs.value = now + Math.max(900, (cue.durationMs ?? 900) * 0.82);
}

function spawnPrimeActionEffect(runtime: SceneRuntime, action: RelicActionInput): void {
    if (action.kind === 'move' && action.targetRoomId) {
        const prompt = runtime.prompt.value;
        if (prompt?.kind === 'move' && prompt.roomId === action.targetRoomId) {
            const room = currentLocalRoom(runtime);
            const center = room
                ? roomWorldPosition(room).add(doorPromptLocalPosition(prompt.direction))
                : roomCenter(runtime, action.targetRoomId);
            spawnPulse(runtime, center, '#8ee7f5', 520, 'low');
            return;
        }

        spawnPulse(runtime, roomCenter(runtime, action.targetRoomId), '#8ee7f5', 520, 'low');
        return;
    }

    if (action.kind === 'search') {
        const room = currentLocalRoom(runtime);
        if (!room) {
            return;
        }

        const world = roomWorldPosition(room);
        const clue = roomClueHotspot(room);
        const center = new Vector3(world.x + clue.x, 0.4, world.z + clue.z);
        spawnPulse(runtime, center, '#f2c14e', 600, 'low');
        spawnGlow(runtime, center.add(new Vector3(0, 0.55, 0)), '#fef08a', 460);
    }

    if (action.kind === 'escape') {
        const room = currentLocalRoom(runtime);
        if (!room) {
            return;
        }

        const world = roomWorldPosition(room);
        const clue = roomClueHotspot(room);
        const center = new Vector3(world.x + clue.x, 0.32, world.z + clue.z);
        spawnPulse(runtime, center, '#a3e635', 700, 'medium');
        spawnGlow(runtime, center.add(new Vector3(0, 0.74, 0)), '#dcfce7', 520);
    }
}

function spawnCueEffect(runtime: SceneRuntime, cue: RelicAnimationCue): void {
    const durationMs = cue.durationMs ?? 800;
    const center = cue.roomId
        ? roomCenter(runtime, cue.roomId)
        : cue.playerId
            ? playerCenter(runtime, cue.playerId)
            : new Vector3(0, 0.2, 0);

    switch (cue.type) {
        case 'camera_move':
            spawnPulse(runtime, center, '#38bdf8', durationMs, cue.intensity);
            break;
        case 'search_altar':
            spawnPulse(runtime, center, '#f2c14e', durationMs, cue.intensity);
            spawnGlow(runtime, center.add(new Vector3(0, 0.72, 0)), '#f8e08e', durationMs);
            break;
        case 'relic_reveal':
            spawnPulse(runtime, center, '#a3e635', durationMs, cue.intensity);
            spawnGlow(runtime, center.add(new Vector3(0, 0.9, 0)), '#f2c14e', durationMs);
            spawnRelicFireworks(runtime, center, durationMs);
            break;
        case 'steal_attempt':
            spawnPulse(runtime, center, '#fb7185', durationMs, cue.intensity);
            spawnPlayerJolt(runtime, cue.playerId, durationMs, 0.34);
            spawnPlayerJolt(runtime, cue.targetPlayerId, durationMs, -0.24);
            break;
        case 'escape_run':
            spawnEscapeStreak(runtime, center, durationMs);
            break;
        case 'noise_pulse':
            spawnPulse(runtime, center, '#7dd3fc', durationMs, cue.intensity);
            break;
        case 'damage_shake':
            spawnRoomShake(runtime, cue.roomId, durationMs, cue.intensity);
            spawnPulse(runtime, center, '#f87171', durationMs, cue.intensity);
            break;
        case 'room_collapse':
            spawnRoomShake(runtime, cue.roomId, durationMs, cue.intensity);
            spawnPulse(runtime, center, '#f97316', durationMs, cue.intensity);
            spawnRubble(runtime, center, durationMs);
            break;
        case 'heart_relic_victory':
            spawnHeartRelic(runtime, durationMs);
            break;
    }
}

function spawnPulse(
    runtime: SceneRuntime,
    center: Vector3,
    hex: string,
    durationMs: number,
    intensity: RelicAnimationCue['intensity'] = 'medium',
): void {
    const mesh = MeshBuilder.CreateTorus(
        `effect-pulse-${runtime.effects.length}-${Date.now()}`,
        { diameter: 0.7, thickness: 0.035, tessellation: 48 },
        runtime.scene,
    );
    mesh.position.copyFrom(center);
    mesh.position.y = 0.18;
    const material = effectMaterial(runtime.scene, `pulse-material-${Date.now()}`, hex, 0.62);
    mesh.material = material;
    const maxScale = intensity === 'high' ? 4.8 : intensity === 'low' ? 2.4 : 3.5;
    runtime.effects.push({
        startedAt: performance.now(),
        durationMs,
        update(progress) {
            const eased = easeOut(progress);
            const scale = 0.24 + eased * maxScale;
            mesh.scaling.set(scale, scale, scale);
            material.alpha = (1 - progress) * 0.62;
        },
        dispose() {
            mesh.dispose();
            material.dispose();
        },
    });
}

function spawnGlow(
    runtime: SceneRuntime,
    center: Vector3,
    hex: string,
    durationMs: number,
): void {
    const mesh = MeshBuilder.CreateSphere(
        `effect-glow-${runtime.effects.length}-${Date.now()}`,
        { diameter: 0.48, segments: 16 },
        runtime.scene,
    );
    mesh.position.copyFrom(center);
    const material = effectMaterial(runtime.scene, `glow-material-${Date.now()}`, hex, 0.78);
    mesh.material = material;
    runtime.effects.push({
        startedAt: performance.now(),
        durationMs,
        update(progress, elapsedMs) {
            const pulse = 1 + Math.sin(elapsedMs / 90) * 0.12;
            const scale = pulse * (1 + easeOut(progress) * 0.7);
            mesh.scaling.set(scale, scale, scale);
            mesh.position.y = center.y + Math.sin(elapsedMs / 120) * 0.08;
            material.alpha = (1 - progress) * 0.78;
        },
        dispose() {
            mesh.dispose();
            material.dispose();
        },
    });
}

function spawnEscapeStreak(runtime: SceneRuntime, center: Vector3, durationMs: number): void {
    const material = effectMaterial(runtime.scene, `escape-material-${Date.now()}`, '#e0f2fe', 0.72);
    for (let index = 0; index < 4; index += 1) {
        const offset = (index - 1.5) * 0.14;
        const mesh = MeshBuilder.CreateTube(
            `effect-escape-${index}-${Date.now()}`,
            {
                path: [
                    center.add(new Vector3(offset, 0.38, -0.2)),
                    center.add(new Vector3(offset, 0.76, 1.8)),
                ],
                radius: 0.025,
            },
            runtime.scene,
        );
        mesh.material = material;
        runtime.effects.push({
            startedAt: performance.now(),
            durationMs,
            update(progress) {
                const eased = easeOut(progress);
                mesh.position.z = eased * 1.6;
                mesh.scaling.y = 1 + eased * 0.8;
                material.alpha = (1 - progress) * 0.72;
            },
            dispose() {
                mesh.dispose();
            },
        });
    }

    runtime.effects.push({
        startedAt: performance.now(),
        durationMs,
        update() {
            // Shared material fades from each streak update.
        },
        dispose() {
            material.dispose();
        },
    });
}

function spawnRubble(runtime: SceneRuntime, center: Vector3, durationMs: number): void {
    const material = effectMaterial(runtime.scene, `rubble-material-${Date.now()}`, '#a16207', 0.88);
    for (let index = 0; index < 7; index += 1) {
        const angle = (Math.PI * 2 * index) / 7;
        const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
        const mesh = MeshBuilder.CreateBox(
            `effect-rubble-${index}-${Date.now()}`,
            { size: 0.16 + (index % 3) * 0.035 },
            runtime.scene,
        );
        mesh.position.copyFrom(center.add(new Vector3(0, 0.38, 0)));
        mesh.material = material;
        runtime.effects.push({
            startedAt: performance.now(),
            durationMs,
            update(progress) {
                const eased = easeOut(progress);
                const drop = Math.sin(progress * Math.PI) * 0.55;
                mesh.position.copyFrom(center.add(direction.scale(eased * 1.15)));
                mesh.position.y = 0.38 + drop * (1 - progress);
                mesh.rotation.x += 0.08;
                mesh.rotation.z += 0.06;
                material.alpha = Math.max(0, (1 - progress) * 0.88);
            },
            dispose() {
                mesh.dispose();
            },
        });
    }

    runtime.effects.push({
        startedAt: performance.now(),
        durationMs,
        update() {
            // Shared material fades from each rubble update.
        },
        dispose() {
            material.dispose();
        },
    });
}

function spawnRoomShake(
    runtime: SceneRuntime,
    roomId: string | undefined,
    durationMs: number,
    intensity: RelicAnimationCue['intensity'] = 'medium',
): void {
    if (!roomId) {
        return;
    }

    const room = runtime.rooms.get(roomId);
    if (!room) {
        return;
    }

    const original = room.position.clone();
    const amplitude = intensity === 'high' ? 0.12 : intensity === 'low' ? 0.045 : 0.08;
    runtime.effects.push({
        startedAt: performance.now(),
        durationMs,
        update(progress, elapsedMs) {
            const falloff = 1 - progress;
            room.position.x = original.x + Math.sin(elapsedMs / 24) * amplitude * falloff;
            room.position.z = original.z + Math.cos(elapsedMs / 31) * amplitude * falloff;
        },
        dispose() {
            room.position.copyFrom(original);
        },
    });
}

function spawnPlayerJolt(
    runtime: SceneRuntime,
    playerId: string | undefined,
    durationMs: number,
    distance: number,
): void {
    if (!playerId) {
        return;
    }

    const mesh = runtime.players.get(playerId);
    const target = runtime.playerTargets.get(playerId);
    if (!mesh || !target) {
        return;
    }

    runtime.effects.push({
        startedAt: performance.now(),
        durationMs,
        update(progress) {
            const punch = Math.sin(progress * Math.PI) * distance;
            mesh.position.x = target.x + punch;
        },
        dispose() {
            mesh.position.copyFrom(target);
        },
    });
}

function spawnRelicFireworks(runtime: SceneRuntime, center: Vector3, durationMs: number): void {
    const colors = ['#f2c14e', '#fef08a', '#a3e635', '#fbbf24'];
    for (let i = 0; i < 12; i++) {
        const angle = (Math.PI * 2 * i) / 12;
        const elevation = Math.PI / 4 + (i % 3) * 0.18;
        const dir = new Vector3(
            Math.cos(angle) * Math.cos(elevation),
            Math.sin(elevation),
            Math.sin(angle) * Math.cos(elevation),
        );
        const speed = 1.4 + (i % 4) * 0.35;
        const hex = colors[i % colors.length];
        const mesh = MeshBuilder.CreateSphere(
            `effect-spark-${i}-${Date.now()}`,
            { diameter: 0.1, segments: 6 },
            runtime.scene,
        );
        mesh.position.copyFrom(center.add(new Vector3(0, 0.5, 0)));
        const material = effectMaterial(runtime.scene, `spark-mat-${i}-${Date.now()}`, hex, 0.92);
        mesh.material = material;
        const captured = { dir, speed };
        runtime.effects.push({
            startedAt: performance.now(),
            durationMs,
            update(progress) {
                const eased = easeOut(progress);
                const drop = -2.8 * progress * progress;
                mesh.position.copyFrom(center.add(new Vector3(
                    captured.dir.x * eased * captured.speed,
                    0.5 + captured.dir.y * eased * captured.speed * 0.72 + drop,
                    captured.dir.z * eased * captured.speed,
                )));
                material.alpha = Math.max(0, (1 - easeOut(progress)) * 0.92);
            },
            dispose() {
                mesh.dispose();
                material.dispose();
            },
        });
    }
}

function spawnHeartRelic(runtime: SceneRuntime, durationMs: number): void {
    const center = new Vector3(0, 1.2, 0);
    spawnPulse(runtime, center, '#f2c14e', durationMs, 'high');
    spawnGlow(runtime, center, '#fef08a', durationMs);
    const snapshot = runtime.snapshot.value;
    if (!snapshot) {
        return;
    }

    const winnerIds = new Set(snapshot.winnerIds);
    for (const player of snapshot.players) {
        const playerPosition = playerCenter(runtime, player.playerId);
        if (winnerIds.has(player.playerId)) {
            spawnEscapeStreak(runtime, playerPosition, durationMs);
            spawnGlow(runtime, playerPosition.add(new Vector3(0, 0.8, 0)), '#dcfce7', durationMs);
            continue;
        }

        spawnPulse(runtime, playerPosition, '#f87171', durationMs, 'medium');
        spawnRoomShake(runtime, player.roomId, durationMs, 'high');
    }

    for (const room of snapshot.map) {
        if (room.id !== 'entrance' && room.id !== 'exit') {
            spawnRoomShake(runtime, room.id, durationMs, 'medium');
        }
    }
}

function roomCenter(runtime: SceneRuntime, roomId: string): Vector3 {
    const room = runtime.rooms.get(roomId);
    return room
        ? new Vector3(room.position.x, 0.22, room.position.z)
        : new Vector3(0, 0.22, 0);
}

function playerCenter(runtime: SceneRuntime, playerId: string): Vector3 {
    const player = runtime.players.get(playerId);
    return player
        ? new Vector3(player.position.x, player.position.y, player.position.z)
        : new Vector3(0, 0.65, 0);
}

function materialFromHex(
    scene: Scene,
    name: string,
    hex: string,
    emissiveScale: number,
    metallic = 0.1,
    roughness = 0.72,
): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    const color = Color3.FromHexString(hex);
    material.albedoColor = color;
    material.emissiveColor = color.scale(emissiveScale);
    material.metallic = metallic;
    material.roughness = roughness;
    return material;
}

function vectorFromTuple(tuple: readonly [number, number, number]): Vector3 {
    return new Vector3(tuple[0], tuple[1], tuple[2]);
}

function color4FromHex(hex: string): Color4 {
    const color = Color3.FromHexString(hex);
    return new Color4(color.r, color.g, color.b, 1);
}

function lerpColor4(current: Color4, target: Color4, factor: number): Color4 {
    return new Color4(
        current.r + (target.r - current.r) * factor,
        current.g + (target.g - current.g) * factor,
        current.b + (target.b - current.b) * factor,
        current.a + (target.a - current.a) * factor,
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function effectMaterial(
    scene: Scene,
    name: string,
    hex: string,
    alpha: number,
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    const color = Color3.FromHexString(hex);
    material.diffuseColor = color;
    material.emissiveColor = color.scale(0.72);
    material.alpha = alpha;
    material.specularColor = color.scale(0.22);
    return material;
}

// Builds a 6-face CubeTexture from canvas-painted gradients representing a
// castle dusk sky. This gives PBR metals and gold a meaningful environment
// to reflect without requiring an external HDR file.
function buildSkyEnvironmentTexture(scene: Scene): CubeTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    function makeFace(topColor: string, botColor: string): string {
        const g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, topColor);
        g.addColorStop(1, botColor);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return canvas.toDataURL('image/png');
    }

    // Sky palette: midnight blue zenith fading to warm amber horizon
    const zenith  = '#07091c';
    const sky     = '#0d1028';
    const horizon = '#2e1a0a';
    const ground  = '#130e06';

    const faces = [
        makeFace(sky, horizon), // +X
        makeFace(sky, horizon), // -X
        makeFace(zenith, sky),  // +Y
        makeFace(ground, ground), // -Y
        makeFace(sky, horizon), // +Z
        makeFace(sky, horizon), // -Z
    ];

    const tex = CubeTexture.CreateFromImages(faces, scene);
    tex.coordinatesMode = 3; // CubeTexture.CUBIC_MODE
    return tex;
}

function easeOut(value: number): number {
    return 1 - (1 - value) * (1 - value);
}

function fallbackPoint(room: RelicRoom): Readonly<{ x: number; y: number }> {
    return {
        x: 50 + room.x * 7.4,
        y: 50 + room.z * 5.9,
    };
}

function fallbackPlayerOffset(index: number): Readonly<{ x: number; y: number }> {
    const angle = (Math.PI * 2 * index) / 4;
    return {
        x: Math.cos(angle) * 1.7,
        y: Math.sin(angle) * 1.7,
    };
}

function toPlayerOffset(index: number): Readonly<{ x: number; z: number }> {
    const angle = (Math.PI * 2 * index) / 4;
    return {
        x: Math.cos(angle) * 0.58,
        z: Math.sin(angle) * 0.58,
    };
}

function TouchDPad({ active }: Readonly<{ active: boolean }>) {
    if (!active) return null;

    function fireKey(key: string, down: boolean) {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key, bubbles: true }));
    }

    const dirs = [
        { key: 'w', label: '↑', col: 2, row: 1 },
        { key: 'a', label: '←', col: 1, row: 2 },
        { key: 's', label: '↓', col: 2, row: 3 },
        { key: 'd', label: '→', col: 3, row: 2 },
    ] as const;

    return (
        <div className="touch-dpad" aria-label="Movement controls">
            {dirs.map(({ key, label, col, row }) => (
                <button
                    key={key}
                    type="button"
                    className="dpad-btn"
                    style={{ gridColumn: col, gridRow: row }}
                    onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        fireKey(key, true);
                    }}
                    onPointerUp={() => fireKey(key, false)}
                    onPointerCancel={() => fireKey(key, false)}
                    onPointerLeave={() => fireKey(key, false)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}
