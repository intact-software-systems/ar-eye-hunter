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
    material: StandardMaterial;
    labelTexture: DynamicTexture;
}>;

type TargetAvatar = Readonly<{
    root: TransformNode;
    iris: Mesh;
    pupil: Mesh;
    ring: Mesh;
    coreMaterial: StandardMaterial;
    pupilMaterial: StandardMaterial;
    ringMaterial: StandardMaterial;
}>;

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
        scene.clearColor = new Color4(0.015, 0.017, 0.02, 1);
        scene.collisionsEnabled = true;

        const camera = new FreeCamera('hunter-camera', new Vector3(0, 1.72, -11), scene);
        camera.minZ = 0.05;
        camera.maxZ = 120;
        camera.fov = BASE_FOV;

        const glow = new GlowLayer('arena-glow', scene);
        glow.intensity = 0.68;

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
            canvas.requestPointerLock?.();
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
                createScanPulse(runtime.scene, runtime.localPlayer.position, localColor);
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

        engine.runRenderLoop(() => scene.render());

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
        createArenaEventEffect(runtime.scene, event);
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
    publishLocalPose(runtime.localPlayer, poseSeqRef, callbacksRef, localPoseRef);

    if (runtime.lastSnapshotRevision !== runtime.arenaState.revision) {
        runtime.lastSnapshotRevision = runtime.arenaState.revision;
        callbacksRef.current.onArenaSnapshot(
            toArenaSnapshot(runtime.arenaState, roomId, now),
        );
    }
}

function buildArena(scene: Scene): void {
    const floorMaterial = new StandardMaterial('floor-mat', scene);
    floorMaterial.diffuseColor = new Color3(0.09, 0.13, 0.15);
    floorMaterial.specularColor = new Color3(0.18, 0.24, 0.28);
    floorMaterial.emissiveColor = new Color3(0.015, 0.045, 0.055);

    const gridTexture = new DynamicTexture('floor-grid', { width: 1024, height: 1024 }, scene);
    const ctx = gridTexture.getContext();
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i <= 1024; i += 64) {
        ctx.strokeStyle = i % 256 === 0 ? '#ef476f' : '#2ec4b6';
        ctx.globalAlpha = i % 256 === 0 ? 0.62 : 0.28;
        ctx.lineWidth = i % 256 === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 1024);
        ctx.moveTo(0, i);
        ctx.lineTo(1024, i);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    gridTexture.update();
    floorMaterial.diffuseTexture = gridTexture;

    const floor = MeshBuilder.CreateGround('floor', {
        width: ARENA_SIZE,
        height: ARENA_SIZE,
        subdivisions: 16,
    }, scene);
    floor.material = floorMaterial;

    const wallMaterial = new StandardMaterial('wall-mat', scene);
    wallMaterial.diffuseColor = new Color3(0.14, 0.12, 0.18);
    wallMaterial.specularColor = new Color3(0.26, 0.21, 0.35);
    wallMaterial.emissiveColor = new Color3(0.035, 0.02, 0.055);

    const railMaterial = new StandardMaterial('rail-mat', scene);
    railMaterial.diffuseColor = Color3.FromHexString('#ffc857');
    railMaterial.emissiveColor = Color3.FromHexString('#ff4d6d').scale(0.35);

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
            ring.material = railMaterial;
        }
    }

    const hemi = new HemisphericLight('arena-hemi', new Vector3(0.1, 1, -0.2), scene);
    hemi.intensity = 0.78;
    hemi.groundColor = new Color3(0.08, 0.06, 0.12);

    const magenta = new PointLight('magenta-hotspot', new Vector3(-12, 5, -10), scene);
    magenta.diffuse = Color3.FromHexString('#ff4d6d');
    magenta.intensity = 0.88;
    magenta.range = 24;

    const cyan = new PointLight('cyan-hotspot', new Vector3(13, 4, 9), scene);
    cyan.diffuse = Color3.FromHexString('#00c2a8');
    cyan.intensity = 0.72;
    cyan.range = 26;
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

    createTracer(runtime.scene, vector3(origin), vector3(direction), localColor, resolution.accepted.hit);
    if (resolution.accepted.hit) {
        createImpact(runtime.scene, vector3(resolution.accepted.impact), '#ffc857', resolution.accepted.combo);
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
        avatar.coreMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.44);
        avatar.ringMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.9);
    }

    for (const [targetId, avatar] of runtime.targets) {
        if (targetIds.has(targetId)) {
            continue;
        }
        avatar.root.dispose();
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
    coreMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.44);
    coreMaterial.specularColor = Color3.FromHexString('#f7f1de').scale(0.35);

    const pupilMaterial = new StandardMaterial(`target-pupil-${target.id}`, scene);
    pupilMaterial.diffuseColor = new Color3(0.02, 0.025, 0.025);
    pupilMaterial.emissiveColor = Color3.FromHexString('#101820').scale(0.9);

    const ringMaterial = new StandardMaterial(`target-ring-${target.id}`, scene);
    ringMaterial.diffuseColor = Color3.FromHexString(target.color);
    ringMaterial.emissiveColor = Color3.FromHexString(target.color).scale(0.9);

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

    const avatar = {
        root,
        iris,
        pupil,
        ring,
        coreMaterial,
        pupilMaterial,
        ringMaterial,
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
        avatar.material.emissiveColor = Color3.FromHexString(pose.color).scale(0.2);
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
            runtime.scene,
            vector3(shot.origin),
            vector3(shot.direction),
            shot.color,
            !!remoteShot.accepted?.hit,
        );
        if (remoteShot.accepted?.hit) {
            createImpact(
                runtime.scene,
                vector3(remoteShot.accepted.impact),
                '#ff4d6d',
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
    material.emissiveColor = Color3.FromHexString(pose.color).scale(0.2);

    const body = MeshBuilder.CreateCapsule(`remote-body-${sessionId}`, {
        height: 1.85,
        radius: 0.34,
        tessellation: 10,
    }, scene);
    body.parent = root;
    body.position.y = -0.62;
    body.material = material;

    const visorMaterial = new StandardMaterial(`remote-visor-mat-${sessionId}`, scene);
    visorMaterial.diffuseColor = Color3.FromHexString('#101820');
    visorMaterial.emissiveColor = Color3.FromHexString('#00c2a8').scale(0.42);

    const visor = MeshBuilder.CreateBox(`remote-visor-${sessionId}`, {
        width: 0.46,
        height: 0.14,
        depth: 0.08,
    }, scene);
    visor.parent = root;
    visor.position.set(0, 0.02, -0.33);
    visor.material = visorMaterial;

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
        material,
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
    ctx.fillStyle = 'rgba(8, 10, 14, 0.74)';
    ctx.fillRect(10, 20, 492, 86);
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 20, 492, 86);
    ctx.fillStyle = '#f7f1de';
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(username.slice(0, 18), 34, 60);
    ctx.fillStyle = '#ffc857';
    ctx.font = '500 24px system-ui, sans-serif';
    ctx.fillText(`score ${score}  x${combo}`, 34, 92);
    texture.update();
}

function createTracer(
    scene: Scene,
    origin: Vector3,
    direction: Vector3,
    color: string,
    hit: boolean,
): void {
    const length = hit ? 42 : 28;
    const tracer = MeshBuilder.CreateLines(`shot-tracer-${Date.now()}-${Math.random()}`, {
        points: [
            origin,
            origin.add(direction.normalize().scale(length)),
        ],
    }, scene);
    tracer.color = Color3.FromHexString(hit ? '#ffc857' : color);
    tracer.enableEdgesRendering();

    window.setTimeout(() => {
        tracer.dispose();
    }, hit ? 120 : 80);
}

function createImpact(scene: Scene, point: Vector3, color: string, combo: number): void {
    const material = new StandardMaterial(`impact-mat-${Date.now()}`, scene);
    material.diffuseColor = Color3.FromHexString(color);
    material.emissiveColor = Color3.FromHexString(color);
    material.alpha = 0.92;

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

    const start = performance.now();
    const observer = scene.onBeforeRenderObservable.add(() => {
        const age = performance.now() - start;
        const scale = 1 + age / 70;
        burst.scaling.set(scale, scale, scale);
        ring.scaling.set(scale * 1.7, scale * 1.7, scale * 1.7);
        ring.rotation.y += 0.08;
        material.alpha = Math.max(0, 1 - age / 260);
        if (age > 260) {
            scene.onBeforeRenderObservable.remove(observer);
            burst.dispose();
            ring.dispose();
            material.dispose();
        }
    });
}

function createScanPulse(scene: Scene, position: Vec3Tuple, color: string): void {
    const material = new StandardMaterial(`scan-pulse-mat-${Date.now()}`, scene);
    material.diffuseColor = Color3.FromHexString(color);
    material.emissiveColor = Color3.FromHexString(color).scale(0.9);
    material.alpha = 0.55;

    const ring = MeshBuilder.CreateTorus(`scan-pulse-${Date.now()}`, {
        diameter: 1.2,
        thickness: 0.035,
        tessellation: 48,
    }, scene);
    ring.position = vector3(position);
    ring.position.y = 0.12;
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const start = performance.now();
    const observer = scene.onBeforeRenderObservable.add(() => {
        const age = performance.now() - start;
        const scale = 1 + age / 42;
        ring.scaling.set(scale, scale, scale);
        material.alpha = Math.max(0, 0.55 - age / 520);
        if (age > 520) {
            scene.onBeforeRenderObservable.remove(observer);
            ring.dispose();
            material.dispose();
        }
    });
}

function createArenaEventEffect(scene: Scene, event: ArenaEvent): void {
    const material = new StandardMaterial(`event-mat-${event.id}`, scene);
    const color = event.kind === 'overdrive-window'
        ? '#ffc857'
        : event.kind === 'hazard-burst'
        ? '#ff4d6d'
        : event.kind === 'arena-shift'
        ? '#8e7dff'
        : '#00c2a8';
    material.diffuseColor = Color3.FromHexString(color);
    material.emissiveColor = Color3.FromHexString(color).scale(0.75);
    material.alpha = 0.42;

    const ring = MeshBuilder.CreateTorus(`event-ring-${event.id}`, {
        diameter: (event.radius ?? 6) * 2,
        thickness: 0.065,
        tessellation: 64,
    }, scene);
    ring.position = vector3(event.position ?? [0, 0.16, 0]);
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const start = performance.now();
    const duration = Math.min(900, Math.max(360, event.durationMs ?? 700));
    const observer = scene.onBeforeRenderObservable.add(() => {
        const age = performance.now() - start;
        const pulse = 1 + Math.sin(age / 48) * 0.025 + age / duration * 0.22;
        ring.scaling.set(pulse, pulse, pulse);
        ring.rotation.z += 0.018;
        material.alpha = Math.max(0, 0.42 - age / duration);
        if (age > duration) {
            scene.onBeforeRenderObservable.remove(observer);
            ring.dispose();
            material.dispose();
        }
    });
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
