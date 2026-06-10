import { useEffect, useRef } from 'react';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import {
    createRallarMotionBuffer,
    estimateRallarMotionVelocity,
    type RallarMotionBuffer,
} from '@shared/rallar-motion/mod.ts';

import {
    applyArenaEvent,
    createInitialArenaState,
    createInitialPlayerState,
    EMPTY_INPUT,
    hydrateArenaSnapshot,
    resolveShot,
    stepLocalPlayer,
    toArenaSnapshot,
    type ArenaSimulationState,
    type LocalPlayerState,
} from './simulation.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    EyeTargetState,
    PlayerCombatState,
    PlayerInputState,
    PlayerPose,
    PlayerShot,
    RemotePlayer,
    RemoteShot,
    ShotAccepted,
    ShotIntent,
    Vec3Tuple,
} from './types.ts';

type BabylonArenaProps = Readonly<{
    localUsername: string;
    localColor: string;
    roomId?: string;
    roomReady: boolean;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    remoteEvents: readonly ArenaEvent[];
    arenaSnapshot?: ArenaSnapshot;
    onLocalPose: (pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>) => void;
    onLocalShot: (
        shot: Omit<ShotIntent, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ) => void;
    onLocalCombatChange: (combat: PlayerCombatState) => void;
    onArenaSnapshot: (snapshot: ArenaSnapshot) => void;
}>;

type RemoteAvatar = Readonly<{
    root: TransformNode;
    label: Mesh;
    ring: Mesh;
    material: StandardMaterial;
    accentMaterial: StandardMaterial;
    labelTexture: DynamicTexture;
}>;

type TargetAvatar = Readonly<{
    root: TransformNode;
    iris: Mesh;
    pupil: Mesh;
    ring: Mesh;
    halo: Mesh;
    shardA: Mesh;
    shardB: Mesh;
    label: Mesh;
    labelTexture: DynamicTexture;
    coreMaterial: StandardMaterial;
    pupilMaterial: StandardMaterial;
    ringMaterial: StandardMaterial;
    labelMaterial: StandardMaterial;
}>;

type TransientEffect = {
    readonly startedAtMs: number;
    readonly durationMs: number;
    readonly meshes: readonly Mesh[];
    readonly materials: readonly StandardMaterial[];
    readonly textures?: readonly DynamicTexture[];
    readonly update?: (ageMs: number, progress: number) => void;
};

type ArenaRuntime = {
    engine: Engine;
    scene: Scene;
    camera: FreeCamera;
    glow: GlowLayer;
    avatars: Map<string, RemoteAvatar>;
    targets: Map<string, TargetAvatar>;
    motionBuffer: RallarMotionBuffer<PlayerPose>;
    motionSampleKeys: Map<string, string>;
    remoteShotIds: Set<string>;
    appliedEventIds: Set<string>;
    arenaState: ArenaSimulationState;
    localPlayer: LocalPlayerState;
    input: MutableInputState;
    lastFrameEpochMs: number;
    lastSnapshotRevision: number;
    recoil: number;
    hitStopUntilEpochMs: number;
    transientEffects: TransientEffect[];
};

type MutableInputState = {
    moveX: number;
    moveZ: number;
    sprint: boolean;
    dash: boolean;
    slide: boolean;
    jump: boolean;
    fire: boolean;
    altFire: boolean;
    overdrive: boolean;
    pause: boolean;
};

type LocalPoseHistory = Readonly<{
    observedAtEpochMs: number;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
}>;

const ARENA_SIZE = 42;
const BASE_FOV = 0.94;
const MAX_TRANSIENT_EFFECTS = 48;

const MATRIX_THEME = {
    void: '#020805',
    graphite: '#06110f',
    glass: '#071b18',
    acid: '#49ff86',
    cyan: '#00e5ff',
    magenta: '#ff3df2',
    amber: '#ffe66d',
    danger: '#ff4d7d',
    white: '#effff7',
} as const;

const MATRIX_TARGET_LABELS = [
    'Terms Accepted Eye',
    'Privacy Policy Witness',
    'Compliance Orb',
    'Unpaid Intern Swarm',
    'Mandatory Fun Sensor',
    'Cookie Consent Retina',
    'Productivity Gazer',
    'User Research Victim',
] as const;

const MATRIX_SIGNS = [
    ['MORALE PATCH 404', 'fun deprecated, proceed anyway'],
    ['TERMS ACCEPTED', 'you clicked by existing'],
    ['PRIVACY POLICY WITNESS', 'it has seen enough'],
    ['COMPLIANCE ORB STORAGE', 'please enjoy against policy'],
    ['EXIT INTERVIEW PORTAL', 'survival is not a benefit'],
] as const;

export function BabylonArena({
    localUsername,
    localColor,
    roomId,
    roomReady,
    remotePlayers,
    remoteShots,
    remoteEvents,
    arenaSnapshot,
    onLocalPose,
    onLocalShot,
    onLocalCombatChange,
    onArenaSnapshot,
}: BabylonArenaProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<ArenaRuntime | undefined>(undefined);
    const remotePlayersRef = useRef(remotePlayers);
    const remoteShotsRef = useRef(remoteShots);
    const remoteEventsRef = useRef(remoteEvents);
    const snapshotRef = useRef(arenaSnapshot);
    const callbacksRef = useRef({
        onLocalPose,
        onLocalShot,
        onLocalCombatChange,
        onArenaSnapshot,
    });
    const poseSeqRef = useRef(0);
    const shotSeqRef = useRef(0);
    const localPoseRef = useRef<LocalPoseHistory | undefined>(undefined);

    useEffect(() => {
        remotePlayersRef.current = remotePlayers;
    }, [remotePlayers]);

    useEffect(() => {
        remoteShotsRef.current = remoteShots;
    }, [remoteShots]);

    useEffect(() => {
        remoteEventsRef.current = remoteEvents;
    }, [remoteEvents]);

    useEffect(() => {
        snapshotRef.current = arenaSnapshot;
    }, [arenaSnapshot]);

    useEffect(() => {
        callbacksRef.current = {
            onLocalPose,
            onLocalShot,
            onLocalCombatChange,
            onArenaSnapshot,
        };
    }, [onArenaSnapshot, onLocalCombatChange, onLocalPose, onLocalShot]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const engine = new Engine(canvas, true, {
            antialias: true,
            preserveDrawingBuffer: true,
            stencil: true,
        });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.003, 0.018, 0.014, 1);
        scene.ambientColor = Color3.FromHexString(MATRIX_THEME.acid).scale(0.18);
        scene.collisionsEnabled = true;

        const camera = new FreeCamera('hunter-camera', new Vector3(0, 1.72, -11), scene);
        camera.minZ = 0.05;
        camera.maxZ = 120;
        camera.fov = BASE_FOV;

        const glow = new GlowLayer('arena-glow', scene);
        glow.intensity = 0.92;

        buildArena(scene);

        const now = Date.now();
        const runtime: ArenaRuntime = {
            engine,
            scene,
            camera,
            glow,
            avatars: new Map(),
            targets: new Map(),
            motionBuffer: createRallarMotionBuffer<PlayerPose>({
                interpolationDelayMs: 75,
                maxExtrapolationMs: 130,
            }),
            motionSampleKeys: new Map(),
            remoteShotIds: new Set(),
            appliedEventIds: new Set(),
            arenaState: snapshotRef.current
                ? hydrateArenaSnapshot(snapshotRef.current)
                : createInitialArenaState(undefined, now),
            localPlayer: createInitialPlayerState(now),
            input: { ...EMPTY_INPUT },
            lastFrameEpochMs: now,
            lastSnapshotRevision: 0,
            recoil: 0,
            hitStopUntilEpochMs: 0,
            transientEffects: [],
        };
        runtimeRef.current = runtime;
        syncTargetAvatars(runtime, now);

        const resize = () => engine.resize();
        window.addEventListener('resize', resize);

        const onKeyDown = (event: KeyboardEvent) => {
            setInputKey(runtime.input, event.code, true);
        };
        const onKeyUp = (event: KeyboardEvent) => {
            setInputKey(runtime.input, event.code, false);
        };
        const onPointerMove = (event: PointerEvent) => {
            if (document.pointerLockElement !== canvas) {
                return;
            }
            runtime.localPlayer = {
                ...runtime.localPlayer,
                yaw: runtime.localPlayer.yaw + event.movementX * 0.0024,
                pitch: clamp(
                    runtime.localPlayer.pitch + event.movementY * 0.002,
                    -1.22,
                    1.1,
                ),
            };
        };
        const onPointerDown = (event: PointerEvent) => {
            try {
                canvas.requestPointerLock?.();
            } catch {
                // Pointer lock can be blocked in headless smoke runs or embedded previews.
            }
            if (event.button === 0) {
                fireLocalShot({
                    runtime,
                    localUsername,
                    localColor,
                    roomId,
                    shotSeqRef,
                    callbacksRef,
                });
                return;
            }
            if (event.button === 2) {
                runtime.input.altFire = true;
                createScanPulse(runtime, runtime.localPlayer.position, localColor);
            }
        };
        const onPointerUp = (event: PointerEvent) => {
            if (event.button === 2) {
                runtime.input.altFire = false;
            }
        };
        const onContextMenu = (event: MouseEvent) => {
            event.preventDefault();
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('contextmenu', onContextMenu);

        scene.onBeforeRenderObservable.add(() => {
            runFrame({
                runtime,
                roomId,
                remotePlayers: remotePlayersRef.current,
                remoteShots: remoteShotsRef.current,
                remoteEvents: remoteEventsRef.current,
                arenaSnapshot: snapshotRef.current,
                poseSeqRef,
                localPoseRef,
                callbacksRef,
            });
        });

        engine.runRenderLoop(() => {
            scene.render();
            writeArenaDiagnostics(canvas, runtime);
        });

        return () => {
            window.removeEventListener('resize', resize);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('contextmenu', onContextMenu);
            scene.dispose();
            engine.dispose();
            delete canvas.dataset.arenaRuntimeReady;
            delete canvas.dataset.arenaVisualTheme;
            delete canvas.dataset.arenaMeshCount;
            delete canvas.dataset.arenaEffectCount;
            delete canvas.dataset.arenaActiveEffectCount;
            runtimeRef.current = undefined;
        };
    }, [localColor, localUsername, roomId]);

    return (
        <div className="arena-shell" data-room-ready={roomReady ? 'true' : 'false'}>
            <canvas
                ref={canvasRef}
                className="arena-canvas"
                aria-label="AR Eye Hunter gameplay canvas"
            />
            {!roomReady && (
                <div className="arena-blocker">
                    <div className="arena-blocker__panel">
                        Solo systems hot. Join or create a Rallar room for peer chaos.
                    </div>
                </div>
            )}
            <div className="crosshair" aria-hidden="true">
                <span/>
            </div>
        </div>
    );
}

function runFrame({
    runtime,
    roomId,
    remotePlayers,
    remoteShots,
    remoteEvents,
    arenaSnapshot,
    poseSeqRef,
    localPoseRef,
    callbacksRef,
}: Readonly<{
    runtime: ArenaRuntime;
    roomId?: string;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    remoteEvents: readonly ArenaEvent[];
    arenaSnapshot?: ArenaSnapshot;
    poseSeqRef: React.MutableRefObject<number>;
    localPoseRef: React.MutableRefObject<LocalPoseHistory | undefined>;
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>;
}>): void {
    const now = Date.now();
    const rawDtMs = now - runtime.lastFrameEpochMs;
    const dtMs = runtime.hitStopUntilEpochMs > now ? Math.min(rawDtMs, 8) : rawDtMs;
    runtime.lastFrameEpochMs = now;

    if (arenaSnapshot && arenaSnapshot.revision > runtime.arenaState.revision) {
        runtime.arenaState = hydrateArenaSnapshot(arenaSnapshot);
    }

    for (const event of remoteEvents) {
        if (runtime.appliedEventIds.has(event.id)) {
            continue;
        }
        runtime.appliedEventIds.add(event.id);
        runtime.arenaState = applyArenaEvent(runtime.arenaState, event);
        createArenaEventEffect(runtime, event);
    }

    runtime.localPlayer = stepLocalPlayer(
        runtime.localPlayer,
        freezeInput(runtime.input),
        dtMs,
        now,
    );
    runtime.arenaState = animateTargets(runtime.arenaState, dtMs, now);
    syncTargetAvatars(runtime, now);
    syncRemoteAvatars(runtime, remotePlayers);
    syncRemoteShots(runtime, remoteShots);
    syncCamera(runtime, now);
    updateTransientEffects(runtime);
    publishLocalPose(runtime.localPlayer, poseSeqRef, callbacksRef, localPoseRef);

    if (runtime.lastSnapshotRevision !== runtime.arenaState.revision) {
        runtime.lastSnapshotRevision = runtime.arenaState.revision;
        callbacksRef.current.onArenaSnapshot(
            toArenaSnapshot(runtime.arenaState, roomId, now),
        );
    }
}

function buildArena(scene: Scene): void {
    const floorMaterial = createMatrixMaterial(
        scene,
        'matrix-floor-mat',
        MATRIX_THEME.graphite,
        MATRIX_THEME.acid,
        0.11,
    );
    const gridTexture = createMatrixGridTexture(scene);
    floorMaterial.diffuseTexture = gridTexture;
    floorMaterial.emissiveTexture = gridTexture;
    floorMaterial.specularColor = Color3.FromHexString(MATRIX_THEME.cyan).scale(0.24);

    const floor = MeshBuilder.CreateGround('floor', {
        width: ARENA_SIZE,
        height: ARENA_SIZE,
        subdivisions: 16,
    }, scene);
    floor.material = floorMaterial;

    const wallMaterial = createMatrixMaterial(
        scene,
        'matrix-black-glass-wall',
        MATRIX_THEME.glass,
        MATRIX_THEME.cyan,
        0.16,
        0.92,
    );
    wallMaterial.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.26);

    const laneMaterial = createMatrixMaterial(
        scene,
        'matrix-data-lane-mat',
        MATRIX_THEME.acid,
        MATRIX_THEME.acid,
        1.0,
        0.88,
    );
    const warningMaterial = createMatrixMaterial(
        scene,
        'matrix-warning-lane-mat',
        MATRIX_THEME.magenta,
        MATRIX_THEME.magenta,
        0.86,
        0.86,
    );

    const walls = [
        { name: 'north-wall', position: [0, 2.6, ARENA_SIZE / 2], scaling: [ARENA_SIZE, 5.2, 0.7] },
        { name: 'south-wall', position: [0, 2.6, -ARENA_SIZE / 2], scaling: [ARENA_SIZE, 5.2, 0.7] },
        { name: 'east-wall', position: [ARENA_SIZE / 2, 2.6, 0], scaling: [0.7, 5.2, ARENA_SIZE] },
        { name: 'west-wall', position: [-ARENA_SIZE / 2, 2.6, 0], scaling: [0.7, 5.2, ARENA_SIZE] },
    ] as const;

    for (const spec of walls) {
        const wall = MeshBuilder.CreateBox(spec.name, { size: 1 }, scene);
        wall.position.set(spec.position[0], spec.position[1], spec.position[2]);
        wall.scaling.set(spec.scaling[0], spec.scaling[1], spec.scaling[2]);
        wall.material = wallMaterial;
    }

    for (const [index, x] of [-18, -12, -6, 0, 6, 12, 18].entries()) {
        const lane = MeshBuilder.CreateBox(`matrix-longitude-${index}`, {
            width: index % 3 === 0 ? 0.09 : 0.045,
            height: 0.035,
            depth: ARENA_SIZE * 0.88,
        }, scene);
        lane.position.set(x, 0.055, 0);
        lane.material = index % 3 === 0 ? warningMaterial : laneMaterial;
    }

    for (const [index, z] of [-18, -12, -6, 0, 6, 12, 18].entries()) {
        const lane = MeshBuilder.CreateBox(`matrix-latitude-${index}`, {
            width: ARENA_SIZE * 0.88,
            height: 0.035,
            depth: index % 3 === 0 ? 0.09 : 0.045,
        }, scene);
        lane.position.set(0, 0.06, z);
        lane.material = index % 3 === 0 ? warningMaterial : laneMaterial;
    }

    for (const [index, x] of [-13, -5, 6, 14].entries()) {
        for (const z of [-13, -3, 8]) {
            const pillar = MeshBuilder.CreateCylinder(`pulse-pillar-${index}-${z}`, {
                height: 4.8,
                diameterTop: 0.7,
                diameterBottom: 1.35,
                tessellation: 6,
            }, scene);
            pillar.position.set(x, 2.4, z);
            pillar.rotation.y = index * 0.4;
            pillar.material = wallMaterial;

            const ring = MeshBuilder.CreateTorus(`signal-ring-${index}-${z}`, {
                diameter: 2.0,
                thickness: 0.055,
                tessellation: 24,
            }, scene);
            ring.position.set(x, 4.25, z);
            ring.rotation.x = Math.PI / 2;
            ring.material = index % 2 === 0 ? laneMaterial : warningMaterial;
        }
    }

    createCodeRainPanel(scene, 'matrix-rain-north-a', [ -10.5, 2.85, ARENA_SIZE / 2 - 0.42 ], Math.PI, 9.2, 4.2, 1);
    createCodeRainPanel(scene, 'matrix-rain-north-b', [ 10.5, 2.85, ARENA_SIZE / 2 - 0.42 ], Math.PI, 9.2, 4.2, 2);
    createCodeRainPanel(scene, 'matrix-rain-south-a', [ -10.5, 2.85, -ARENA_SIZE / 2 + 0.42 ], 0, 9.2, 4.2, 3);
    createCodeRainPanel(scene, 'matrix-rain-south-b', [ 10.5, 2.85, -ARENA_SIZE / 2 + 0.42 ], 0, 9.2, 4.2, 4);
    createCodeRainPanel(scene, 'matrix-rain-east', [ ARENA_SIZE / 2 - 0.42, 2.85, 0 ], -Math.PI / 2, 12.5, 4.4, 5);
    createCodeRainPanel(scene, 'matrix-rain-west', [ -ARENA_SIZE / 2 + 0.42, 2.85, 0 ], Math.PI / 2, 12.5, 4.4, 6);

    for (const [index, sign] of MATRIX_SIGNS.entries()) {
        const side = index % 2 === 0 ? 1 : -1;
        const x = index < 3 ? -14 + index * 14 : side * (ARENA_SIZE / 2 - 1.1);
        const z = index < 3 ? side * (ARENA_SIZE / 2 - 1.05) : -9 + index * 4;
        const rotation = index < 3 ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        createHologramSign(
            scene,
            `matrix-sign-${index}`,
            sign[0],
            sign[1],
            [x, 3.35, z],
            rotation,
            index % 2 === 0 ? MATRIX_THEME.acid : MATRIX_THEME.cyan,
        );
    }

    createPortalRings(scene, 'matrix-portal-nw', [-17.6, 2.8, 16.8], MATRIX_THEME.cyan);
    createPortalRings(scene, 'matrix-portal-se', [17.4, 2.8, -16.4], MATRIX_THEME.magenta);
    createPortalRings(scene, 'matrix-portal-ne', [16.8, 2.2, 16.2], MATRIX_THEME.amber);

    const hemi = new HemisphericLight('arena-hemi', new Vector3(0.1, 1, -0.2), scene);
    hemi.intensity = 1.16;
    hemi.groundColor = Color3.FromHexString(MATRIX_THEME.acid).scale(0.18);

    const magenta = new PointLight('magenta-hotspot', new Vector3(-13, 5.6, -11), scene);
    magenta.diffuse = Color3.FromHexString(MATRIX_THEME.magenta);
    magenta.intensity = 0.82;
    magenta.range = 27;

    const cyan = new PointLight('cyan-hotspot', new Vector3(13, 4, 9), scene);
    cyan.diffuse = Color3.FromHexString(MATRIX_THEME.cyan);
    cyan.intensity = 0.94;
    cyan.range = 26;

    const acid = new PointLight('acid-hotspot', new Vector3(0, 7.2, 0), scene);
    acid.diffuse = Color3.FromHexString(MATRIX_THEME.acid);
    acid.intensity = 0.72;
    acid.range = 32;
}

function createMatrixMaterial(
    scene: Scene,
    name: string,
    diffuseHex: string,
    emissiveHex: string,
    emissiveScale: number,
    alpha = 1,
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.FromHexString(diffuseHex);
    material.emissiveColor = Color3.FromHexString(emissiveHex).scale(emissiveScale);
    material.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.14);
    material.alpha = alpha;
    material.backFaceCulling = alpha >= 1;
    return material;
}

function createMatrixGridTexture(scene: Scene): DynamicTexture {
    const texture = new DynamicTexture('matrix-floor-grid', { width: 1024, height: 1024 }, scene);
    const ctx = texture.getContext();
    ctx.fillStyle = MATRIX_THEME.void;
    ctx.fillRect(0, 0, 1024, 1024);

    ctx.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let column = 0; column < 1024; column += 42) {
        for (let row = 0; row < 1024; row += 34) {
            const char = (column * 17 + row * 7) % 9;
            ctx.globalAlpha = 0.08 + ((column + row) % 5) * 0.025;
            ctx.fillStyle = (column + row) % 4 === 0 ? MATRIX_THEME.cyan : MATRIX_THEME.acid;
            ctx.fillText(String(char), column + 8, row + 24);
        }
    }

    for (let i = 0; i <= 1024; i += 64) {
        ctx.strokeStyle = i % 256 === 0 ? MATRIX_THEME.cyan : MATRIX_THEME.acid;
        ctx.globalAlpha = i % 256 === 0 ? 0.82 : 0.34;
        ctx.lineWidth = i % 256 === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 1024);
        ctx.moveTo(0, i);
        ctx.lineTo(1024, i);
        ctx.stroke();
    }

    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = MATRIX_THEME.magenta;
    ctx.lineWidth = 2;
    for (let i = 128; i < 1024; i += 256) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(1024, 1024 - i);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    texture.update();
    return texture;
}

function createCodeRainPanel(
    scene: Scene,
    name: string,
    position: Vec3Tuple,
    rotationY: number,
    width: number,
    height: number,
    seed: number,
): void {
    const texture = new DynamicTexture(`${name}-texture`, { width: 512, height: 512 }, scene);
    texture.hasAlpha = true;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(0, 18, 13, 0.72)';
    ctx.fillRect(0, 0, 512, 512);
    ctx.font = '22px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let x = 12; x < 512; x += 28) {
        for (let y = -20; y < 532; y += 32) {
            const value = (x * 11 + y * 5 + seed * 31) % 16;
            ctx.globalAlpha = 0.18 + ((x + y + seed) % 7) * 0.075;
            ctx.fillStyle = value % 5 === 0 ? MATRIX_THEME.cyan : MATRIX_THEME.acid;
            ctx.fillText(value.toString(16).toUpperCase(), x, y + ((seed * 9 + x) % 32));
        }
    }
    ctx.globalAlpha = 0.58;
    ctx.strokeStyle = MATRIX_THEME.cyan;
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, 500, 500);
    ctx.globalAlpha = 1;
    texture.update();

    const material = new StandardMaterial(`${name}-mat`, scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.backFaceCulling = false;
    material.alpha = 0.78;

    const panel = MeshBuilder.CreatePlane(name, { width, height }, scene);
    panel.position = vector3(position);
    panel.rotation.y = rotationY;
    panel.material = material;

    scene.onBeforeRenderObservable.add(() => {
        panel.position.y = position[1] + Math.sin(performance.now() / 780 + seed) * 0.08;
    });
}

function createHologramSign(
    scene: Scene,
    name: string,
    title: string,
    detail: string,
    position: Vec3Tuple,
    rotationY: number,
    accent: string,
): void {
    const texture = new DynamicTexture(`${name}-texture`, { width: 768, height: 256 }, scene);
    texture.hasAlpha = true;
    drawMatrixPanel(texture, title, detail, accent);

    const material = new StandardMaterial(`${name}-mat`, scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.backFaceCulling = false;
    material.alpha = 0.9;

    const sign = MeshBuilder.CreatePlane(name, { width: 5.8, height: 1.45 }, scene);
    sign.position = vector3(position);
    sign.rotation.y = rotationY;
    sign.material = material;
}

function createPortalRings(scene: Scene, name: string, position: Vec3Tuple, accent: string): void {
    const root = new TransformNode(name, scene);
    root.position = vector3(position);

    const primary = createMatrixMaterial(scene, `${name}-primary`, accent, accent, 1, 0.84);
    const secondary = createMatrixMaterial(
        scene,
        `${name}-secondary`,
        MATRIX_THEME.acid,
        MATRIX_THEME.acid,
        0.84,
        0.64,
    );

    for (let i = 0; i < 3; i += 1) {
        const ring = MeshBuilder.CreateTorus(`${name}-ring-${i}`, {
            diameter: 2.6 + i * 0.66,
            thickness: 0.035 + i * 0.012,
            tessellation: 48,
        }, scene);
        ring.parent = root;
        ring.rotation.x = Math.PI / 2 + i * 0.4;
        ring.rotation.y = i * 0.7;
        ring.material = i === 1 ? secondary : primary;
    }

    scene.onBeforeRenderObservable.add(() => {
        root.rotation.y += 0.005;
        root.rotation.z = Math.sin(performance.now() / 900) * 0.08;
    });
}

function drawMatrixPanel(
    texture: DynamicTexture,
    title: string,
    detail: string,
    accent: string,
): void {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 768, 256);
    ctx.fillStyle = 'rgba(1, 8, 8, 0.86)';
    ctx.fillRect(0, 0, 768, 256);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 7;
    ctx.strokeRect(12, 12, 744, 232);
    ctx.fillStyle = accent;
    ctx.font = '700 42px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(title.slice(0, 24), 38, 94);
    ctx.fillStyle = MATRIX_THEME.white;
    ctx.font = '500 30px system-ui, sans-serif';
    ctx.fillText(detail.slice(0, 42), 40, 152);
    ctx.fillStyle = 'rgba(73, 255, 134, 0.42)';
    ctx.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('AUDIT TRAIL: definitely fine', 42, 210);
    texture.update();
}

function fireLocalShot({
    runtime,
    localUsername,
    localColor,
    roomId,
    shotSeqRef,
    callbacksRef,
}: Readonly<{
    runtime: ArenaRuntime;
    localUsername: string;
    localColor: string;
    roomId?: string;
    shotSeqRef: React.MutableRefObject<number>;
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>;
}>): void {
    const now = Date.now();
    const origin = runtime.localPlayer.position;
    const direction = forwardFromAngles(runtime.localPlayer.yaw, runtime.localPlayer.pitch);
    shotSeqRef.current += 1;
    const shot: ShotIntent = {
        sessionId: 'local',
        username: localUsername,
        color: localColor,
        origin,
        direction,
        charged: runtime.input.altFire,
        overdrive: runtime.input.overdrive,
        seq: shotSeqRef.current,
        sentAtEpochMs: now,
    };
    const resolution = resolveShot(
        runtime.arenaState,
        runtime.localPlayer.combat,
        shot,
        now,
    );
    runtime.arenaState = resolution.state;
    runtime.localPlayer = {
        ...runtime.localPlayer,
        combat: resolution.combat,
    };
    runtime.recoil = Math.min(1, runtime.recoil + (resolution.accepted.hit ? 0.38 : 0.22));
    runtime.hitStopUntilEpochMs = resolution.accepted.hit ? now + 38 : runtime.hitStopUntilEpochMs;

    createTracer(runtime, vector3(origin), vector3(direction), localColor, resolution.accepted.hit);
    if (resolution.accepted.hit) {
        createImpact(runtime, vector3(resolution.accepted.impact), MATRIX_THEME.amber, resolution.accepted.combo);
    }

    callbacksRef.current.onLocalCombatChange(resolution.combat);
    callbacksRef.current.onLocalShot(
        {
            origin,
            direction,
            charged: shot.charged,
            overdrive: shot.overdrive,
            seq: shot.seq,
            sentAtEpochMs: shot.sentAtEpochMs,
        },
        {
            ...resolution.accepted,
            shot: {
                ...resolution.accepted.shot,
                sessionId: 'local',
                username: localUsername,
                color: localColor,
            },
        },
    );
    callbacksRef.current.onArenaSnapshot(
        toArenaSnapshot(runtime.arenaState, roomId, now),
    );
}

function publishLocalPose(
    player: LocalPlayerState,
    poseSeqRef: React.MutableRefObject<number>,
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>,
    localPoseRef: React.MutableRefObject<LocalPoseHistory | undefined>,
): void {
    const now = Date.now();
    const position = player.position;
    const rotation: Vec3Tuple = [
        round3(player.pitch),
        round3(player.yaw),
        0,
    ];
    const current: LocalPoseHistory = {
        observedAtEpochMs: now,
        position,
        rotation,
    };
    const previous = localPoseRef.current;
    const velocity = previous
        ? estimateRallarMotionVelocity(previous, current)
        : player.velocity;
    const angularVelocity = previous
        ? estimateRallarMotionVelocity(
            {
                observedAtEpochMs: previous.observedAtEpochMs,
                position: previous.rotation,
            },
            {
                observedAtEpochMs: current.observedAtEpochMs,
                position: current.rotation,
            },
        )
        : undefined;

    localPoseRef.current = current;
    poseSeqRef.current += 1;
    callbacksRef.current.onLocalPose({
        position,
        rotation,
        velocity,
        angularVelocity,
        score: player.combat.score,
        combo: player.combat.combo,
        overdrive: player.combat.overdrive,
        seq: poseSeqRef.current,
        sentAtEpochMs: now,
    });
}

function syncCamera(runtime: ArenaRuntime, nowEpochMs: number): void {
    const player = runtime.localPlayer;
    const speed = Math.hypot(player.velocity[0], player.velocity[2]);
    const bob = player.grounded ? Math.sin(nowEpochMs / 82) * Math.min(0.045, speed * 0.004) : 0;
    const slideDrop = player.slideUntilEpochMs && player.slideUntilEpochMs > nowEpochMs ? -0.28 : 0;
    runtime.camera.position = vector3([
        player.position[0],
        player.position[1] + bob + slideDrop,
        player.position[2],
    ]);
    runtime.camera.rotation.x = player.pitch - runtime.recoil * 0.028;
    runtime.camera.rotation.y = player.yaw;
    runtime.camera.rotation.z = (
        (player.dashUntilEpochMs && player.dashUntilEpochMs > nowEpochMs ? 0.04 : 0) +
        (player.slideUntilEpochMs && player.slideUntilEpochMs > nowEpochMs ? -0.055 : 0)
    );
    runtime.camera.fov = BASE_FOV +
        Math.min(0.24, speed * 0.011) +
        runtime.recoil * 0.055;
    runtime.recoil *= 0.82;
}

function syncTargetAvatars(runtime: ArenaRuntime, nowEpochMs: number): void {
    const targetIds = new Set(runtime.arenaState.targets.map((target) => target.id));
    for (const target of runtime.arenaState.targets) {
        const avatar = getOrCreateTargetAvatar(runtime.scene, runtime.targets, target);
        avatar.root.position = vector3(target.position);
        avatar.root.position.y += Math.sin(nowEpochMs / 440 + target.phase) * 0.26;
        avatar.root.rotation.y += 0.014 + target.velocity[0] * 0.002;
        const healthScale = 0.55 + target.health / Math.max(1, target.maxHealth) * 0.45;
        avatar.iris.scaling.set(healthScale, healthScale, healthScale);
        avatar.ring.scaling.set(
            1.08 + Math.sin(nowEpochMs / 180 + target.phase) * 0.08,
            1.08 + Math.cos(nowEpochMs / 220 + target.phase) * 0.08,
            1.08,
        );
        avatar.halo.scaling.set(
            1.28 + Math.sin(nowEpochMs / 160 + target.phase) * 0.12,
            1.28 + Math.cos(nowEpochMs / 210 + target.phase) * 0.12,
            1.28,
        );
        avatar.halo.rotation.z -= 0.018;
        avatar.shardA.rotation.y += 0.035;
        avatar.shardB.rotation.x -= 0.028;
        avatar.coreMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.64);
        avatar.ringMaterial.emissiveColor = target.rarity === 'bounty'
            ? Color3.FromHexString(MATRIX_THEME.amber).scale(1.05)
            : Color3.FromHexString(target.color).scale(1.0);
        updateTargetLabel(avatar.labelTexture, target);
    }

    for (const [targetId, avatar] of runtime.targets) {
        if (targetIds.has(targetId)) {
            continue;
        }
        avatar.root.dispose();
        avatar.labelTexture.dispose();
        runtime.targets.delete(targetId);
    }
}

function animateTargets(
    state: ArenaSimulationState,
    dtMs: number,
    nowEpochMs: number,
): ArenaSimulationState {
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    const targets = state.targets.map((target) => {
        const next = addTuple(target.position, scaleTuple(target.velocity, dt));
        const bounceX = Math.abs(next[0]) > 19;
        const bounceY = next[1] < 1.3 || next[1] > 6.2;
        const bounceZ = Math.abs(next[2]) > 19;
        return {
            ...target,
            position: [
                clamp(next[0], -19, 19),
                clamp(next[1], 1.3, 6.2),
                clamp(next[2], -19, 19),
            ] as Vec3Tuple,
            velocity: [
                bounceX ? -target.velocity[0] : target.velocity[0],
                bounceY ? -target.velocity[1] : target.velocity[1],
                bounceZ ? -target.velocity[2] : target.velocity[2],
            ] as Vec3Tuple,
            rarity: target.bountyUntilEpochMs && target.bountyUntilEpochMs < nowEpochMs
                ? 'volatile'
                : target.rarity,
        };
    });
    return { ...state, targets };
}

function getOrCreateTargetAvatar(
    scene: Scene,
    targets: Map<string, TargetAvatar>,
    target: EyeTargetState,
): TargetAvatar {
    const existing = targets.get(target.id);
    if (existing) {
        return existing;
    }

    const root = new TransformNode(`target-root-${target.id}`, scene);
    root.position = vector3(target.position);

    const coreMaterial = new StandardMaterial(`target-core-${target.id}`, scene);
    coreMaterial.diffuseColor = Color3.FromHexString(target.color);
    coreMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.64);
    coreMaterial.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.35);

    const pupilMaterial = new StandardMaterial(`target-pupil-${target.id}`, scene);
    pupilMaterial.diffuseColor = Color3.FromHexString(MATRIX_THEME.void);
    pupilMaterial.emissiveColor = Color3.FromHexString(MATRIX_THEME.cyan).scale(0.26);

    const ringMaterial = new StandardMaterial(`target-ring-${target.id}`, scene);
    ringMaterial.diffuseColor = Color3.FromHexString(target.color);
    ringMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.9);
    ringMaterial.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.4);

    const shardMaterial = createMatrixMaterial(
        scene,
        `target-code-shard-${target.id}`,
        MATRIX_THEME.cyan,
        MATRIX_THEME.cyan,
        0.72,
        0.78,
    );

    const iris = MeshBuilder.CreateSphere(`eye-target-${target.id}`, {
        diameterX: target.radius * 2.4,
        diameterY: target.radius * 1.45,
        diameterZ: target.radius * 0.62,
        segments: 28,
    }, scene);
    iris.parent = root;
    iris.material = coreMaterial;

    const pupil = MeshBuilder.CreateSphere(`eye-pupil-${target.id}`, {
        diameterX: target.radius * 0.74,
        diameterY: target.radius * 0.74,
        diameterZ: target.radius * 0.18,
        segments: 18,
    }, scene);
    pupil.parent = root;
    pupil.position.z = -target.radius * 0.34;
    pupil.material = pupilMaterial;

    const ring = MeshBuilder.CreateTorus(`eye-ring-${target.id}`, {
        diameter: target.radius * 2.75,
        thickness: 0.035,
        tessellation: 32,
    }, scene);
    ring.parent = root;
    ring.rotation.x = Math.PI / 2;
    ring.material = ringMaterial;

    const halo = MeshBuilder.CreateTorus(`eye-holo-halo-${target.id}`, {
        diameter: target.radius * 3.65,
        thickness: 0.018,
        tessellation: 42,
    }, scene);
    halo.parent = root;
    halo.rotation.x = Math.PI / 2;
    halo.material = ringMaterial;

    const shardA = MeshBuilder.CreateBox(`eye-shard-a-${target.id}`, {
        width: 0.08,
        height: target.radius * 1.8,
        depth: 0.04,
    }, scene);
    shardA.parent = root;
    shardA.position.set(target.radius * 1.8, 0.18, -target.radius * 0.08);
    shardA.rotation.z = 0.45;
    shardA.material = shardMaterial;

    const shardB = MeshBuilder.CreateBox(`eye-shard-b-${target.id}`, {
        width: 0.06,
        height: target.radius * 1.45,
        depth: 0.04,
    }, scene);
    shardB.parent = root;
    shardB.position.set(-target.radius * 1.6, -0.12, -target.radius * 0.06);
    shardB.rotation.z = -0.5;
    shardB.material = shardMaterial;

    const labelTexture = new DynamicTexture(`target-label-texture-${target.id}`, {
        width: 768,
        height: 192,
    }, scene);
    labelTexture.hasAlpha = true;
    updateTargetLabel(labelTexture, target);

    const labelMaterial = new StandardMaterial(`target-label-mat-${target.id}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`target-label-${target.id}`, {
        width: 3.2,
        height: 0.8,
    }, scene);
    label.parent = root;
    label.position.y = target.radius * 1.75;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    const avatar = {
        root,
        iris,
        pupil,
        ring,
        halo,
        shardA,
        shardB,
        label,
        labelTexture,
        coreMaterial,
        pupilMaterial,
        ringMaterial,
        labelMaterial,
    };
    targets.set(target.id, avatar);
    return avatar;
}

function syncRemoteAvatars(
    runtime: ArenaRuntime,
    remotePlayers: ReadonlyMap<string, RemotePlayer>,
): void {
    syncRemoteMotionSamples(runtime, remotePlayers);
    const estimates = runtime.motionBuffer.sampleAll(Date.now());

    for (const [sessionId, remote] of remotePlayers) {
        const estimate = estimates.get(sessionId);
        const pose = estimate?.metadata ?? remote.pose;
        const avatar = getOrCreateAvatar(runtime.scene, runtime.avatars, sessionId, pose);
        const position = estimate?.position ?? remote.pose.position;
        const rotation = estimate?.rotation ?? remote.pose.rotation;

        avatar.root.position = vector3(position);
        avatar.root.rotation.y = rotation[1];
        avatar.material.diffuseColor = Color3.FromHexString(pose.color);
        avatar.material.emissiveColor = Color3.FromHexString(pose.color).scale(0.28);
        avatar.accentMaterial.emissiveColor = Color3.FromHexString(pose.color).scale(0.78);
        avatar.ring.rotation.y += 0.025;
        updateLabel(avatar.labelTexture, pose.username, pose.score, pose.combo ?? 0, pose.color);
    }

    for (const [sessionId, avatar] of runtime.avatars) {
        if (remotePlayers.has(sessionId)) {
            continue;
        }
        avatar.root.dispose();
        avatar.labelTexture.dispose();
        runtime.motionBuffer.remove(sessionId);
        runtime.motionSampleKeys.delete(sessionId);
        runtime.avatars.delete(sessionId);
    }
}

function syncRemoteMotionSamples(
    runtime: ArenaRuntime,
    remotePlayers: ReadonlyMap<string, RemotePlayer>,
): void {
    for (const [sessionId, remote] of remotePlayers) {
        const sampleKey = `${remote.pose.seq}:${remote.lastSeenEpochMs}`;
        if (runtime.motionSampleKeys.get(sessionId) === sampleKey) {
            continue;
        }

        runtime.motionBuffer.push({
            entityId: sessionId,
            observedAtEpochMs: remote.lastSeenEpochMs,
            position: remote.pose.position,
            rotation: remote.pose.rotation,
            velocity: remote.pose.velocity,
            angularVelocity: remote.pose.angularVelocity,
            seq: remote.pose.seq,
            metadata: remote.pose,
        });
        runtime.motionSampleKeys.set(sessionId, sampleKey);
    }

    runtime.motionBuffer.prune(Date.now());
}

function syncRemoteShots(runtime: ArenaRuntime, remoteShots: readonly RemoteShot[]): void {
    for (const remoteShot of remoteShots) {
        if (runtime.remoteShotIds.has(remoteShot.id)) {
            continue;
        }

        runtime.remoteShotIds.add(remoteShot.id);
        const shot = remoteShot.accepted?.shot ?? remoteShot.shot;
        createTracer(
            runtime,
            vector3(shot.origin),
            vector3(shot.direction),
            shot.color,
            !!remoteShot.accepted?.hit,
        );
        if (remoteShot.accepted?.hit) {
            createImpact(
                runtime,
                vector3(remoteShot.accepted.impact),
                MATRIX_THEME.magenta,
                remoteShot.accepted.combo,
            );
        }
    }
}

function getOrCreateAvatar(
    scene: Scene,
    avatars: Map<string, RemoteAvatar>,
    sessionId: string,
    pose: PlayerPose,
): RemoteAvatar {
    const existing = avatars.get(sessionId);
    if (existing) {
        return existing;
    }

    const root = new TransformNode(`remote-${sessionId}`, scene);
    root.position = vector3(pose.position);

    const material = new StandardMaterial(`remote-mat-${sessionId}`, scene);
    material.diffuseColor = Color3.FromHexString(pose.color);
    material.emissiveColor = Color3.FromHexString(pose.color).scale(0.28);
    material.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.22);

    const body = MeshBuilder.CreateCapsule(`remote-body-${sessionId}`, {
        height: 1.85,
        radius: 0.34,
        tessellation: 10,
    }, scene);
    body.parent = root;
    body.position.y = -0.62;
    body.material = material;

    const visorMaterial = new StandardMaterial(`remote-visor-mat-${sessionId}`, scene);
    visorMaterial.diffuseColor = Color3.FromHexString(MATRIX_THEME.void);
    visorMaterial.emissiveColor = Color3.FromHexString(MATRIX_THEME.cyan).scale(0.68);

    const visor = MeshBuilder.CreateBox(`remote-visor-${sessionId}`, {
        width: 0.46,
        height: 0.14,
        depth: 0.08,
    }, scene);
    visor.parent = root;
    visor.position.set(0, 0.02, -0.33);
    visor.material = visorMaterial;

    const accentMaterial = createMatrixMaterial(
        scene,
        `remote-accent-${sessionId}`,
        pose.color,
        pose.color,
        0.78,
        0.78,
    );

    const ring = MeshBuilder.CreateTorus(`remote-floor-ring-${sessionId}`, {
        diameter: 1.05,
        thickness: 0.025,
        tessellation: 32,
    }, scene);
    ring.parent = root;
    ring.position.y = -1.55;
    ring.rotation.x = Math.PI / 2;
    ring.material = accentMaterial;

    const labelTexture = new DynamicTexture(`label-texture-${sessionId}`, {
        width: 512,
        height: 128,
    }, scene);
    labelTexture.hasAlpha = true;
    updateLabel(labelTexture, pose.username, pose.score, pose.combo ?? 0, pose.color);

    const labelMaterial = new StandardMaterial(`label-mat-${sessionId}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`remote-label-${sessionId}`, {
        width: 2.35,
        height: 0.58,
    }, scene);
    label.parent = root;
    label.position.y = 0.92;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    const avatar = {
        root,
        label,
        ring,
        material,
        accentMaterial,
        labelTexture,
    };
    avatars.set(sessionId, avatar);
    return avatar;
}

function updateLabel(
    texture: DynamicTexture,
    username: string,
    score: number,
    combo: number,
    color: string,
): void {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(1, 8, 8, 0.82)';
    ctx.fillRect(10, 20, 492, 86);
    ctx.strokeStyle = MATRIX_THEME.cyan;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 28, 476, 70);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 20, 492, 86);
    ctx.fillStyle = MATRIX_THEME.white;
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(username.slice(0, 18), 34, 60);
    ctx.fillStyle = MATRIX_THEME.acid;
    ctx.font = '500 24px system-ui, sans-serif';
    ctx.fillText(`score ${score}  x${combo}`, 34, 92);
    texture.update();
}

function updateTargetLabel(texture: DynamicTexture, target: EyeTargetState): void {
    const label = getTargetLabel(target);
    const rarity = target.rarity.toUpperCase();
    const accent = target.rarity === 'bounty'
        ? MATRIX_THEME.amber
        : target.rarity === 'rift'
        ? MATRIX_THEME.magenta
        : target.rarity === 'volatile'
        ? MATRIX_THEME.danger
        : MATRIX_THEME.acid;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 768, 192);
    ctx.fillStyle = 'rgba(0, 8, 7, 0.76)';
    ctx.fillRect(16, 24, 736, 132);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 6;
    ctx.strokeRect(16, 24, 736, 132);
    ctx.fillStyle = accent;
    ctx.font = '700 28px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(rarity, 40, 68);
    ctx.fillStyle = MATRIX_THEME.white;
    ctx.font = '700 36px system-ui, sans-serif';
    ctx.fillText(label, 40, 112);
    ctx.fillStyle = 'rgba(239, 255, 247, 0.74)';
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillText(`hp ${Math.max(0, Math.ceil(target.health))}/${target.maxHealth}`, 40, 144);
    texture.update();
}

function getTargetLabel(target: EyeTargetState): string {
    const base = MATRIX_TARGET_LABELS[Math.abs(hashString(target.id)) % MATRIX_TARGET_LABELS.length];
    return target.bountyUntilEpochMs ? `Bounty ${base}` : base;
}

function createTracer(
    runtime: ArenaRuntime,
    origin: Vector3,
    direction: Vector3,
    color: string,
    hit: boolean,
): void {
    const scene = runtime.scene;
    const length = hit ? 42 : 28;
    const end = origin.add(direction.normalize().scale(length));
    const tracer = MeshBuilder.CreateLines(`shot-tracer-${Date.now()}-${Math.random()}`, {
        points: [
            origin,
            end,
        ],
    }, scene);
    tracer.color = Color3.FromHexString(hit ? MATRIX_THEME.amber : color);

    const packetMaterial = createMatrixMaterial(
        scene,
        `shot-packet-mat-${Date.now()}-${Math.random()}`,
        hit ? MATRIX_THEME.amber : MATRIX_THEME.cyan,
        hit ? MATRIX_THEME.amber : MATRIX_THEME.cyan,
        1,
        0.9,
    );
    const packet = MeshBuilder.CreateBox(`shot-packet-${Date.now()}-${Math.random()}`, {
        width: 0.1,
        height: 0.1,
        depth: 0.8,
    }, scene);
    packet.position = Vector3.Center(origin, end);
    packet.lookAt(end);
    packet.material = packetMaterial;

    addTransientEffect(runtime, {
        startedAtMs: performance.now(),
        durationMs: hit ? 150 : 95,
        meshes: [tracer, packet],
        materials: [packetMaterial],
        update: (ageMs, progress) => {
            packet.scaling.z = 1 + progress * 2.4;
            packetMaterial.alpha = Math.max(0, 0.9 - progress * 0.9);
            tracer.visibility = Math.max(0, 1 - ageMs / (hit ? 150 : 95));
        },
    });
}

function createImpact(runtime: ArenaRuntime, point: Vector3, color: string, combo: number): void {
    const scene = runtime.scene;
    const material = createMatrixMaterial(
        scene,
        `impact-mat-${Date.now()}`,
        color,
        color,
        1,
        0.92,
    );

    const burst = MeshBuilder.CreateSphere(`impact-${Date.now()}`, {
        diameter: 0.24 + Math.min(combo, 12) * 0.025,
        segments: 12,
    }, scene);
    burst.position = point.clone();
    burst.material = material;

    const ring = MeshBuilder.CreateTorus(`impact-ring-${Date.now()}`, {
        diameter: 0.62,
        thickness: 0.025,
        tessellation: 28,
    }, scene);
    ring.position = point.clone();
    ring.material = material;

    const ripple = MeshBuilder.CreateTorus(`impact-ripple-${Date.now()}`, {
        diameter: 1.05,
        thickness: 0.018,
        tessellation: 44,
    }, scene);
    ripple.position = point.clone();
    ripple.rotation.x = Math.PI / 2;
    ripple.material = material;

    const shards: Mesh[] = [];
    for (let i = 0; i < Math.min(9, 4 + combo); i += 1) {
        const shard = MeshBuilder.CreateBox(`impact-code-shard-${Date.now()}-${i}`, {
            width: 0.045,
            height: 0.22 + i * 0.015,
            depth: 0.045,
        }, scene);
        shard.position = point.add(new Vector3(
            Math.sin(i * 2.11) * 0.18,
            Math.cos(i * 1.37) * 0.12,
            Math.cos(i * 1.91) * 0.18,
        ));
        shard.rotation.set(i * 0.2, i * 0.45, i * 0.31);
        shard.material = material;
        shards.push(shard);
    }

    addTransientEffect(runtime, {
        startedAtMs: performance.now(),
        durationMs: 320,
        meshes: [burst, ring, ripple, ...shards],
        materials: [material],
        update: (age) => {
            const scale = 1 + age / 70;
            burst.scaling.set(scale, scale, scale);
            ring.scaling.set(scale * 1.7, scale * 1.7, scale * 1.7);
            ripple.scaling.set(scale * 2.2, scale * 2.2, scale * 2.2);
            ring.rotation.y += 0.08;
            ripple.rotation.z += 0.05;
            for (const [index, shard] of shards.entries()) {
                shard.position.x += Math.sin(index * 1.7) * 0.012;
                shard.position.y += 0.018;
                shard.position.z += Math.cos(index * 1.3) * 0.012;
                shard.rotation.y += 0.16;
            }
            material.alpha = Math.max(0, 1 - age / 320);
        },
    });
}

function createScanPulse(runtime: ArenaRuntime, position: Vec3Tuple, color: string): void {
    const scene = runtime.scene;
    const material = createMatrixMaterial(
        scene,
        `scan-pulse-mat-${Date.now()}`,
        color,
        color,
        0.95,
        0.55,
    );

    const ring = MeshBuilder.CreateTorus(`scan-pulse-${Date.now()}`, {
        diameter: 1.2,
        thickness: 0.035,
        tessellation: 48,
    }, scene);
    ring.position = vector3(position);
    ring.position.y = 0.12;
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const column = MeshBuilder.CreateCylinder(`scan-column-${Date.now()}`, {
        height: 6.2,
        diameter: 0.52,
        tessellation: 24,
    }, scene);
    column.position = vector3(position);
    column.position.y = 3.1;
    column.material = material;

    addTransientEffect(runtime, {
        startedAtMs: performance.now(),
        durationMs: 560,
        meshes: [ring, column],
        materials: [material],
        update: (age) => {
            const scale = 1 + age / 42;
            ring.scaling.set(scale, scale, scale);
            column.scaling.x = 1 + age / 260;
            column.scaling.z = 1 + age / 260;
            column.rotation.y += 0.08;
            material.alpha = Math.max(0, 0.55 - age / 560);
        },
    });
}

function createArenaEventEffect(runtime: ArenaRuntime, event: ArenaEvent): void {
    const scene = runtime.scene;
    const color = event.kind === 'overdrive-window'
        ? MATRIX_THEME.amber
        : event.kind === 'hazard-burst'
        ? MATRIX_THEME.danger
        : event.kind === 'arena-shift'
        ? MATRIX_THEME.magenta
        : MATRIX_THEME.acid;
    const material = createMatrixMaterial(scene, `event-mat-${event.id}`, color, color, 0.92, 0.42);

    const ring = MeshBuilder.CreateTorus(`event-ring-${event.id}`, {
        diameter: (event.radius ?? 6) * 2,
        thickness: 0.065,
        tessellation: 64,
    }, scene);
    ring.position = vector3(event.position ?? [0, 0.16, 0]);
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const labelTexture = new DynamicTexture(`event-label-texture-${event.id}`, {
        width: 768,
        height: 256,
    }, scene);
    labelTexture.hasAlpha = true;
    drawMatrixPanel(labelTexture, event.kind.toUpperCase(), getArenaEventJoke(event.kind), color);
    const labelMaterial = new StandardMaterial(`event-label-mat-${event.id}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`event-label-${event.id}`, {
        width: 4.5,
        height: 1.5,
    }, scene);
    label.position = vector3(event.position ?? [0, 0.16, 0]);
    label.position.y += 2.35;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    const duration = Math.min(900, Math.max(360, event.durationMs ?? 700));
    addTransientEffect(runtime, {
        startedAtMs: performance.now(),
        durationMs: duration + 240,
        meshes: [ring, label],
        materials: [material, labelMaterial],
        textures: [labelTexture],
        update: (age) => {
            const pulse = 1 + Math.sin(age / 48) * 0.025 + age / duration * 0.22;
            ring.scaling.set(pulse, pulse, pulse);
            ring.rotation.z += 0.018;
            label.position.y += Math.sin(age / 80) * 0.002;
            material.alpha = Math.max(0, 0.42 - age / duration);
            labelMaterial.alpha = Math.max(0, 1 - Math.max(0, age - duration) / 240);
        },
    });
}

function addTransientEffect(runtime: ArenaRuntime, effect: TransientEffect): void {
    while (runtime.transientEffects.length >= MAX_TRANSIENT_EFFECTS) {
        const oldest = runtime.transientEffects.shift();
        if (oldest) {
            disposeTransientEffect(oldest);
        }
    }
    runtime.transientEffects.push(effect);
}

function updateTransientEffects(runtime: ArenaRuntime): void {
    const now = performance.now();
    runtime.transientEffects = runtime.transientEffects.filter((effect) => {
        const age = now - effect.startedAtMs;
        const progress = clamp(age / effect.durationMs, 0, 1);
        effect.update?.(age, progress);
        if (age < effect.durationMs) {
            return true;
        }
        disposeTransientEffect(effect);
        return false;
    });
}

function disposeTransientEffect(effect: TransientEffect): void {
    for (const mesh of effect.meshes) {
        mesh.dispose();
    }
    for (const material of effect.materials) {
        material.dispose();
    }
    for (const texture of effect.textures ?? []) {
        texture.dispose();
    }
}

function getArenaEventJoke(kind: ArenaEvent['kind']): string {
    if (kind === 'overdrive-window') {
        return 'approved overtime for your trigger finger';
    }
    if (kind === 'hazard-burst') {
        return 'workplace safety is in beta';
    }
    if (kind === 'arena-shift') {
        return 'floor plan updated without consent';
    }
    if (kind === 'combo-bounty') {
        return 'metrics adore your violence';
    }
    if (kind === 'reward-drop') {
        return 'loyalty program got nervous';
    }
    return 'the director has opinions';
}

function setInputKey(input: MutableInputState, code: string, pressed: boolean): void {
    if (code === 'KeyW') {
        input.moveZ = pressed ? 1 : input.moveZ === 1 ? 0 : input.moveZ;
    } else if (code === 'KeyS') {
        input.moveZ = pressed ? -1 : input.moveZ === -1 ? 0 : input.moveZ;
    } else if (code === 'KeyA') {
        input.moveX = pressed ? -1 : input.moveX === -1 ? 0 : input.moveX;
    } else if (code === 'KeyD') {
        input.moveX = pressed ? 1 : input.moveX === 1 ? 0 : input.moveX;
    } else if (code === 'ShiftLeft' || code === 'ShiftRight') {
        input.sprint = pressed;
    } else if (code === 'Space') {
        input.jump = pressed;
    } else if (code === 'KeyE') {
        input.dash = pressed;
    } else if (code === 'ControlLeft' || code === 'KeyC') {
        input.slide = pressed;
    } else if (code === 'KeyQ') {
        input.overdrive = pressed;
    } else if (code === 'Escape') {
        input.pause = pressed;
    }
}

function freezeInput(input: MutableInputState): PlayerInputState {
    return {
        moveX: input.moveX,
        moveZ: input.moveZ,
        sprint: input.sprint,
        dash: input.dash,
        slide: input.slide,
        jump: input.jump,
        fire: input.fire,
        altFire: input.altFire,
        overdrive: input.overdrive,
        pause: input.pause,
    };
}

function writeArenaDiagnostics(canvas: HTMLCanvasElement, runtime: ArenaRuntime): void {
    canvas.dataset.arenaRuntimeReady = 'true';
    canvas.dataset.arenaVisualTheme = 'neon-matrix';
    canvas.dataset.arenaMeshCount = String(runtime.scene.meshes.length);
    canvas.dataset.arenaEffectCount = String(runtime.transientEffects.length);
    canvas.dataset.arenaActiveEffectCount = String(runtime.transientEffects.length);
    canvas.dataset.arenaTargetCount = String(runtime.targets.size);
}

function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash;
}

function forwardFromAngles(yaw: number, pitch: number): Vec3Tuple {
    const cosPitch = Math.cos(pitch);
    return [
        Math.sin(yaw) * cosPitch,
        -Math.sin(pitch),
        Math.cos(yaw) * cosPitch,
    ];
}

function vector3(tuple: Vec3Tuple): Vector3 {
    return new Vector3(tuple[0], tuple[1], tuple[2]);
}

function addTuple(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleTuple(a: Vec3Tuple, scalar: number): Vec3Tuple {
    return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
