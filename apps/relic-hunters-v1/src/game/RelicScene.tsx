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
    RelicPublicSnapshot,
    RelicRoom,
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { SceneInteractionPrompt } from './scene/SceneInteractionPrompt.tsx';
import { SceneObjectivePanel } from './scene/SceneObjectivePanel.tsx';
import { DOOR_WIDTH, FLOOR_Y, PLAYER_EYE_Y, ROOM_SIZE, } from './scene/constants.ts';
import { applyPointerLook, isRoamKey, yawToForward } from './scene/controls.ts';
import { resolveRoomRoam, roomCollisionBoxes } from './scene/collision.ts';
import { setRuntimePrompt, shouldExitInspection, startInspection, updateScenePrompt, } from './scene/interaction.ts';
import {
    broadcastLocalPosition,
    POS_MAX_AGE_MS,
    type RemotePosEntry,
    subscribeRelicScenePositionUpdates,
} from './scene/networking.ts';
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
const SCENE_FRAME_INTERVAL_MS = 1000 / 30;
const PLAYER_LABEL_MODE: 'names' | 'details' | 'hidden' = 'names';

type HeldMovePrompt = Readonly<{
    roomId: string;
    prompt: Extract<ScenePrompt, { kind: 'move' }>;
    expiresAtMs: number;
}>;

type RelicSceneProps = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    primedAction?: RelicActionInput;
    focusRoomId?: string;
    rtcReady?: boolean;
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
    eventPlaybackPrimed: { value: boolean };
    focusRoomId: { value?: string };
    rtcReady: { value: boolean };
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
                               onSelectRoom,
                               onPrimeAction,
                           }: RelicSceneProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<SceneRuntime | undefined>(undefined);
    const [sceneError, setSceneError] = useState<string | undefined>();
    const [scenePrompt, setScenePrompt] = useState<ScenePrompt | undefined>();
    const snapshotRef = useRef(snapshot);
    const localPlayerIdRef = useRef(localPlayerId);
    const selectedRoomIdRef = useRef(selectedRoomId);
    const primedActionRef = useRef(primedAction);
    const rtcReadyRef = useRef(rtcReady);
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
                objectiveTargetRoomId: sceneObjective.targetRoomId,
                onPromptChange: setScenePrompt,
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
                onSelectRoomRef.current(roomId);
                runtime.inspection.value = undefined;
                return;
            }

            runtime.inspection.value = undefined;
        });

        const resize = () => runtime.engine.resize();
        const pointerdown = (event: PointerEvent) => {
            if (event.button !== 0 && event.pointerType === 'mouse') {
                return;
            }

            canvas.focus();
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
            <TouchDPad active={localPlayerActive}/>
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
                    if (!room || player.escaped || player.defeated) {
                        return null;
                    }

                    const point = fallbackPoint(room);
                    const character = findRelicCharacter(player.characterId);
                    const offset = fallbackPlayerOffset(index);
                    return (
                        <span
                            key={player.playerId}
                            className={player.playerId === localPlayerId
                                ? 'fallback-hunter local'
                                : 'fallback-hunter'}
                            style={{
                                left: `${point.x + offset.x}%`,
                                top: `${point.y + offset.y}%`,
                                background: character.colors.accent,
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
                                     objectiveTargetRoomId,
                                     onPromptChange,
                                 }: Readonly<{
    canvas: HTMLCanvasElement;
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    primedAction?: RelicActionInput;
    rtcReady: boolean;
    objectiveTargetRoomId?: string;
    onPromptChange(prompt?: ScenePrompt): void;
}>): SceneRuntime {
    const engine = new Engine(canvas, true, {
        antialias: true,
        preserveDrawingBuffer: false,
        stencil: true,
    });
    engine.setHardwareScalingLevel(1.25);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.05, 0.09, 1);
    scene.ambientColor = new Color3(0.44, 0.38, 0.52);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.07, 0.07, 0.13);
    scene.fogDensity = 0.013;

    const camera = new UniversalCamera(
        'relic-camera',
        new Vector3(0, PLAYER_EYE_Y, -9),
        scene,
    );
    camera.setTarget(new Vector3(0, PLAYER_EYE_Y, 0));
    camera.fov = 1.02;
    camera.minZ = 0.05;
    camera.maxZ = 80;
    renderSceneFrame(scene, canvas);

    const pipeline = createRelicPostProcess(scene, camera);
    const shadows = createRelicSceneLighting(scene);
    installShadowRegistration(scene, shadows);
    installSkybox(scene);

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
        shadows,
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
        eventPlaybackPrimed: { value: false },
        focusRoomId: { value: undefined },
        rtcReady: { value: rtcReady },
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
    pipeline.bloomThreshold = 0.52;
    pipeline.bloomWeight = 0.55;
    pipeline.bloomKernel = 48;
    pipeline.bloomScale = 0.5;

    pipeline.sharpenEnabled = true;
    pipeline.sharpen.edgeAmount = 0.38;

    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.contrast = 1.18;
    pipeline.imageProcessing.exposure = 1.06;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;

    const curves = new ColorCurves();
    curves.globalSaturation = 18;
    curves.highlightsHue = 35;
    curves.highlightsDensity = 22;
    curves.shadowsHue = 215;
    curves.shadowsDensity = 26;
    pipeline.imageProcessing.colorCurvesEnabled = true;
    pipeline.imageProcessing.colorCurves = curves;

    pipeline.imageProcessing.vignetteEnabled = true;
    pipeline.imageProcessing.vignetteWeight = 2.4;
    pipeline.imageProcessing.vignetteStretch = 0.55;
    pipeline.imageProcessing.vignetteCameraFov = camera.fov;
    pipeline.imageProcessing.vignetteColor = new Color4(0.04, 0.02, 0.07, 0);

    pipeline.grainEnabled = true;
    pipeline.grain.intensity = 6;
    pipeline.grain.animated = true;

    try {
        const ssao = new SSAO2RenderingPipeline('relic-ssao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [camera]);
        ssao.radius = 2.0;
        ssao.totalStrength = 0.9;
        ssao.base = 0.08;
        ssao.maxZ = 40;
        ssao.samples = 4;
    } catch {
        // SSAO2 is not available in every browser context.
    }

    const glowLayer = new GlowLayer('relic-glow', scene);
    glowLayer.intensity = 1.45;

    return pipeline;
}

function createRelicSceneLighting(scene: Scene): ShadowGenerator {
    const sunLight = new DirectionalLight('relic-sun', new Vector3(-0.55, -1.35, -0.45), scene);
    sunLight.position = new Vector3(25, 48, 25);
    sunLight.intensity = 2.0;
    sunLight.diffuse = new Color3(1.0, 0.93, 0.80);
    sunLight.specular = new Color3(1.0, 0.96, 0.88);

    const shadows = new ShadowGenerator(512, sunLight);
    shadows.useBlurExponentialShadowMap = true;
    shadows.blurKernel = 12;
    shadows.darkness = 0.42;

    const light = new HemisphericLight('ruin-light', new Vector3(0.15, 1, 0.2), scene);
    light.intensity = 0.68;
    light.diffuse = new Color3(0.76, 0.70, 0.96);
    light.groundColor = new Color3(0.22, 0.12, 0.06);

    return shadows;
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
    scene.environmentIntensity = 0.30;

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
    renderSceneFrame(runtime.scene, runtime.canvas);
}

function renderSceneFrame(scene: Scene, canvas: HTMLCanvasElement): void {
    scene.render();
    if (canvas.dataset.sceneReady !== 'true' && renderedFrameHasVisiblePixel(canvas)) {
        canvas.dataset.sceneReady = 'true';
    }
}

function renderedFrameHasVisiblePixel(canvas: HTMLCanvasElement): boolean {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) {
        return false;
    }

    try {
        const pixels = new Uint8Array(4);
        gl.readPixels(
            Math.floor(gl.drawingBufferWidth / 2),
            Math.floor(gl.drawingBufferHeight / 2),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
        );
        return pixels[3] > 0 && (pixels[0] > 4 || pixels[1] > 4 || pixels[2] > 4);
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
    syncPlayers(runtime, snapshot, localPlayerId);
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
    localPlayerId: string | undefined,
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
            mesh.scaling.setAll(1.0);
            setAvatarEnabled(runtime, player.playerId, true);
        } else if (player.playerId === localPlayerId) {
            // Local player: shown in 3rd person, position tracked from roamOffset each frame
            mesh.scaling.setAll(1.0);
            setAvatarEnabled(runtime, player.playerId, !player.escaped && !player.defeated);
        } else {
            const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
            if (room) {
                const world = roomWorldPosition(room);
                const offset = toPlayerOffset(index);
                const target = new Vector3(world.x + offset.x, 0.65, world.z + offset.z);
                if (!runtime.playerTargets.has(player.playerId)) {
                    mesh.position.copyFrom(target);
                }
                runtime.playerTargets.set(player.playerId, target);
            }
            mesh.scaling.setAll(1.0);
            setAvatarEnabled(runtime, player.playerId, !player.escaped && !player.defeated);
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
    const primary   = materialFromHex(runtime.scene, `av-pri-${pid}`, character.colors.primary,   0.04, 0.04, 0.80);
    const secondary = materialFromHex(runtime.scene, `av-sec-${pid}`, character.colors.secondary, 0.02, 0.58, 0.42);
    const accent    = materialFromHex(runtime.scene, `av-acc-${pid}`, character.colors.accent,    0.20, 0.90, 0.16);
    const blade     = materialFromHex(runtime.scene, `av-bld-${pid}`, '#a8b8bc',                  0.01, 0.84, 0.30);

    // === ROOT: Hakama (wide pleated lower robe) ===
    const root = MeshBuilder.CreateCylinder(`av-body-${pid}`, {
        height: 0.54,
        diameterTop:    isBulwark ? 0.44 : 0.38,
        diameterBottom: isBulwark ? 0.66 : 0.58,
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
        height: 0.07, diameterTop: isBulwark ? 0.48 : 0.42, diameterBottom: isBulwark ? 0.48 : 0.42, tessellation: 10,
    }, runtime.scene), accent).position.y = 0.12;

    // === LEGS ===
    for (const [side, xOff] of [[-1, -0.10], [1, 0.10]] as [number, number][]) {
        // Suneate (shin guard)
        addPart(MeshBuilder.CreateCylinder(`av-shin-${side}-${pid}`, {
            height: 0.30, diameterTop: 0.14, diameterBottom: 0.12, tessellation: 7,
        }, runtime.scene), secondary).position.set(xOff, -0.27, 0.01);

        // Tabi boot
        const boot = addPart(MeshBuilder.CreateBox(`av-boot-${side}-${pid}`, {
            width: 0.15, height: 0.10, depth: 0.22,
        }, runtime.scene), primary);
        boot.position.set(xOff, -0.45, 0.04);
    }

    // === TORSO ===
    // Koshi-obi (hip sash)
    addPart(MeshBuilder.CreateCylinder(`av-waist-${pid}`, {
        height: 0.11, diameterTop: isBulwark ? 0.50 : 0.44, diameterBottom: isBulwark ? 0.52 : 0.46, tessellation: 10,
    }, runtime.scene), accent).position.y = 0.34;

    // Dō (chest armour plate)
    const chest = addPart(MeshBuilder.CreateBox(`av-chest-${pid}`, {
        width: isBulwark ? 0.46 : 0.40, height: 0.40, depth: 0.27,
    }, runtime.scene), secondary);
    chest.position.y = 0.65;

    // Lamellar rows on chest (two horizontal accent strips)
    addPart(MeshBuilder.CreateBox(`av-chest-rim1-${pid}`, {
        width: isBulwark ? 0.48 : 0.42, height: 0.055, depth: 0.28,
    }, runtime.scene), accent).position.y = 0.70;
    addPart(MeshBuilder.CreateBox(`av-chest-rim2-${pid}`, {
        width: isBulwark ? 0.48 : 0.42, height: 0.05, depth: 0.28,
    }, runtime.scene), accent).position.y = 0.52;

    // Neck cylinder
    addPart(MeshBuilder.CreateCylinder(`av-neck-${pid}`, {
        height: 0.14, diameter: 0.17, tessellation: 8,
    }, runtime.scene), primary).position.y = 0.94;

    // === ARMS (left and right) ===
    for (const [side, sign] of [[-1, -1], [1, 1]] as [number, number][]) {
        // Ō-sode (large shoulder board)
        const sode = addPart(MeshBuilder.CreateBox(`av-sode-${side}-${pid}`, {
            width: 0.10, height: 0.34, depth: 0.27,
        }, runtime.scene), secondary);
        sode.position.set(sign * 0.31, 0.72, -0.02);
        sode.rotation.z = sign * 0.28;

        // Sode lamellar accent
        const sodeRim = addPart(MeshBuilder.CreateBox(`av-sode-rim-${side}-${pid}`, {
            width: 0.11, height: 0.055, depth: 0.27,
        }, runtime.scene), accent);
        sodeRim.position.set(sign * 0.31, 0.62, -0.02);
        sodeRim.rotation.z = sign * 0.28;

        // Upper arm
        const uArm = addPart(MeshBuilder.CreateCylinder(`av-uarm-${side}-${pid}`, {
            height: 0.24, diameterTop: 0.10, diameterBottom: 0.13, tessellation: 7,
        }, runtime.scene), primary);
        uArm.position.set(sign * 0.30, 0.55, 0.01);
        uArm.rotation.z = sign * 0.75;

        // Lower arm / kote (armoured gauntlet)
        const lArm = addPart(MeshBuilder.CreateCylinder(`av-larm-${side}-${pid}`, {
            height: 0.22, diameterTop: 0.09, diameterBottom: 0.11, tessellation: 7,
        }, runtime.scene), secondary);
        lArm.position.set(sign * 0.40, 0.40, 0.04);
        lArm.rotation.z = sign * 0.94;
        lArm.rotation.x = 0.12;
    }

    // === HEAD ===
    // Kabuto dome (flattened sphere)
    const kabuto = addPart(MeshBuilder.CreateSphere(`av-kabuto-${pid}`, {
        diameter: 0.37, segments: 12,
    }, runtime.scene), accent);
    kabuto.position.y = 1.14;
    kabuto.scaling.set(1.0, 0.72, 1.0);

    // Hachi brow ridge
    addPart(MeshBuilder.CreateBox(`av-hachi-${pid}`, {
        width: 0.38, height: 0.07, depth: 0.33,
    }, runtime.scene), secondary).position.y = 1.06;

    // Shikoro — inner neckguard disc
    const shikoro = addPart(MeshBuilder.CreateDisc(`av-shikoro-${pid}`, {
        radius: 0.26, tessellation: 20,
    }, runtime.scene), secondary);
    shikoro.position.y = 1.00;
    shikoro.rotation.x = Math.PI / 2;

    // Shikoro outer accent ring
    const shikoroRing = addPart(MeshBuilder.CreateDisc(`av-shikoro-ring-${pid}`, {
        radius: 0.30, tessellation: 20,
    }, runtime.scene), accent);
    shikoroRing.position.y = 0.97;
    shikoroRing.rotation.x = Math.PI / 2;

    // Fukigaeshi — ear flap plates (left and right)
    for (const [side, sign] of [[-1, -1], [1, 1]] as [number, number][]) {
        const fuki = addPart(MeshBuilder.CreateBox(`av-fuki-${side}-${pid}`, {
            width: 0.06, height: 0.16, depth: 0.14,
        }, runtime.scene), secondary);
        fuki.position.set(sign * 0.20, 1.10, -0.01);
        fuki.rotation.z = sign * 0.55;
    }

    // Menpo — lower face mask
    const menpo = addPart(MeshBuilder.CreateBox(`av-menpo-${pid}`, {
        width: 0.26, height: 0.19, depth: 0.17,
    }, runtime.scene), secondary);
    menpo.position.set(0, 1.00, 0.10);

    // Menpo nose bridge
    const noseBridge = addPart(MeshBuilder.CreateBox(`av-nose-${pid}`, {
        width: 0.055, height: 0.09, depth: 0.09,
    }, runtime.scene), accent);
    noseBridge.position.set(0, 1.06, 0.19);

    // Maedate (front crest — tall dramatic plate)
    const crest = addPart(MeshBuilder.CreateBox(`av-crest-${pid}`, {
        width: 0.06, height: 0.26, depth: 0.05,
    }, runtime.scene), accent);
    crest.position.set(0, 1.28, 0.14);
    crest.rotation.x = -0.22;

    // === KATANA at hip (daisho carry) ===
    const saya = addPart(MeshBuilder.CreateBox(`av-saya-${pid}`, {
        width: 0.05, height: 0.66, depth: 0.07,
    }, runtime.scene), primary);
    saya.position.set(-0.22, 0.30, 0.14);
    saya.rotation.z = 0.30;

    const tsuba = addPart(MeshBuilder.CreateCylinder(`av-tsuba-${pid}`, {
        height: 0.025, diameter: 0.11, tessellation: 10,
    }, runtime.scene), accent);
    tsuba.position.set(-0.10, 0.56, 0.14);
    tsuba.rotation.x = Math.PI / 2;

    const tsuka = addPart(MeshBuilder.CreateBox(`av-tsuka-${pid}`, {
        width: 0.045, height: 0.20, depth: 0.07,
    }, runtime.scene), primary);
    tsuka.position.set(-0.03, 0.64, 0.14);
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
                { height: 0.07, diameter: 0.52, tessellation: 7 },
                runtime.scene,
            ));
            shield.position.set(-0.38, 0.18, 0.10);
            shield.rotation.z = Math.PI / 2;
            // Shield boss (centre umbo)
            add(MeshBuilder.CreateSphere(`avatar-shield-boss-${playerId}`, { diameter: 0.12, segments: 8 }, runtime.scene))
                .position.set(-0.42, 0.18, 0.10);
            break;
        }
        case 'scout':
        case 'stormrunner': {
            // Paper lantern held at side
            const lantern = add(MeshBuilder.CreateSphere(
                `avatar-lantern-${playerId}`,
                { diameter: 0.20, segments: 10 },
                runtime.scene,
            ));
            lantern.position.set(0.36, 0.12, 0.22);
            lantern.scaling.set(1, 1.3, 1);
            // Lantern cord
            add(MeshBuilder.CreateCylinder(`avatar-lantern-cord-${playerId}`, { height: 0.14, diameter: 0.02, tessellation: 4 }, runtime.scene))
                .position.set(0.36, 0.26, 0.22);
            break;
        }
        case 'scholar':
        case 'seer': {
            // Magical halo ring above head
            const halo = add(MeshBuilder.CreateTorus(
                `avatar-halo-${playerId}`,
                { diameter: 0.52, thickness: 0.03, tessellation: 28 },
                runtime.scene,
            ));
            halo.position.set(0, 1.38, 0);
            halo.rotation.x = Math.PI / 2;
            // Inner halo ring (smaller, different accent)
            add(MeshBuilder.CreateTorus(`avatar-halo-inner-${playerId}`, { diameter: 0.34, thickness: 0.02, tessellation: 20 }, runtime.scene))
                .position.set(0, 1.42, 0);
            (parts[parts.length - 1]).rotation.x = Math.PI / 2;
            break;
        }
        case 'trapbreaker': {
            // Long polearm / tool carried at side
            const tool = add(MeshBuilder.CreateBox(
                `avatar-tool-${playerId}`,
                { width: 0.055, height: 0.68, depth: 0.07 },
                runtime.scene,
            ));
            tool.position.set(0.40, 0.08, 0);
            tool.rotation.z = 0.28;
            // Tool head
            add(MeshBuilder.CreateBox(`avatar-tool-head-${playerId}`, { width: 0.14, height: 0.11, depth: 0.10 }, runtime.scene), bladeMaterial)
                .position.set(0.52, 0.48, 0);
            break;
        }
        case 'duelist':
        case 'hexblade': {
            // Second drawn blade held in right hand (nito style)
            const drawn = add(MeshBuilder.CreateBox(
                `avatar-drawn-${playerId}`,
                { width: 0.04, height: 0.72, depth: 0.055 },
                runtime.scene,
            ), bladeMaterial);
            drawn.position.set(0.38, 0.22, 0.04);
            drawn.rotation.z = -0.38;
            // Tsuba on drawn blade
            add(MeshBuilder.CreateCylinder(`avatar-drawn-tsuba-${playerId}`, { height: 0.022, diameter: 0.10, tessellation: 8 }, runtime.scene))
                .position.set(0.26, 0.54, 0.04);
            (parts[parts.length - 1]).rotation.x = Math.PI / 2;
            break;
        }
        case 'trickster': {
            // Twin kunai knives
            for (const side of [-1, 1]) {
                const knife = add(MeshBuilder.CreateBox(
                    `avatar-knife-${playerId}-${side}`,
                    { width: 0.038, height: 0.36, depth: 0.045 },
                    runtime.scene,
                ), bladeMaterial);
                knife.position.set(side * 0.34, 0.14, 0.10);
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

function setAvatarEnabled(runtime: SceneRuntime, playerId: string, enabled: boolean): void {
    for (const part of runtime.avatarParts.get(playerId) ?? []) {
        part.setEnabled(enabled);
    }
    runtime.playerLabels.get(playerId)?.setEnabled(enabled && PLAYER_LABEL_MODE !== 'hidden');
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
            spawnCueEffect(runtime, event.animationCue);
        }
    }
}

function updateRuntime(runtime: SceneRuntime): void {
    updateSceneVisibility(runtime);
    updatePlayerPositions(runtime);
    updateCameraPose(runtime);
    updateInteractionHighlights(runtime);
    updateFirstPersonHands(runtime);
    updateLightFlicker(runtime);
    updateEffects(runtime);
    updateRelics(runtime);
    updateAvatarCompulsionState(runtime);
    updateDynamicPostProcess(runtime);
    broadcastLocalPosition(runtime);
}

function updateSceneVisibility(runtime: SceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    const showIntro = !snapshot || !localPlayer;

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
    for (const lights of runtime.roomLights.values()) {
        for (const light of lights) {
            light.setEnabled(!showIntro);
        }
    }
    for (const particles of runtime.roomParticles.values()) {
        for (const system of particles) {
            if (showIntro) {
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
    const factor = Math.min(1, dt / 180);
    const rtcFactor = Math.min(1, dt / 55);
    const now = performance.now();

    for (const [playerId, mesh] of runtime.players.entries()) {
        if (playerId === localPlayerId && localPlayer && !localPlayer.escaped && !localPlayer.defeated) {
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
            const remote = runtime.remotePositions.get(playerId);
            if (remote && now - remote.t < POS_MAX_AGE_MS) {
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
                if (delta.lengthSquared() < 0.0008) {
                    mesh.position.copyFrom(target);
                } else {
                    mesh.position.addInPlace(delta.scale(factor));
                }
            }
        }

        const label = runtime.playerLabels.get(playerId);
        if (label?.isEnabled()) {
            label.position.set(mesh.position.x, mesh.position.y + 1.4, mesh.position.z);
        }
    }
}

function updateCameraPose(runtime: SceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer) {
        setRuntimePrompt(runtime, undefined);
        // Cinematic slow orbit around the Japanese lobby
        const t = performance.now() / 1000;
        const camX = Math.sin(t * 0.18) * 5.2;
        const camZ = -9.4 + Math.sin(t * 0.11) * 1.8;
        const camY = 1.76 + Math.sin(t * 0.14) * 0.32;
        const lookX = Math.sin(t * 0.08) * 1.4;
        const lookZ = 5.2 + Math.sin(t * 0.13) * 2.2;
        const lookY = 2.6 + Math.sin(t * 0.09) * 0.38;
        moveCameraToward(runtime, new Vector3(camX, camY, camZ), new Vector3(lookX, lookY, lookZ), 1800);
        return;
    }

    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) {
        return;
    }

    // Spectator camera: pan to event focus room when no keys are held.
    const focusRoomId = runtime.focusRoomId.value;
    const isRoaming = runtime.pressedKeys.size > 0;
    if (focusRoomId && !isRoaming && !runtime.inspection.value) {
        const focusRoom = snapshot.map.find((candidate) => candidate.id === focusRoomId);
        if (focusRoom) {
            const fw = roomWorldPosition(focusRoom);
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
    if (inspection) {
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
        moveCameraToward(runtime, desiredPosition, clueWorld, 72);
        return;
    }

    // 3rd-person follow camera — stays behind and above the avatar
    const camDistance = 5.5 + Math.cos(runtime.cameraPitch.value) * 2.0;
    const camHeight = 3.8 + Math.sin(runtime.cameraPitch.value) * 2.5;
    const desiredPosition = new Vector3(
        playerPosition.x - roamForward.x * camDistance,
        playerPosition.y + camHeight,
        playerPosition.z - roamForward.z * camDistance,
    );
    const lookTarget = new Vector3(playerPosition.x, playerPosition.y + 1.1, playerPosition.z);
    moveCameraToward(runtime, desiredPosition, lookTarget, 90);
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
    runtime.cameraYaw.value += turnDirection * deltaSeconds * 1.85;

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
        const speed = (hasPressed(runtime, 'shift') ? 2.55 : 1.62) *
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

function moveCameraToward(
    runtime: SceneRuntime,
    desiredPosition: Vector3,
    desiredTarget: Vector3,
    dampingMs: number,
): void {
    const factor = Math.min(1, runtime.engine.getDeltaTime() / dampingMs);
    runtime.camera.position.addInPlace(desiredPosition.subtract(runtime.camera.position).scale(factor));
    const currentForward = runtime.camera.getForwardRay().direction;
    const currentTarget = runtime.camera.position.add(currentForward.scale(3));
    const nextTarget = currentTarget.add(desiredTarget.subtract(currentTarget).scale(factor));
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
    if (!snapshot || snapshot.phase !== 'planning') return;
    const now = performance.now();

    for (const [playerId, materials] of runtime.avatarMaterials.entries()) {
        const primary = materials[0];
        if (!primary) continue;

        if (snapshot.submittedPlayerIds.includes(playerId)) {
            // Bound by the Keeper — cool blue-purple settled glow
            const v = 0.10 + Math.sin(now / 2200) * 0.025;
            primary.emissiveColor = Color3.Lerp(
                primary.emissiveColor,
                new Color3(v * 0.4, v * 0.3, v * 2.0),
                0.06,
            );
        } else {
            // Compelled to act — gold pulse urging action
            const v = 0.30 + Math.sin(now / 480) * 0.18;
            primary.emissiveColor = Color3.Lerp(
                primary.emissiveColor,
                new Color3(v, v * 0.72, 0.02),
                0.08,
            );
        }
    }
}

function updateDynamicPostProcess(runtime: SceneRuntime): void {
    const room = currentLocalRoom(runtime);
    const now = performance.now();

    // Depth of field: on in lobby (cinematic), off in-game
    const inLobby = !runtime.snapshot.value || !runtime.localPlayerId.value ||
        !runtime.snapshot.value.players.find((p) => p.playerId === runtime.localPlayerId.value);
    if (inLobby) {
        runtime.pipeline.depthOfFieldEnabled = true;
        runtime.pipeline.depthOfField.focusDistance = 4800 + Math.sin(now / 9000) * 1200;
    } else {
        runtime.pipeline.depthOfFieldEnabled = false;
    }

    // Exposure, contrast, vignette: smoothly transition per room kind
    const [tExp, tContrast, tVignette] = !room ? [1.06, 1.18, 2.4]
        : room.kind === 'monster' ? [0.82, 1.48, 4.2]
            : room.kind === 'trap' ? [0.90, 1.34, 3.6]
                : room.kind === 'shrine' ? [1.12, 1.08, 2.0]
                    : room.kind === 'treasure' ? [1.20, 1.04, 1.8]
                        : room.kind === 'exit' ? [1.24, 1.02, 1.5]
                            : [1.06, 1.18, 2.4];

    const lerpSpeed = Math.min(1, runtime.engine.getDeltaTime() / 550);
    const ip = runtime.pipeline.imageProcessing;
    ip.exposure += (tExp - ip.exposure) * lerpSpeed;
    ip.contrast += (tContrast - ip.contrast) * lerpSpeed;
    ip.vignetteWeight += (tVignette - ip.vignetteWeight) * lerpSpeed;
}

function updateLightFlicker(runtime: SceneRuntime): void {
    const now = performance.now();
    for (const light of runtime.flickerLights) {
        const metadata = light.metadata as
            | Readonly<{ baseIntensity?: number; flickerSeed?: number }>
            | undefined;
        const base = metadata?.baseIntensity ?? light.intensity;
        const seed = metadata?.flickerSeed ?? 0;
        const flame = Math.sin(now / 92 + seed) * 0.08 + Math.sin(now / 37 + seed * 0.37) * 0.045;
        light.intensity = Math.max(0.08, base + flame);
    }
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
        x: Math.cos(angle) * 0.42,
        z: Math.sin(angle) * 0.42,
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
