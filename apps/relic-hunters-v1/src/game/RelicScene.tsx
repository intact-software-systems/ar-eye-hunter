import { useEffect, useRef, useState } from 'react';
import '@babylonjs/core/Culling/ray.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
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
import {
    FLOOR_Y,
    PLAYER_EYE_Y,
    ROOM_SIZE,
} from './scene/constants.ts';
import { applyPointerLook, isRoamKey, yawToForward } from './scene/controls.ts';
import { resolveRoomRoam, roomCollisionBoxes } from './scene/collision.ts';
import {
    chooseLookRoom,
    computeScenePrompt,
    roomClueHotspot,
    samePrompt,
} from './scene/prompts.ts';
import {
    applyRoomMaterial,
    createCastleCorridor,
    createCastleMaterials,
    createIntroCastleScene,
    createRoomLights,
    createRoomProps,
    roomWorldPosition,
    type CastleMaterials,
} from './scene/rooms.ts';
import type {
    CollisionBox,
    InspectionFocus,
    PointerLookState,
    ScenePrompt,
} from './scene/types.ts';

type RelicSceneProps = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    onSelectRoom(roomId: string): void;
    onPrimeAction?(action: RelicActionInput): void;
}>;

type SceneRuntime = Readonly<{
    engine: Engine;
    scene: Scene;
    camera: UniversalCamera;
    castleMaterials: CastleMaterials;
    introMeshes: readonly Mesh[];
    snapshot: { value?: RelicPublicSnapshot };
    localPlayerId: { value?: string };
    selectedRoomId: { value?: string };
    pressedKeys: Set<string>;
    cameraYaw: { value: number };
    cameraPitch: { value: number };
    pointerLook: PointerLookState;
    roamOffset: Vector3;
    roamRoomId: { value?: string };
    rooms: Map<string, Mesh>;
    roomMaterials: Map<string, StandardMaterial>;
    roomBlockers: Map<string, readonly CollisionBox[]>;
    roomLights: Map<string, readonly PointLight[]>;
    players: Map<string, Mesh>;
    playerMaterials: Map<string, StandardMaterial>;
    playerCharacterIds: Map<string, string>;
    playerTargets: Map<string, Vector3>;
    avatarParts: Map<string, readonly Mesh[]>;
    avatarMaterials: Map<string, readonly StandardMaterial[]>;
    relics: Map<string, Mesh>;
    props: Map<string, readonly Mesh[]>;
    hands: readonly Mesh[];
    handMaterial: StandardMaterial;
    links: Mesh[];
    flickerLights: PointLight[];
    effects: TimedEffect[];
    seenEventIds: Set<string>;
    eventPlaybackPrimed: { value: boolean };
    prompt: { value?: ScenePrompt };
    onPromptChange: { value(prompt?: ScenePrompt): void };
    inspection: { value?: InspectionFocus };
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
    const onSelectRoomRef = useRef(onSelectRoom);
    const onPrimeActionRef = useRef(onPrimeAction);

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
        onSelectRoomRef.current = onSelectRoom;
    }, [onSelectRoom]);

    useEffect(() => {
        onPrimeActionRef.current = onPrimeAction;
    }, [onPrimeAction]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        let engine: Engine;
        try {
            engine = new Engine(canvas, true, {
                antialias: true,
                preserveDrawingBuffer: true,
                stencil: true,
            });
            setSceneError(undefined);
        } catch (error) {
            setSceneError(error instanceof Error ? error.message : String(error));
            runtimeRef.current = undefined;
            return;
        }
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.08, 0.1, 0.09, 1);
        scene.ambientColor = new Color3(0.54, 0.46, 0.34);
        scene.fogMode = Scene.FOGMODE_EXP2;
        scene.fogColor = new Color3(0.18, 0.2, 0.17);
        scene.fogDensity = 0.012;
        const camera = new UniversalCamera(
            'relic-camera',
            new Vector3(0, PLAYER_EYE_Y, -9),
            scene,
        );
        camera.setTarget(new Vector3(0, PLAYER_EYE_Y, 0));
        camera.fov = 1.02;
        camera.minZ = 0.05;
        camera.maxZ = 80;

        const light = new HemisphericLight('ruin-light', new Vector3(0.2, 1, 0.25), scene);
        light.intensity = 1.05;
        light.groundColor = new Color3(0.32, 0.24, 0.12);

        const handMaterial = new StandardMaterial('first-person-hands-material', scene);
        const castleMaterials = createCastleMaterials(scene);
        const introMeshes = createIntroCastleScene(scene, castleMaterials);
        const runtime: SceneRuntime = {
            engine,
            scene,
            camera,
            castleMaterials,
            introMeshes,
            snapshot: { value: snapshotRef.current },
            localPlayerId: { value: localPlayerIdRef.current },
            selectedRoomId: { value: selectedRoomIdRef.current },
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
            relics: new Map(),
            props: new Map(),
            hands: createFirstPersonHands(scene, handMaterial),
            handMaterial,
            links: [],
            flickerLights: [],
            effects: [],
            seenEventIds: new Set(),
            eventPlaybackPrimed: { value: false },
            prompt: { value: undefined },
            onPromptChange: { value: setScenePrompt },
            inspection: { value: undefined },
        };
        runtimeRef.current = runtime;
        syncScene(
            runtime,
            snapshotRef.current,
            localPlayerIdRef.current,
            selectedRoomIdRef.current,
        );

        scene.onPointerObservable.add((event) => {
            if (event.event.type !== 'pointerdown') {
                return;
            }

            const metadata = event.pickInfo?.pickedMesh?.metadata as
                | Readonly<{ roomId?: unknown; primeAction?: unknown }>
                | undefined;
            if (metadata?.primeAction === 'search') {
                const started = startInspection(runtime);
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

        const resize = () => engine.resize();
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
            if (event.key === 'Escape' && runtime.inspection.value) {
                runtime.inspection.value = undefined;
                setRuntimePrompt(runtime, undefined);
                event.preventDefault();
                return;
            }
            if (isRoamKey(event.key)) {
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
        engine.runRenderLoop(() => {
            updateRuntime(runtime);
            scene.render();
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
            scene.dispose();
            engine.dispose();
            runtimeRef.current = undefined;
        };
    }, []);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }

        syncScene(runtime, snapshot, localPlayerId, selectedRoomId);
    }, [localPlayerId, selectedRoomId, snapshot]);

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
            <SceneInteractionPrompt
                prompt={scenePrompt}
                onPrimeAction={(action) => {
                    onPrimeActionRef.current?.(action);
                    if (action.kind === 'move' && action.targetRoomId) {
                        onSelectRoomRef.current(action.targetRoomId);
                    }
                }}
            />
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
        }

        let material = runtime.roomMaterials.get(room.id);
        if (!material) {
            material = new StandardMaterial(`room-material-${room.id}`, runtime.scene);
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
        }

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
        const scale = player.playerId === localPlayerId ? 1.14 : 1;
        mesh.scaling.set(scale, scale, scale);
        setAvatarEnabled(
            runtime,
            player.playerId,
            player.playerId !== localPlayerId && !player.escaped && !player.defeated,
        );
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
    materials: readonly StandardMaterial[];
}> {
    const character = findRelicCharacter(player.characterId);
    const primary = materialFromHex(
        runtime.scene,
        `avatar-primary-${player.playerId}`,
        character.colors.primary,
        0.05,
    );
    const secondary = materialFromHex(
        runtime.scene,
        `avatar-secondary-${player.playerId}`,
        character.colors.secondary,
        0.035,
    );
    const accent = materialFromHex(
        runtime.scene,
        `avatar-accent-${player.playerId}`,
        character.colors.accent,
        0.12,
    );

    const root = MeshBuilder.CreateCylinder(
        `avatar-body-${player.playerId}`,
        {
            height: 0.86,
            diameterTop: character.silhouette === 'bulwark' ? 0.52 : 0.42,
            diameterBottom: character.silhouette === 'scout' ? 0.34 : 0.48,
            tessellation: 8,
        },
        runtime.scene,
    );
    root.material = primary;
    root.metadata = { playerId: player.playerId };

    const parts: Mesh[] = [root];
    const addPart = (mesh: Mesh, material: StandardMaterial) => {
        mesh.parent = root;
        mesh.material = material;
        mesh.metadata = { playerId: player.playerId };
        parts.push(mesh);
        return mesh;
    };

    const head = addPart(
        MeshBuilder.CreateSphere(
            `avatar-head-${player.playerId}`,
            { diameter: 0.28, segments: 14 },
            runtime.scene,
        ),
        accent,
    );
    head.position.set(0, 0.55, 0);

    const shoulders = addPart(
        MeshBuilder.CreateBox(
            `avatar-shoulders-${player.playerId}`,
            {
                width: character.silhouette === 'bulwark' ? 0.82 : 0.62,
                height: 0.16,
                depth: 0.22,
            },
            runtime.scene,
        ),
        secondary,
    );
    shoulders.position.set(0, 0.22, 0);

    const signature = addSignatureProp(runtime, root, character, player.playerId, accent);
    parts.push(...signature);

    return {
        root,
        parts,
        materials: [primary, secondary, accent],
    };
}

function addSignatureProp(
    runtime: SceneRuntime,
    root: Mesh,
    character: RelicCharacter,
    playerId: string,
    material: StandardMaterial,
): readonly Mesh[] {
    const parts: Mesh[] = [];
    const add = (mesh: Mesh) => {
        mesh.parent = root;
        mesh.material = material;
        mesh.metadata = { playerId };
        parts.push(mesh);
        return mesh;
    };

    switch (character.silhouette) {
        case 'vanguard':
        case 'bulwark': {
            const shield = add(MeshBuilder.CreateCylinder(
                `avatar-shield-${playerId}`,
                { height: 0.08, diameter: 0.46, tessellation: 6 },
                runtime.scene,
            ));
            shield.position.set(-0.36, 0.05, 0.08);
            shield.rotation.z = Math.PI / 2;
            break;
        }
        case 'scout':
        case 'stormrunner': {
            const lantern = add(MeshBuilder.CreateSphere(
                `avatar-lantern-${playerId}`,
                { diameter: 0.18, segments: 10 },
                runtime.scene,
            ));
            lantern.position.set(0.32, -0.08, 0.22);
            break;
        }
        case 'scholar':
        case 'seer': {
            const halo = add(MeshBuilder.CreateTorus(
                `avatar-halo-${playerId}`,
                { diameter: 0.48, thickness: 0.025, tessellation: 24 },
                runtime.scene,
            ));
            halo.position.set(0, 0.68, 0);
            halo.rotation.x = Math.PI / 2;
            break;
        }
        case 'trapbreaker': {
            const tool = add(MeshBuilder.CreateBox(
                `avatar-tool-${playerId}`,
                { width: 0.12, height: 0.56, depth: 0.08 },
                runtime.scene,
            ));
            tool.position.set(0.36, -0.04, 0);
            tool.rotation.z = 0.32;
            break;
        }
        case 'duelist':
        case 'hexblade': {
            const blade = add(MeshBuilder.CreateBox(
                `avatar-blade-${playerId}`,
                { width: 0.08, height: 0.78, depth: 0.08 },
                runtime.scene,
            ));
            blade.position.set(0.38, 0.02, 0.02);
            blade.rotation.z = -0.44;
            break;
        }
        case 'trickster': {
            for (const side of [-1, 1]) {
                const knife = add(MeshBuilder.CreateBox(
                    `avatar-knife-${playerId}-${side}`,
                    { width: 0.06, height: 0.42, depth: 0.06 },
                    runtime.scene,
                ));
                knife.position.set(side * 0.32, 0, 0.08);
                knife.rotation.z = side * 0.55;
            }
            break;
        }
    }

    return parts;
}

function setAvatarEnabled(runtime: SceneRuntime, playerId: string, enabled: boolean): void {
    for (const part of runtime.avatarParts.get(playerId) ?? []) {
        part.setEnabled(enabled);
    }
}

function disposeAvatar(runtime: SceneRuntime, playerId: string): void {
    for (const part of runtime.avatarParts.get(playerId) ?? []) {
        part.dispose();
    }
    for (const material of runtime.avatarMaterials.get(playerId) ?? []) {
        material.dispose();
    }
    runtime.players.delete(playerId);
    runtime.playerMaterials.delete(playerId);
    runtime.playerTargets.delete(playerId);
    runtime.playerCharacterIds.delete(playerId);
    runtime.avatarParts.delete(playerId);
    runtime.avatarMaterials.delete(playerId);
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
                { size: 0.35 },
                runtime.scene,
            );
            const material = new StandardMaterial(`relic-material-${relic.id}`, runtime.scene);
            material.diffuseColor = new Color3(0.95, 0.66, 0.22);
            material.emissiveColor = new Color3(0.14, 0.08, 0.01);
            mesh.material = material;
            runtime.relics.set(relic.id, mesh);
        }
        const room = snapshot.map.find((candidate) => candidate.id === relic.roomId);
        if (room) {
            const world = roomWorldPosition(room);
            mesh.position.set(world.x, 0.72, world.z);
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
    material: StandardMaterial,
): readonly Mesh[] {
    material.diffuseColor = Color3.FromHexString('#0f766e');
    material.emissiveColor = Color3.FromHexString('#f2c14e').scale(0.08);
    material.specularColor = new Color3(0.18, 0.14, 0.08);

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
    updateFirstPersonHands(runtime);
    updateLightFlicker(runtime);
    updateEffects(runtime);
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
}

function updatePlayerPositions(runtime: SceneRuntime): void {
    const factor = Math.min(1, runtime.engine.getDeltaTime() / 180);
    for (const [playerId, mesh] of runtime.players.entries()) {
        const target = runtime.playerTargets.get(playerId);
        if (!target) {
            continue;
        }

        const delta = target.subtract(mesh.position);
        if (delta.lengthSquared() < 0.0008) {
            mesh.position.copyFrom(target);
            continue;
        }

        mesh.position.addInPlace(delta.scale(factor));
    }
}

function updateCameraPose(runtime: SceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer) {
        setRuntimePrompt(runtime, undefined);
        moveCameraToward(
            runtime,
            new Vector3(0, 1.72, -7.6),
            new Vector3(0, 1.65, 1.4),
            520,
        );
        return;
    }

    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) {
        return;
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

    const desiredPosition = new Vector3(
        playerPosition.x,
        PLAYER_EYE_Y,
        playerPosition.z,
    );
    const lookDistance = 3.25;
    const flatDistance = Math.cos(runtime.cameraPitch.value) * lookDistance;
    const desiredTarget = new Vector3(
        playerPosition.x + roamForward.x * flatDistance,
        PLAYER_EYE_Y + Math.sin(runtime.cameraPitch.value) * lookDistance,
        playerPosition.z + roamForward.z * flatDistance,
    );

    moveCameraToward(runtime, desiredPosition, desiredTarget, 90);
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
    updateScenePrompt(runtime, room, forward);
    return forward;
}

function hasPressed(runtime: SceneRuntime, key: string): boolean {
    return runtime.pressedKeys.has(key);
}

function updateScenePrompt(
    runtime: SceneRuntime,
    room: RelicRoom,
    forward: Vector3,
): void {
    setRuntimePrompt(runtime, computeScenePrompt({
        snapshot: runtime.snapshot.value,
        localPlayerId: runtime.localPlayerId.value,
        room,
        roamOffset: runtime.roamOffset,
        forward,
        inspection: runtime.inspection.value,
    }));
}

function startInspection(runtime: SceneRuntime): boolean {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer || localPlayer.escaped || localPlayer.defeated) {
        return false;
    }

    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) {
        return false;
    }

    runtime.inspection.value = {
        roomId: room.id,
        hotspot: roomClueHotspot(room),
    };
    updateScenePrompt(runtime, room, yawToForward(runtime.cameraYaw.value));
    return true;
}

function shouldExitInspection(runtime: SceneRuntime, room: RelicRoom): boolean {
    const inspection = runtime.inspection.value;
    if (!inspection) {
        return false;
    }

    if (inspection.roomId !== room.id) {
        return true;
    }

    const distance = new Vector3(
        inspection.hotspot.x - runtime.roamOffset.x,
        0,
        inspection.hotspot.z - runtime.roamOffset.z,
    ).length();

    return distance > 2.55;
}

function setRuntimePrompt(runtime: SceneRuntime, prompt: ScenePrompt | undefined): void {
    if (samePrompt(runtime.prompt.value, prompt)) {
        return;
    }

    runtime.prompt.value = prompt;
    runtime.onPromptChange.value(prompt);
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
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    const enabled = !!localPlayer && !localPlayer.escaped && !localPlayer.defeated;
    for (const hand of runtime.hands) {
        hand.setEnabled(enabled);
    }
    if (!localPlayer) {
        return;
    }

    const character = findRelicCharacter(localPlayer.characterId);
    runtime.handMaterial.diffuseColor = Color3.FromHexString(character.colors.secondary);
    runtime.handMaterial.emissiveColor = Color3.FromHexString(character.colors.accent).scale(0.08);

    const forward = runtime.camera.getForwardRay().direction.normalize();
    const right = Vector3.Cross(forward, Vector3.Up()).normalize();
    const base = runtime.camera.position.add(forward.scale(0.82)).add(new Vector3(0, -0.34, 0));
    for (const [index, hand] of runtime.hands.entries()) {
        const side = index === 0 ? -1 : 1;
        hand.position.copyFrom(base.add(right.scale(side * 0.27)));
        hand.rotation.copyFrom(runtime.camera.rotation);
        hand.rotation.z += side * 0.42;
    }
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
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    const color = Color3.FromHexString(hex);
    material.diffuseColor = color;
    material.emissiveColor = color.scale(emissiveScale);
    material.specularColor = color.scale(0.16);
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
