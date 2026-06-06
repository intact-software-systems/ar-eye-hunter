import { type MutableRefObject, useEffect, useRef } from 'react';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Ray } from '@babylonjs/core/Culling/ray.js';
import { Scene } from '@babylonjs/core/scene.js';
import '@babylonjs/core/Collisions/collisionCoordinator';
import {
    createRallarMotionBuffer,
    estimateRallarMotionVelocity,
    type RallarMotionBuffer,
} from '@shared/rallar-motion/mod.ts';

import type { PlayerPose, PlayerShot, RemotePlayer, RemoteShot, Vec3Tuple } from './types.ts';

type BabylonArenaProps = Readonly<{
    localUsername: string;
    localColor: string;
    roomReady: boolean;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    onLocalPose: (pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>) => void;
    onLocalShot: (shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>) => void;
    onScoreChange: (score: number) => void;
}>;

type RemoteAvatar = Readonly<{
    root: TransformNode;
    body: Mesh;
    label: Mesh;
    material: StandardMaterial;
    labelTexture: DynamicTexture;
}>;

type ArenaRuntime = Readonly<{
    engine: Engine;
    scene: Scene;
    camera: FreeCamera;
    avatars: Map<string, RemoteAvatar>;
    motionBuffer: RallarMotionBuffer<PlayerPose>;
    motionSampleKeys: Map<string, string>;
    eyeTargets: Mesh[];
    remoteShotIds: Set<string>;
}>;

type LocalPoseHistory = Readonly<{
    observedAtEpochMs: number;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
}>;

const ARENA_SIZE = 42;

export function BabylonArena({
                                 localUsername,
                                 localColor,
                                 roomReady,
                                 remotePlayers,
                                 remoteShots,
                                 onLocalPose,
                                 onLocalShot,
                                 onScoreChange,
                             }: BabylonArenaProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<ArenaRuntime | undefined>(undefined);
    const remotePlayersRef = useRef(remotePlayers);
    const remoteShotsRef = useRef(remoteShots);
    const callbacksRef = useRef({
        onLocalPose,
        onLocalShot,
        onScoreChange,
    });
    const scoreRef = useRef(0);
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
        callbacksRef.current = {
            onLocalPose,
            onLocalShot,
            onScoreChange,
        };
    }, [onLocalPose, onLocalShot, onScoreChange]);

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
        scene.clearColor = new Color4(0.018, 0.019, 0.016, 1);
        scene.collisionsEnabled = true;
        scene.gravity = new Vector3(0, -0.24, 0);

        const camera = new FreeCamera('hunter-camera', new Vector3(0, 2.1, -9), scene);
        camera.minZ = 0.05;
        camera.speed = 0.42;
        camera.angularSensibility = 3500;
        camera.inertia = 0.28;
        camera.applyGravity = true;
        camera.checkCollisions = true;
        camera.ellipsoid = new Vector3(0.55, 1.0, 0.55);
        camera.keysUp.push(87);
        camera.keysDown.push(83);
        camera.keysLeft.push(65);
        camera.keysRight.push(68);
        camera.attachControl(canvas, true);

        buildArena(scene);
        const eyeTargets = buildTargets(scene);

        const runtime: ArenaRuntime = {
            engine,
            scene,
            camera,
            avatars: new Map(),
            motionBuffer: createRallarMotionBuffer<PlayerPose>(),
            motionSampleKeys: new Map(),
            eyeTargets,
            remoteShotIds: new Set(),
        };
        runtimeRef.current = runtime;

        const resize = () => engine.resize();
        window.addEventListener('resize', resize);

        const onPointerDown = (event: PointerEvent) => {
            if (event.button !== 0) {
                return;
            }
            canvas.requestPointerLock?.();
            fireLocalShot(runtime, localUsername, localColor, shotSeqRef, scoreRef, callbacksRef);
        };
        canvas.addEventListener('pointerdown', onPointerDown);

        scene.onBeforeRenderObservable.add(() => {
            syncRemoteAvatars(runtime, remotePlayersRef.current);
            syncRemoteShots(runtime, remoteShotsRef.current);
            publishLocalPose(runtime.camera, poseSeqRef, scoreRef.current, callbacksRef, localPoseRef);
        });

        engine.runRenderLoop(() => scene.render());

        return () => {
            canvas.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('resize', resize);
            scene.dispose();
            engine.dispose();
            runtimeRef.current = undefined;
        };
    }, [localColor, localUsername]);

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
                        Join or create an arena room to activate multiplayer.
                    </div>
                </div>
            )}
            <div className="crosshair" aria-hidden="true">
                <span/>
            </div>
        </div>
    );
}

function buildArena(scene: Scene): void {
    const floorMaterial = new StandardMaterial('floor-mat', scene);
    floorMaterial.diffuseColor = new Color3(0.18, 0.19, 0.16);
    floorMaterial.specularColor = new Color3(0.12, 0.12, 0.1);

    const gridTexture = new DynamicTexture('floor-grid', { width: 1024, height: 1024 }, scene);
    const ctx = gridTexture.getContext();
    ctx.fillStyle = '#2b2d25';
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.strokeStyle = '#54624f';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 1024; i += 64) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 1024);
        ctx.moveTo(0, i);
        ctx.lineTo(1024, i);
        ctx.stroke();
    }
    gridTexture.update();
    floorMaterial.diffuseTexture = gridTexture;

    const floor = MeshBuilder.CreateGround('floor', {
        width: ARENA_SIZE,
        height: ARENA_SIZE,
        subdivisions: 8,
    }, scene);
    floor.material = floorMaterial;
    floor.checkCollisions = true;

    const wallMaterial = new StandardMaterial('wall-mat', scene);
    wallMaterial.diffuseColor = new Color3(0.27, 0.26, 0.22);
    wallMaterial.specularColor = new Color3(0.08, 0.08, 0.07);

    const railMaterial = new StandardMaterial('rail-mat', scene);
    railMaterial.diffuseColor = new Color3(0.72, 0.18, 0.12);
    railMaterial.emissiveColor = new Color3(0.12, 0.02, 0.01);

    const wallSpecs = [
        { name: 'north-wall', position: [0, 2.5, ARENA_SIZE / 2], scaling: [ARENA_SIZE, 5, 0.7] },
        { name: 'south-wall', position: [0, 2.5, -ARENA_SIZE / 2], scaling: [ARENA_SIZE, 5, 0.7] },
        { name: 'east-wall', position: [ARENA_SIZE / 2, 2.5, 0], scaling: [0.7, 5, ARENA_SIZE] },
        { name: 'west-wall', position: [-ARENA_SIZE / 2, 2.5, 0], scaling: [0.7, 5, ARENA_SIZE] },
    ] as const;

    for (const spec of wallSpecs) {
        const wall = MeshBuilder.CreateBox(spec.name, { size: 1 }, scene);
        wall.position.set(spec.position[0], spec.position[1], spec.position[2]);
        wall.scaling.set(spec.scaling[0], spec.scaling[1], spec.scaling[2]);
        wall.material = wallMaterial;
        wall.checkCollisions = true;
    }

    const light = new HemisphericLight('arena-hemi', new Vector3(0.1, 1, -0.2), scene);
    light.intensity = 0.76;
    light.groundColor = new Color3(0.28, 0.21, 0.16);

    for (const [i, x] of [-12, 0, 12].entries()) {
        for (const z of [-10, 8]) {
            const pillar = MeshBuilder.CreateCylinder(`pillar-${i}-${z}`, {
                height: 4.2,
                diameterTop: 1.1,
                diameterBottom: 1.4,
                tessellation: 8,
            }, scene);
            pillar.position.set(x, 2.1, z);
            pillar.material = wallMaterial;
            pillar.checkCollisions = true;

            const rail = MeshBuilder.CreateTorus(`rail-${i}-${z}`, {
                diameter: 1.7,
                thickness: 0.06,
                tessellation: 16,
            }, scene);
            rail.position.set(x, 3.75, z);
            rail.material = railMaterial;
        }
    }
}

function buildTargets(scene: Scene): Mesh[] {
    const targets: Mesh[] = [];
    const irisMaterial = new StandardMaterial('eye-iris-mat', scene);
    irisMaterial.diffuseColor = new Color3(0.9, 0.95, 0.74);
    irisMaterial.emissiveColor = new Color3(0.25, 0.42, 0.12);

    const pupilMaterial = new StandardMaterial('eye-pupil-mat', scene);
    pupilMaterial.diffuseColor = new Color3(0.04, 0.05, 0.045);
    pupilMaterial.emissiveColor = new Color3(0.0, 0.05, 0.03);

    for (let i = 0; i < 9; i += 1) {
        const root = new TransformNode(`eye-root-${i}`, scene);
        root.position = targetPosition(i);

        const iris = MeshBuilder.CreateSphere(`eye-target-${i}`, {
            diameterX: 1.4,
            diameterY: 0.9,
            diameterZ: 0.45,
            segments: 24,
        }, scene);
        iris.parent = root;
        iris.material = irisMaterial;

        const pupil = MeshBuilder.CreateSphere(`eye-pupil-${i}`, {
            diameterX: 0.44,
            diameterY: 0.44,
            diameterZ: 0.12,
            segments: 16,
        }, scene);
        pupil.parent = root;
        pupil.position.z = -0.22;
        pupil.material = pupilMaterial;

        iris.metadata = { targetRoot: root, targetIndex: i };
        targets.push(iris);
    }

    scene.onBeforeRenderObservable.add(() => {
        const seconds = performance.now() / 1000;
        for (const [index, target] of targets.entries()) {
            const root = target.metadata?.targetRoot as TransformNode | undefined;
            if (!root) {
                continue;
            }
            root.position.y = 2.8 + Math.sin(seconds * 1.2 + index) * 0.45;
            root.rotation.y += 0.012;
        }
    });

    return targets;
}

function targetPosition(index: number): Vector3 {
    const ring = index % 3;
    const angle = (index / 9) * Math.PI * 2;
    const radius = 7 + ring * 4;
    return new Vector3(
        Math.cos(angle) * radius,
        2.8,
        Math.sin(angle) * radius,
    );
}

function fireLocalShot(
    runtime: ArenaRuntime,
    username: string,
    color: string,
    shotSeqRef: MutableRefObject<number>,
    scoreRef: MutableRefObject<number>,
    callbacksRef: MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onScoreChange: BabylonArenaProps['onScoreChange'];
    }>,
): void {
    const camera = runtime.camera;
    const origin = camera.position.clone();
    const forward = camera.getForwardRay(70).direction.normalize();
    const ray = new Ray(origin, forward, 70);
    const hit = runtime.scene.pickWithRay(ray, (mesh) =>
        mesh.name.startsWith('eye-target')
    );

    if (hit?.hit && hit.pickedMesh) {
        const targetRoot = hit.pickedMesh.metadata?.targetRoot as TransformNode | undefined;
        const targetIndex = hit.pickedMesh.metadata?.targetIndex as number | undefined;
        if (targetRoot && targetIndex !== undefined) {
            targetRoot.position = targetPosition((targetIndex + Math.floor(Math.random() * 9) + 1) % 9);
            scoreRef.current += 1;
            callbacksRef.current.onScoreChange(scoreRef.current);
            createImpact(runtime.scene, hit.pickedPoint ?? targetRoot.position, '#ffc857');
        }
    }

    createTracer(runtime.scene, origin, forward, color);
    shotSeqRef.current += 1;
    callbacksRef.current.onLocalShot({
        origin: [origin.x, origin.y, origin.z],
        direction: [forward.x, forward.y, forward.z],
        seq: shotSeqRef.current,
        sentAtEpochMs: Date.now(),
    });

    void username;
}

function publishLocalPose(
    camera: FreeCamera,
    poseSeqRef: MutableRefObject<number>,
    score: number,
    callbacksRef: MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onScoreChange: BabylonArenaProps['onScoreChange'];
    }>,
    localPoseRef: MutableRefObject<LocalPoseHistory | undefined>,
): void {
    const now = Date.now();
    const position: Vec3Tuple = [
        round3(camera.position.x),
        round3(camera.position.y),
        round3(camera.position.z),
    ];
    const rotation: Vec3Tuple = [
        round3(camera.rotation.x),
        round3(camera.rotation.y),
        round3(camera.rotation.z),
    ];
    const current: LocalPoseHistory = {
        observedAtEpochMs: now,
        position,
        rotation,
    };
    const previous = localPoseRef.current;
    const velocity = previous
        ? estimateRallarMotionVelocity(previous, current)
        : undefined;
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
        score,
        seq: poseSeqRef.current,
        sentAtEpochMs: now,
    });
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

        avatar.root.position = Vector3.FromArray([...position]);
        avatar.root.rotation.y = rotation[1];
        avatar.material.diffuseColor = Color3.FromHexString(pose.color);
        updateLabel(avatar.labelTexture, pose.username, pose.score, pose.color);
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
        const origin = Vector3.FromArray([...remoteShot.shot.origin]);
        const direction = Vector3.FromArray([...remoteShot.shot.direction]).normalize();
        createTracer(runtime.scene, origin, direction, remoteShot.shot.color);
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
    root.position = Vector3.FromArray([...pose.position]);

    const material = new StandardMaterial(`remote-mat-${sessionId}`, scene);
    material.diffuseColor = Color3.FromHexString(pose.color);
    material.emissiveColor = Color3.FromHexString(pose.color).scale(0.14);

    const body = MeshBuilder.CreateCapsule(`remote-body-${sessionId}`, {
        height: 1.9,
        radius: 0.36,
        tessellation: 10,
    }, scene);
    body.parent = root;
    body.position.y = 0.1;
    body.material = material;

    const visorMaterial = new StandardMaterial(`remote-visor-mat-${sessionId}`, scene);
    visorMaterial.diffuseColor = new Color3(0.03, 0.035, 0.03);
    visorMaterial.emissiveColor = new Color3(0.02, 0.16, 0.12);

    const visor = MeshBuilder.CreateBox(`remote-visor-${sessionId}`, {
        width: 0.42,
        height: 0.14,
        depth: 0.08,
    }, scene);
    visor.parent = root;
    visor.position.set(0, 0.6, -0.33);
    visor.material = visorMaterial;

    const labelTexture = new DynamicTexture(`label-texture-${sessionId}`, {
        width: 512,
        height: 128,
    }, scene);
    labelTexture.hasAlpha = true;
    updateLabel(labelTexture, pose.username, pose.score, pose.color);

    const labelMaterial = new StandardMaterial(`label-mat-${sessionId}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`remote-label-${sessionId}`, {
        width: 2.4,
        height: 0.6,
    }, scene);
    label.parent = root;
    label.position.y = 1.55;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    const avatar = {
        root,
        body,
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
    color: string,
): void {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(8, 10, 9, 0.78)';
    ctx.fillRect(10, 20, 492, 86);
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 20, 492, 86);
    ctx.fillStyle = '#f7f1de';
    ctx.font = '600 36px system-ui, sans-serif';
    ctx.fillText(username.slice(0, 18), 34, 60);
    ctx.fillStyle = '#ffc857';
    ctx.font = '500 26px system-ui, sans-serif';
    ctx.fillText(`score ${score}`, 34, 92);
    texture.update();
}

function createTracer(scene: Scene, origin: Vector3, direction: Vector3, color: string): void {
    const length = 10;
    const tracer = MeshBuilder.CreateLines(`shot-tracer-${Date.now()}`, {
        points: [
            origin,
            origin.add(direction.scale(length)),
        ],
    }, scene);
    tracer.color = Color3.FromHexString(color);
    tracer.enableEdgesRendering();

    window.setTimeout(() => {
        tracer.dispose();
    }, 140);
}

function createImpact(scene: Scene, point: Vector3, color: string): void {
    const material = new StandardMaterial(`impact-mat-${Date.now()}`, scene);
    material.diffuseColor = Color3.FromHexString(color);
    material.emissiveColor = Color3.FromHexString(color);

    const burst = MeshBuilder.CreateSphere(`impact-${Date.now()}`, {
        diameter: 0.24,
        segments: 12,
    }, scene);
    burst.position = point.clone();
    burst.material = material;

    const start = performance.now();
    const observer = scene.onBeforeRenderObservable.add(() => {
        const age = performance.now() - start;
        const scale = 1 + age / 80;
        burst.scaling.set(scale, scale, scale);
        material.alpha = Math.max(0, 1 - age / 220);
        if (age > 220) {
            scene.onBeforeRenderObservable.remove(observer);
            burst.dispose();
            material.dispose();
        }
    });
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
