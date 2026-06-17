import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
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
    applyPlayerHitAccepted,
    createInitialArenaState,
    createInitialPlayerState,
    EMPTY_INPUT,
    findPickupNearPlayer,
    getWeaponStats,
    hydrateArenaSnapshot,
    resolveShot,
    stepLocalPlayer,
    stepArenaDirectorState,
    toArenaSnapshot,
    upsertPlayerPose,
    type ArenaSimulationState,
    type LocalPlayerState,
} from './simulation.ts';
import { blocksShot } from './arenaLayout.ts';
import {
    calculateVirtualStick,
    chooseTouchAimCandidate,
    createDefaultMobileControlSettings,
    createInitialTouchControlState,
    createTouchControlDiagnostics,
    loadMobileControlSettings,
    mapTouchLookDelta,
    normalizeMobileControlSettings,
    resetTouchPointer,
    saveMobileControlSettings,
    shouldFireHeldWeapon,
    updateTouchPointer,
    type InputDeviceKind,
    type MobileControlSettings,
    type Point2,
    type TouchAimCandidate,
    type TouchControlState,
    type VirtualStickResult,
} from './mobileInput.ts';
import {
    ProceduralArenaAudio,
    loadArenaAudioSettings,
    normalizeArenaAudioSettings,
    saveArenaAudioSettings,
    type ArenaAudioSettings,
} from './arenaAudio.ts';
import type {
    ArenaLayoutSpec,
    ArenaLayoutProp,
    ArenaEvent,
    ArenaSnapshot,
    ArenaPickupState,
    EyeAttackCue,
    EyeTargetState,
    PickupIntent,
    PlayerArenaState,
    PlayerCombatState,
    PlayerHitAccepted,
    PlayerHitIntent,
    PlayerInputState,
    PlayerPose,
    PlayerShot,
    RemotePlayer,
    RemoteShot,
    ShotAccepted,
    ShotIntent,
    Vec3Tuple,
} from './types.ts';
import { avatarAccentForPalette } from './avatarProfile.ts';

type BabylonArenaProps = Readonly<{
    localSessionId?: string;
    localUsername: string;
    localColor: string;
    roomId?: string;
    roomReady: boolean;
    networkEnabled: boolean;
    diagnosticsAttributes?: Readonly<Record<string, string>>;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    remotePlayerHits: readonly PlayerHitAccepted[];
    remoteEvents: readonly ArenaEvent[];
    arenaSnapshot?: ArenaSnapshot;
    onLocalPose: (pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>) => void;
    onLocalShot: (
        shot: Omit<ShotIntent, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ) => void;
    onPlayerHitIntent: (intent: PlayerHitIntent) => void;
    onPickupIntent: (intent: PickupIntent) => void;
    onLocalCombatChange: (combat: PlayerCombatState) => void;
    onLocalPlayerChange: (player: Pick<PlayerArenaState, 'vitals' | 'loadout'>) => void;
    onArenaSnapshot: (snapshot: ArenaSnapshot) => void;
}>;

type RemoteAvatar = Readonly<{
    root: TransformNode;
    body: Mesh;
    visor: Mesh;
    shoulderLeft: Mesh;
    shoulderRight: Mesh;
    trail: Mesh;
    decal: Mesh;
    label: Mesh;
    ring: Mesh;
    health: Mesh;
    material: StandardMaterial;
    accentMaterial: StandardMaterial;
    labelTexture: DynamicTexture;
}>;

type PickupAvatar = Readonly<{
    root: TransformNode;
    core: Mesh;
    ring: Mesh;
    label: Mesh;
    material: StandardMaterial;
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
    pickups: Map<string, PickupAvatar>;
    layoutPropRoot: TransformNode;
    motionBuffer: RallarMotionBuffer<PlayerPose>;
    motionSampleKeys: Map<string, string>;
    remoteShotIds: Set<string>;
    remoteHitIds: Set<string>;
    attackCueIds: Set<string>;
    sentPickupIds: Set<string>;
    appliedEventIds: Set<string>;
    arenaState: ArenaSimulationState;
    localPlayer: LocalPlayerState;
    input: MutableInputState;
    lastFrameEpochMs: number;
    lastSnapshotRevision: number;
    recoil: number;
    hitStopUntilEpochMs: number;
    transientEffects: TransientEffect[];
    createdEffectCount: number;
    pointerDownCount: number;
    acceptedHitCount: number;
    respawnCount: number;
    inputDevice: InputDeviceKind;
    touchState: TouchControlState;
    touchStick: VirtualStickResult;
    mobileSettings: MobileControlSettings;
    mobileControlsEnabled: boolean;
    audio: ProceduralArenaAudio;
    audioSettings: ArenaAudioSettings;
    touchAimAssistUntilMs: number;
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

type MutableButtonAction = Exclude<keyof MutableInputState, 'moveX' | 'moveZ'>;

type LocalPoseHistory = Readonly<{
    observedAtEpochMs: number;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
}>;

const BASE_FOV = 0.94;
const MAX_TRANSIENT_EFFECTS = 48;
const MOBILE_STICK_RADIUS = 72;
const EMPTY_TOUCH_STICK = calculateVirtualStick({ x: 0, y: 0 }, { x: 0, y: 0 }, MOBILE_STICK_RADIUS);

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
    localSessionId,
    localUsername,
    localColor,
    roomId,
    roomReady,
    networkEnabled,
    diagnosticsAttributes,
    remotePlayers,
    remoteShots,
    remotePlayerHits,
    remoteEvents,
    arenaSnapshot,
    onLocalPose,
    onLocalShot,
    onPlayerHitIntent,
    onPickupIntent,
    onLocalCombatChange,
    onLocalPlayerChange,
    onArenaSnapshot,
}: BabylonArenaProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<ArenaRuntime | undefined>(undefined);
    const remotePlayersRef = useRef(remotePlayers);
    const remoteShotsRef = useRef(remoteShots);
    const remotePlayerHitsRef = useRef(remotePlayerHits);
    const remoteEventsRef = useRef(remoteEvents);
    const snapshotRef = useRef(arenaSnapshot);
    const networkEnabledRef = useRef(networkEnabled);
    const callbacksRef = useRef({
        onLocalPose,
        onLocalShot,
        onPlayerHitIntent,
        onPickupIntent,
        onLocalCombatChange,
        onLocalPlayerChange,
        onArenaSnapshot,
    });
    const poseSeqRef = useRef(0);
    const shotSeqRef = useRef(0);
    const pickupSeqRef = useRef(0);
    const localPoseRef = useRef<LocalPoseHistory | undefined>(undefined);
    const gyroLastRef = useRef<Readonly<{ beta: number; gamma: number }> | undefined>(undefined);
    const [mobileSettings, setMobileSettings] = useState<MobileControlSettings>(() =>
        typeof window === 'undefined'
            ? createDefaultMobileControlSettings()
            : loadMobileControlSettings((key) => window.localStorage.getItem(key))
    );
    const [audioSettings, setAudioSettings] = useState<ArenaAudioSettings>(() =>
        typeof window === 'undefined'
            ? normalizeArenaAudioSettings({})
            : loadArenaAudioSettings((key) => window.localStorage.getItem(key))
    );
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [stickView, setStickView] = useState<Readonly<{
        active: boolean;
        knobX: number;
        knobY: number;
    }>>({
        active: false,
        knobX: 0,
        knobY: 0,
    });

    useEffect(() => {
        remotePlayersRef.current = remotePlayers;
    }, [remotePlayers]);

    useEffect(() => {
        remoteShotsRef.current = remoteShots;
    }, [remoteShots]);

    useEffect(() => {
        remotePlayerHitsRef.current = remotePlayerHits;
    }, [remotePlayerHits]);

    useEffect(() => {
        remoteEventsRef.current = remoteEvents;
    }, [remoteEvents]);

    useEffect(() => {
        snapshotRef.current = arenaSnapshot;
    }, [arenaSnapshot]);

    useEffect(() => {
        networkEnabledRef.current = networkEnabled;
    }, [networkEnabled]);

    useEffect(() => {
        callbacksRef.current = {
            onLocalPose,
            onLocalShot,
            onPlayerHitIntent,
            onPickupIntent,
            onLocalCombatChange,
            onLocalPlayerChange,
            onArenaSnapshot,
        };
    }, [
        onArenaSnapshot,
        onLocalCombatChange,
        onLocalPlayerChange,
        onLocalPose,
        onLocalShot,
        onPickupIntent,
        onPlayerHitIntent,
    ]);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (runtime) {
            runtime.mobileSettings = mobileSettings;
            runtime.inputDevice = mobileSettings.gyroEnabled && runtime.inputDevice === 'touch'
                ? 'gyro-touch'
                : runtime.inputDevice;
        }
    }, [mobileSettings]);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (runtime) {
            runtime.audioSettings = audioSettings;
            runtime.audio.updateSettings(audioSettings);
        }
    }, [audioSettings]);

    useEffect(() => {
        if (!mobileSettings.gyroEnabled) {
            gyroLastRef.current = undefined;
            return;
        }

        const onDeviceOrientation = (event: DeviceOrientationEvent) => {
            const runtime = runtimeRef.current;
            if (!runtime || typeof event.beta !== 'number' || typeof event.gamma !== 'number') {
                return;
            }
            const previous = gyroLastRef.current;
            gyroLastRef.current = { beta: event.beta, gamma: event.gamma };
            if (!previous) {
                return;
            }
            const delta = mapTouchLookDelta(
                (event.gamma - previous.gamma) * 2.1,
                (event.beta - previous.beta) * 1.45,
                runtime.mobileSettings,
            );
            applyLook(runtime, delta.yawDelta, delta.pitchDelta);
            runtime.inputDevice = 'gyro-touch';
        };

        window.addEventListener('deviceorientation', onDeviceOrientation);
        return () => window.removeEventListener('deviceorientation', onDeviceOrientation);
    }, [mobileSettings.gyroEnabled]);

    const updateMobileSettings = (patch: Partial<MobileControlSettings>) => {
        setMobileSettings((current) => {
            const next = normalizeMobileControlSettings({ ...current, ...patch });
            if (typeof window !== 'undefined') {
                saveMobileControlSettings(next, (key, value) => window.localStorage.setItem(key, value));
            }
            const runtime = runtimeRef.current;
            if (runtime) {
                runtime.mobileSettings = next;
            }
            return next;
        });
    };

    const updateAudioSettings = (patch: Partial<ArenaAudioSettings>) => {
        setAudioSettings((current) => {
            const next = normalizeArenaAudioSettings({ ...current, ...patch });
            if (typeof window !== 'undefined') {
                saveArenaAudioSettings(next, (key, value) => window.localStorage.setItem(key, value));
            }
            const runtime = runtimeRef.current;
            if (runtime) {
                runtime.audioSettings = next;
                runtime.audio.updateSettings(next);
            }
            return next;
        });
    };

    const enableGyro = async () => {
        const orientationEvent = globalThis.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
            requestPermission?: () => Promise<'granted' | 'denied' | 'prompt'>;
        };
        if (typeof orientationEvent?.requestPermission === 'function') {
            try {
                const permission = await orientationEvent.requestPermission();
                if (permission !== 'granted') {
                    updateMobileSettings({ gyroEnabled: false });
                    return;
                }
            } catch {
                updateMobileSettings({ gyroEnabled: false });
                return;
            }
        }
        updateMobileSettings({ gyroEnabled: true });
    };

    const updateMoveStick = (runtime: ArenaRuntime): void => {
        const origin = runtime.touchState.moveOrigin;
        const current = runtime.touchState.moveCurrent;
        if (!origin || !current) {
            runtime.touchStick = EMPTY_TOUCH_STICK;
            runtime.input.moveX = 0;
            runtime.input.moveZ = 0;
            runtime.input.sprint = false;
            setStickView({ active: false, knobX: 0, knobY: 0 });
            return;
        }
        const stick = calculateVirtualStick(origin, current, MOBILE_STICK_RADIUS);
        runtime.touchStick = stick;
        runtime.input.moveX = stick.moveX;
        runtime.input.moveZ = stick.moveZ;
        runtime.input.sprint = stick.sprint;
        runtime.inputDevice = runtime.mobileSettings.gyroEnabled ? 'gyro-touch' : 'touch';
        runtime.mobileControlsEnabled = true;
        setStickView({
            active: true,
            knobX: stick.knobX,
            knobY: stick.knobY,
        });
    };

    const pointFromPointer = (event: ReactPointerEvent): Point2 => ({
        x: event.clientX,
        y: event.clientY,
    });

    const onMovePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }
        unlockArenaAudio(runtime);
        safeSetPointerCapture(event.currentTarget, event.pointerId);
        runtime.touchState = updateTouchPointer(
            runtime.touchState,
            'move',
            event.pointerId,
            pointFromPointer(event),
        );
        updateMoveStick(runtime);
    };

    const onMovePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const runtime = runtimeRef.current;
        if (!runtime || runtime.touchState.movePointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        runtime.touchState = updateTouchPointer(
            runtime.touchState,
            'move',
            event.pointerId,
            pointFromPointer(event),
        );
        updateMoveStick(runtime);
    };

    const releasePointer = (event: ReactPointerEvent<HTMLElement>) => {
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }
        runtime.touchState = resetTouchPointer(runtime.touchState, event.pointerId);
        if (!runtime.touchState.movePointerId) {
            updateMoveStick(runtime);
        }
        if (!runtime.touchState.lookPointerId) {
            runtime.inputDevice = 'touch';
        }
        safeReleasePointerCapture(event.currentTarget, event.pointerId);
    };

    const onLookPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }
        unlockArenaAudio(runtime);
        safeSetPointerCapture(event.currentTarget, event.pointerId);
        runtime.touchState = updateTouchPointer(
            runtime.touchState,
            'look',
            event.pointerId,
            pointFromPointer(event),
        );
        runtime.inputDevice = runtime.mobileSettings.gyroEnabled ? 'gyro-touch' : 'touch';
        runtime.mobileControlsEnabled = true;
    };

    const onLookPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const runtime = runtimeRef.current;
        if (!runtime || runtime.touchState.lookPointerId !== event.pointerId) {
            return;
        }
        const previous = runtime.touchState.lookLast;
        const point = pointFromPointer(event);
        if (previous) {
            const delta = mapTouchLookDelta(
                point.x - previous.x,
                point.y - previous.y,
                runtime.mobileSettings,
            );
            applyLook(runtime, delta.yawDelta, delta.pitchDelta);
        }
        runtime.touchState = updateTouchPointer(runtime.touchState, 'look', event.pointerId, point);
        event.preventDefault();
    };

    const onActionDown = (
        event: ReactPointerEvent<HTMLButtonElement>,
        action: MutableButtonAction,
        mode: 'hold' | 'pulse',
    ) => {
        event.preventDefault();
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }
        unlockArenaAudio(runtime);
        if (mode === 'hold') {
            safeSetPointerCapture(event.currentTarget, event.pointerId);
        }
        runtime.inputDevice = runtime.mobileSettings.gyroEnabled ? 'gyro-touch' : 'touch';
        runtime.mobileControlsEnabled = true;
        triggerHaptic(runtime, 8);
        if (mode === 'pulse') {
            pulseAction(runtime, action);
            return;
        }
        setAction(runtime, action, true);
    };

    const onActionUp = (
        event: ReactPointerEvent<HTMLButtonElement>,
        action: MutableButtonAction,
        mode: 'hold' | 'pulse',
    ) => {
        const runtime = runtimeRef.current;
        if (runtime && mode === 'hold') {
            setAction(runtime, action, false);
        }
        safeReleasePointerCapture(event.currentTarget, event.pointerId);
    };

    const onScanDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        onActionDown(event, 'altFire', 'hold');
        const runtime = runtimeRef.current;
        if (runtime) {
            createScanPulse(runtime, runtime.localPlayer.position, localColor);
        }
    };

    const mobileControlStyle = {
        '--mobile-button-scale': mobileSettings.buttonScale,
    } as CSSProperties;

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
        camera.maxZ = 190;
        camera.fov = BASE_FOV;

        const glow = new GlowLayer('arena-glow', scene);
        glow.intensity = 0.92;

        const now = Date.now();
        const initialArenaState = snapshotRef.current
            ? hydrateArenaSnapshot(snapshotRef.current)
            : createInitialArenaState(undefined, now);
        buildArena(scene, initialArenaState.layout);
        const layoutPropRoot = new TransformNode('arena-layout-props', scene);
        const runtime: ArenaRuntime = {
            engine,
            scene,
            camera,
            glow,
            avatars: new Map(),
            targets: new Map(),
            pickups: new Map(),
            layoutPropRoot,
            motionBuffer: createRallarMotionBuffer<PlayerPose>({
                interpolationDelayMs: 75,
                maxExtrapolationMs: 130,
            }),
            motionSampleKeys: new Map(),
            remoteShotIds: new Set(),
            remoteHitIds: new Set(),
            attackCueIds: new Set(),
            sentPickupIds: new Set(),
            appliedEventIds: new Set(),
            arenaState: initialArenaState,
            localPlayer: createInitialPlayerState(now),
            input: { ...EMPTY_INPUT },
            lastFrameEpochMs: now,
            lastSnapshotRevision: 0,
            recoil: 0,
            hitStopUntilEpochMs: 0,
            transientEffects: [],
            createdEffectCount: 0,
            pointerDownCount: 0,
            acceptedHitCount: 0,
            respawnCount: 0,
            inputDevice: 'keyboard-mouse',
            touchState: createInitialTouchControlState(),
            touchStick: EMPTY_TOUCH_STICK,
            mobileSettings,
            mobileControlsEnabled: false,
            audio: new ProceduralArenaAudio(audioSettings),
            audioSettings,
            touchAimAssistUntilMs: 0,
        };
        runtimeRef.current = runtime;
        syncLocalPlayerFromSnapshot(runtime, localSessionId, toArenaSnapshot(initialArenaState, roomId, now));
        buildLayoutProps(scene, layoutPropRoot, initialArenaState.layout);
        syncTargetAvatars(runtime, now);

        const resize = () => engine.resize();
        window.addEventListener('resize', resize);

        const onKeyDown = (event: KeyboardEvent) => {
            runtime.inputDevice = 'keyboard-mouse';
            setInputKey(runtime.input, event.code, true);
        };
        const onKeyUp = (event: KeyboardEvent) => {
            setInputKey(runtime.input, event.code, false);
        };
        const onPointerMove = (event: PointerEvent) => {
            if (document.pointerLockElement !== canvas) {
                return;
            }
            runtime.inputDevice = 'keyboard-mouse';
            applyLook(runtime, event.movementX * 0.0024, event.movementY * 0.002);
        };
        const requestPointerLock = () => {
            try {
                const lockRequest = canvas.requestPointerLock?.();
                if (lockRequest instanceof Promise) {
                    void lockRequest.catch(() => undefined);
                }
            } catch {
                // Pointer lock can be blocked in headless smoke runs or embedded previews.
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            runtime.pointerDownCount += 1;
            unlockArenaAudio(runtime);
            if (event.pointerType === 'touch' && event.button === 0) {
                event.preventDefault();
                const aim = resolveTouchShotDirection(
                    runtime,
                    event,
                    remotePlayersRef.current,
                    localSessionId ?? 'local',
                );
                fireLocalShot({
                    runtime,
                    localSessionId,
                    localUsername,
                    localColor,
                    roomId,
                    networkEnabled: networkEnabledRef.current,
                    remotePlayers: remotePlayersRef.current,
                    shotSeqRef,
                    callbacksRef,
                    directionOverride: aim.direction,
                    touchAssisted: aim.assisted,
                });
                return;
            }
            if (event.button === 0) {
                fireLocalShot({
                    runtime,
                    localSessionId,
                    localUsername,
                    localColor,
                    roomId,
                    networkEnabled: networkEnabledRef.current,
                    remotePlayers: remotePlayersRef.current,
                    shotSeqRef,
                    callbacksRef,
                });
                requestPointerLock();
                return;
            }
            if (event.button === 2) {
                runtime.input.altFire = true;
                createScanPulse(runtime, runtime.localPlayer.position, localColor);
                requestPointerLock();
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
        const pointerOptions = { capture: true } as const;

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerdown', onPointerDown, pointerOptions);
        canvas.addEventListener('pointerup', onPointerUp, pointerOptions);
        canvas.addEventListener('contextmenu', onContextMenu, pointerOptions);

        scene.onBeforeRenderObservable.add(() => {
            runFrame({
                runtime,
                roomId,
                networkEnabled: networkEnabledRef.current,
                remotePlayers: remotePlayersRef.current,
                remoteShots: remoteShotsRef.current,
                remotePlayerHits: remotePlayerHitsRef.current,
                remoteEvents: remoteEventsRef.current,
                arenaSnapshot: snapshotRef.current,
                localSessionId,
                localUsername,
                localColor,
                poseSeqRef,
                shotSeqRef,
                pickupSeqRef,
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
            canvas.removeEventListener('pointerdown', onPointerDown, pointerOptions);
            canvas.removeEventListener('pointerup', onPointerUp, pointerOptions);
            canvas.removeEventListener('contextmenu', onContextMenu, pointerOptions);
            runtime.audio.dispose();
            scene.dispose();
            engine.dispose();
            delete canvas.dataset.arenaRuntimeReady;
            delete canvas.dataset.arenaVisualTheme;
            delete canvas.dataset.arenaMeshCount;
            delete canvas.dataset.arenaEffectCount;
            delete canvas.dataset.arenaActiveEffectCount;
            delete canvas.dataset.arenaSize;
            delete canvas.dataset.arenaLayoutId;
            delete canvas.dataset.arenaPickupCount;
            delete canvas.dataset.arenaWeaponKind;
            delete canvas.dataset.arenaLocalHealth;
            delete canvas.dataset.arenaAcceptedHitCount;
            delete canvas.dataset.arenaRespawnCount;
            delete canvas.dataset.arenaActiveChaosId;
            delete canvas.dataset.arenaWave;
            delete canvas.dataset.arenaWavePhase;
            delete canvas.dataset.arenaAttackCount;
            delete canvas.dataset.arenaHostileEyeCount;
            delete canvas.dataset.arenaInputMode;
            delete canvas.dataset.arenaMobileControls;
            delete canvas.dataset.arenaTouchMoveActive;
            delete canvas.dataset.arenaTouchLookActive;
            delete canvas.dataset.arenaGyroEnabled;
            delete canvas.dataset.arenaAudioUnlocked;
            delete canvas.dataset.arenaAudioState;
            delete canvas.dataset.arenaAudioMuted;
            delete canvas.dataset.arenaAudioVoices;
            runtimeRef.current = undefined;
        };
    }, [localColor, localSessionId, localUsername, roomId]);

    return (
        <div className="arena-shell" data-room-ready={roomReady ? 'true' : 'false'}>
            <canvas
                ref={canvasRef}
                className="arena-canvas"
                aria-label="AR Eye Hunter gameplay canvas"
                {...diagnosticsAttributes}
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
            <div
                className="mobile-fps-controls"
                style={mobileControlStyle}
                aria-label="Mobile FPS controls"
            >
                <div
                    className="mobile-stick-zone"
                    data-active={stickView.active ? 'true' : 'false'}
                    aria-label="Move and sprint"
                    onPointerDown={onMovePointerDown}
                    onPointerMove={onMovePointerMove}
                    onPointerUp={releasePointer}
                    onPointerCancel={releasePointer}
                    onLostPointerCapture={releasePointer}
                >
                    <span className="mobile-stick-ring">
                        <span
                            className="mobile-stick-knob"
                            style={{
                                transform: `translate(${stickView.knobX}px, ${stickView.knobY}px)`,
                            }}
                        />
                    </span>
                    <span className="mobile-stick-label">MOVE / SPRINT</span>
                </div>

                <div
                    className="mobile-look-zone"
                    aria-label="Look and aim"
                    onPointerDown={onLookPointerDown}
                    onPointerMove={onLookPointerMove}
                    onPointerUp={releasePointer}
                    onPointerCancel={releasePointer}
                    onLostPointerCapture={releasePointer}
                >
                    <span>LOOK</span>
                </div>

                <div className="mobile-action-cluster" aria-label="Combat actions">
                    <button
                        type="button"
                        className="mobile-action mobile-action--fire"
                        onPointerDown={(event) => onActionDown(event, 'fire', 'hold')}
                        onPointerUp={(event) => onActionUp(event, 'fire', 'hold')}
                        onPointerCancel={(event) => onActionUp(event, 'fire', 'hold')}
                        onLostPointerCapture={(event) => onActionUp(event, 'fire', 'hold')}
                    >
                        Fire
                    </button>
                    <button
                        type="button"
                        className="mobile-action"
                        onPointerDown={onScanDown}
                        onPointerUp={(event) => onActionUp(event, 'altFire', 'hold')}
                        onPointerCancel={(event) => onActionUp(event, 'altFire', 'hold')}
                        onLostPointerCapture={(event) => onActionUp(event, 'altFire', 'hold')}
                    >
                        Scan
                    </button>
                    <button
                        type="button"
                        className="mobile-action"
                        onPointerDown={(event) => onActionDown(event, 'dash', 'pulse')}
                    >
                        Dash
                    </button>
                    <button
                        type="button"
                        className="mobile-action"
                        onPointerDown={(event) => onActionDown(event, 'jump', 'pulse')}
                    >
                        Jump
                    </button>
                    <button
                        type="button"
                        className="mobile-action"
                        onPointerDown={(event) => onActionDown(event, 'slide', 'pulse')}
                    >
                        Slide
                    </button>
                    <button
                        type="button"
                        className="mobile-action"
                        onPointerDown={(event) => onActionDown(event, 'overdrive', 'hold')}
                        onPointerUp={(event) => onActionUp(event, 'overdrive', 'hold')}
                        onPointerCancel={(event) => onActionUp(event, 'overdrive', 'hold')}
                        onLostPointerCapture={(event) => onActionUp(event, 'overdrive', 'hold')}
                    >
                        OD
                    </button>
                    <button
                        type="button"
                        className="mobile-action mobile-action--settings"
                        aria-expanded={mobileMenuOpen}
                        onClick={() => setMobileMenuOpen((open) => !open)}
                    >
                        Tune
                    </button>
                </div>

                {mobileMenuOpen && (
                    <div className="mobile-settings-panel">
                        <div>
                            <strong>Mobile Controls</strong>
                            <span>Landscape dual-stick audit mode</span>
                        </div>
                        <label>
                            Sensitivity
                            <input
                                type="range"
                                min="0.35"
                                max="2.4"
                                step="0.05"
                                value={mobileSettings.touchSensitivity}
                                onChange={(event) => updateMobileSettings({
                                    touchSensitivity: Number(event.currentTarget.value),
                                })}
                            />
                        </label>
                        <label>
                            Button scale
                            <input
                                type="range"
                                min="0.72"
                                max="1.35"
                                step="0.03"
                                value={mobileSettings.buttonScale}
                                onChange={(event) => updateMobileSettings({
                                    buttonScale: Number(event.currentTarget.value),
                                })}
                            />
                        </label>
                        <label className="mobile-setting-check">
                            <input
                                type="checkbox"
                                checked={mobileSettings.invertY}
                                onChange={(event) => updateMobileSettings({
                                    invertY: event.currentTarget.checked,
                                })}
                            />
                            Invert look Y
                        </label>
                        <label className="mobile-setting-check">
                            <input
                                type="checkbox"
                                checked={mobileSettings.hapticsEnabled}
                                onChange={(event) => updateMobileSettings({
                                    hapticsEnabled: event.currentTarget.checked,
                                })}
                            />
                            Haptics
                        </label>
                        <button
                            type="button"
                            className={mobileSettings.gyroEnabled ? 'mobile-gyro active' : 'mobile-gyro'}
                            onClick={() => {
                                if (mobileSettings.gyroEnabled) {
                                    updateMobileSettings({ gyroEnabled: false });
                                    return;
                                }
                                void enableGyro();
                            }}
                        >
                            {mobileSettings.gyroEnabled ? 'Gyro fine-aim on' : 'Enable gyro fine-aim'}
                        </button>
                        <label>
                            Score
                            <input
                                type="range"
                                min="0"
                                max="0.24"
                                step="0.01"
                                value={audioSettings.musicVolume}
                                onChange={(event) => updateAudioSettings({
                                    musicVolume: Number(event.currentTarget.value),
                                })}
                            />
                        </label>
                        <label>
                            SFX
                            <input
                                type="range"
                                min="0"
                                max="0.6"
                                step="0.02"
                                value={audioSettings.sfxVolume}
                                onChange={(event) => updateAudioSettings({
                                    sfxVolume: Number(event.currentTarget.value),
                                })}
                            />
                        </label>
                        <label className="mobile-setting-check">
                            <input
                                type="checkbox"
                                checked={audioSettings.reducedIntensity}
                                onChange={(event) => updateAudioSettings({
                                    reducedIntensity: event.currentTarget.checked,
                                })}
                            />
                            Reduced audio intensity
                        </label>
                    </div>
                )}
            </div>
            <div className="arena-audio-controls" aria-label="Arena audio">
                <button
                    type="button"
                    onClick={() => {
                        const runtime = runtimeRef.current;
                        if (runtime) {
                            unlockArenaAudio(runtime);
                            if (!runtime.audio.isUnlocked() && !audioSettings.muted) {
                                return;
                            }
                        }
                        updateAudioSettings({ muted: !audioSettings.muted });
                    }}
                >
                    {audioSettings.muted ? 'Audio Off' : 'Audio On'}
                </button>
            </div>
            <div className="mobile-rotate-prompt" role="status">
                <strong>Rotate for combat</strong>
                <span>Landscape gives your thumbs room to misbehave.</span>
            </div>
        </div>
    );
}

function runFrame({
    runtime,
    roomId,
    networkEnabled,
    remotePlayers,
    remoteShots,
    remotePlayerHits,
    remoteEvents,
    arenaSnapshot,
    localSessionId,
    localUsername,
    localColor,
    poseSeqRef,
    shotSeqRef,
    pickupSeqRef,
    localPoseRef,
    callbacksRef,
}: Readonly<{
    runtime: ArenaRuntime;
    roomId?: string;
    networkEnabled: boolean;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    remotePlayerHits: readonly PlayerHitAccepted[];
    remoteEvents: readonly ArenaEvent[];
    arenaSnapshot?: ArenaSnapshot;
    localSessionId?: string;
    localUsername: string;
    localColor: string;
    poseSeqRef: React.MutableRefObject<number>;
    shotSeqRef: React.MutableRefObject<number>;
    pickupSeqRef: React.MutableRefObject<number>;
    localPoseRef: React.MutableRefObject<LocalPoseHistory | undefined>;
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onPlayerHitIntent: BabylonArenaProps['onPlayerHitIntent'];
        onPickupIntent: BabylonArenaProps['onPickupIntent'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onLocalPlayerChange: BabylonArenaProps['onLocalPlayerChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>;
    directionOverride?: Vec3Tuple;
    touchAssisted?: boolean;
}>): void {
    const now = Date.now();
    const rawDtMs = now - runtime.lastFrameEpochMs;
    const dtMs = runtime.hitStopUntilEpochMs > now ? Math.min(rawDtMs, 8) : rawDtMs;
    runtime.lastFrameEpochMs = now;

    if (arenaSnapshot && arenaSnapshot.revision > runtime.arenaState.revision) {
        runtime.arenaState = hydrateArenaSnapshot(arenaSnapshot);
        syncLocalPlayerFromSnapshot(runtime, localSessionId, arenaSnapshot);
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
        runtime.arenaState.layout.halfSize,
    );
    const localPlayerId = localSessionId ?? 'local';
    runtime.arenaState = upsertPlayerPose(
        runtime.arenaState,
        {
            sessionId: localPlayerId,
            username: localUsername,
            color: localColor,
            score: runtime.localPlayer.combat.score,
            position: runtime.localPlayer.position,
            rotation: [runtime.localPlayer.pitch, runtime.localPlayer.yaw, 0],
            vitals: runtime.localPlayer.vitals,
            loadout: runtime.localPlayer.loadout,
            seq: poseSeqRef.current,
            sentAtEpochMs: now,
        },
        now,
    );
    runtime.arenaState = stepArenaDirectorState(runtime.arenaState, now);
    syncLocalPlayerFromArenaState(runtime, localPlayerId);
    runtime.arenaState = animateTargets(runtime.arenaState, dtMs, now);
    syncPickupAvatars(runtime, now);
    syncTargetAvatars(runtime, now);
    syncEyeAttackCues(runtime, now);
    runtime.audio.play({
        kind: 'eye-drone',
        threatCount: runtime.arenaState.targets.filter(isHostileEye).length,
        distanceFactor: runtime.audioSettings.reducedIntensity ? 0.55 : 1,
    });
    syncRemoteAvatars(runtime, remotePlayers);
    syncRemoteShots(runtime, remoteShots);
    syncRemotePlayerHits(runtime, remotePlayerHits, localPlayerId);
    if (networkEnabled) {
        maybeFireHeldShot({
            runtime,
            localSessionId,
            localUsername,
            localColor,
            roomId,
            networkEnabled,
            remotePlayers,
            shotSeqRef,
            callbacksRef,
            nowEpochMs: now,
        });
        detectLocalPickup(runtime, localPlayerId, pickupSeqRef, callbacksRef);
    }
    syncCamera(runtime, now);
    updateTransientEffects(runtime);
    if (networkEnabled) {
        publishLocalPose(runtime.localPlayer, poseSeqRef, callbacksRef, localPoseRef);
    }
    callbacksRef.current.onLocalPlayerChange({
        vitals: runtime.localPlayer.vitals,
        loadout: runtime.localPlayer.loadout,
    });

    if (networkEnabled && runtime.lastSnapshotRevision !== runtime.arenaState.revision) {
        runtime.lastSnapshotRevision = runtime.arenaState.revision;
        callbacksRef.current.onArenaSnapshot(
            toArenaSnapshot(runtime.arenaState, roomId, now),
        );
    }
}

function buildArena(scene: Scene, layout: ArenaLayoutSpec): void {
    const arenaSize = layout.halfSize * 2;
    const halfSize = layout.halfSize;
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
        width: arenaSize,
        height: arenaSize,
        subdivisions: 24,
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
        { name: 'north-wall', position: [0, 2.6, halfSize], scaling: [arenaSize, 5.2, 0.7] },
        { name: 'south-wall', position: [0, 2.6, -halfSize], scaling: [arenaSize, 5.2, 0.7] },
        { name: 'east-wall', position: [halfSize, 2.6, 0], scaling: [0.7, 5.2, arenaSize] },
        { name: 'west-wall', position: [-halfSize, 2.6, 0], scaling: [0.7, 5.2, arenaSize] },
    ] as const;

    for (const spec of walls) {
        const wall = MeshBuilder.CreateBox(spec.name, { size: 1 }, scene);
        wall.position.set(spec.position[0], spec.position[1], spec.position[2]);
        wall.scaling.set(spec.scaling[0], spec.scaling[1], spec.scaling[2]);
        wall.material = wallMaterial;
    }

    const lanePositions = [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42].map((value) =>
        Math.round(value * arenaSize * 100) / 100
    );
    for (const [index, x] of lanePositions.entries()) {
        const lane = MeshBuilder.CreateBox(`matrix-longitude-${index}`, {
            width: index % 3 === 0 ? 0.09 : 0.045,
            height: 0.035,
            depth: arenaSize * 0.88,
        }, scene);
        lane.position.set(x, 0.055, 0);
        lane.material = index % 3 === 0 ? warningMaterial : laneMaterial;
    }

    for (const [index, z] of lanePositions.entries()) {
        const lane = MeshBuilder.CreateBox(`matrix-latitude-${index}`, {
            width: arenaSize * 0.88,
            height: 0.035,
            depth: index % 3 === 0 ? 0.09 : 0.045,
        }, scene);
        lane.position.set(0, 0.06, z);
        lane.material = index % 3 === 0 ? warningMaterial : laneMaterial;
    }

    for (const [index, x] of [-0.32, -0.12, 0.16, 0.34].map((value) => value * arenaSize).entries()) {
        for (const z of [-0.34, -0.08, 0.22].map((value) => value * arenaSize)) {
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

    createCodeRainPanel(scene, 'matrix-rain-north-a', [ -halfSize * 0.32, 2.85, halfSize - 0.42 ], Math.PI, 11.8, 4.2, 1);
    createCodeRainPanel(scene, 'matrix-rain-north-b', [ halfSize * 0.32, 2.85, halfSize - 0.42 ], Math.PI, 11.8, 4.2, 2);
    createCodeRainPanel(scene, 'matrix-rain-south-a', [ -halfSize * 0.32, 2.85, -halfSize + 0.42 ], 0, 11.8, 4.2, 3);
    createCodeRainPanel(scene, 'matrix-rain-south-b', [ halfSize * 0.32, 2.85, -halfSize + 0.42 ], 0, 11.8, 4.2, 4);
    createCodeRainPanel(scene, 'matrix-rain-east', [ halfSize - 0.42, 2.85, 0 ], -Math.PI / 2, 15.5, 4.4, 5);
    createCodeRainPanel(scene, 'matrix-rain-west', [ -halfSize + 0.42, 2.85, 0 ], Math.PI / 2, 15.5, 4.4, 6);

    for (const [index, sign] of MATRIX_SIGNS.entries()) {
        const side = index % 2 === 0 ? 1 : -1;
        const x = index < 3 ? -halfSize * 0.4 + index * halfSize * 0.4 : side * (halfSize - 1.1);
        const z = index < 3 ? side * (halfSize - 1.05) : -halfSize * 0.25 + index * halfSize * 0.1;
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

    createPortalRings(scene, 'matrix-portal-nw', [-halfSize * 0.72, 2.8, halfSize * 0.66], MATRIX_THEME.cyan);
    createPortalRings(scene, 'matrix-portal-se', [halfSize * 0.7, 2.8, -halfSize * 0.64], MATRIX_THEME.magenta);
    createPortalRings(scene, 'matrix-portal-ne', [halfSize * 0.66, 2.2, halfSize * 0.64], MATRIX_THEME.amber);

    const hemi = new HemisphericLight('arena-hemi', new Vector3(0.1, 1, -0.2), scene);
    hemi.intensity = 1.16;
    hemi.groundColor = Color3.FromHexString(MATRIX_THEME.acid).scale(0.18);

    const magenta = new PointLight('magenta-hotspot', new Vector3(-halfSize * 0.4, 5.6, -halfSize * 0.34), scene);
    magenta.diffuse = Color3.FromHexString(MATRIX_THEME.magenta);
    magenta.intensity = 0.82;
    magenta.range = halfSize * 0.72;

    const cyan = new PointLight('cyan-hotspot', new Vector3(halfSize * 0.4, 4, halfSize * 0.3), scene);
    cyan.diffuse = Color3.FromHexString(MATRIX_THEME.cyan);
    cyan.intensity = 0.94;
    cyan.range = halfSize * 0.7;

    const acid = new PointLight('acid-hotspot', new Vector3(0, 7.2, 0), scene);
    acid.diffuse = Color3.FromHexString(MATRIX_THEME.acid);
    acid.intensity = 0.72;
    acid.range = halfSize * 0.9;
}

function buildLayoutProps(
    scene: Scene,
    root: TransformNode,
    layout: ArenaLayoutSpec,
): void {
    for (const prop of layout.props) {
        createLayoutProp(scene, root, prop);
    }

    for (const sign of layout.signs) {
        createHologramSign(
            scene,
            `layout-sign-${sign.id}`,
            sign.title,
            sign.detail,
            sign.position,
            sign.rotationY,
            MATRIX_THEME.acid,
        );
    }
}

function createLayoutProp(
    scene: Scene,
    root: TransformNode,
    prop: ArenaLayoutProp,
): void {
    const color = prop.kind === 'hazard'
        ? MATRIX_THEME.danger
        : prop.kind === 'portal'
        ? MATRIX_THEME.magenta
        : prop.kind === 'bounce-pad'
        ? MATRIX_THEME.amber
        : MATRIX_THEME.cyan;
    const material = createMatrixMaterial(
        scene,
        `layout-prop-${prop.id}-mat`,
        prop.blocksShots ? MATRIX_THEME.glass : MATRIX_THEME.graphite,
        color,
        prop.kind === 'cover' ? 0.22 : 0.74,
        prop.kind === 'cover' ? 0.92 : 0.76,
    );

    const mesh = MeshBuilder.CreateBox(`layout-prop-${prop.id}`, {
        width: prop.size[0],
        height: prop.size[1],
        depth: prop.size[2],
    }, scene);
    mesh.parent = root;
    mesh.position = vector3(prop.position);
    mesh.rotation.y = prop.rotationY ?? 0;
    mesh.material = material;

    if (prop.kind === 'portal') {
        createPortalRings(scene, `layout-portal-${prop.id}`, prop.position, color);
    }

    if (prop.label) {
        createHologramSign(
            scene,
            `layout-prop-sign-${prop.id}`,
            prop.label,
            'facilities says this is intentional',
            [prop.position[0], prop.position[1] + prop.size[1] * 0.72 + 0.9, prop.position[2]],
            prop.rotationY ?? 0,
            color,
        );
    }
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

function maybeFireHeldShot({
    runtime,
    localSessionId,
    localUsername,
    localColor,
    roomId,
    networkEnabled,
    remotePlayers,
    shotSeqRef,
    callbacksRef,
    nowEpochMs,
}: Readonly<{
    runtime: ArenaRuntime;
    localSessionId?: string;
    localUsername: string;
    localColor: string;
    roomId?: string;
    networkEnabled: boolean;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    shotSeqRef: React.MutableRefObject<number>;
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onPlayerHitIntent: BabylonArenaProps['onPlayerHitIntent'];
        onPickupIntent: BabylonArenaProps['onPickupIntent'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onLocalPlayerChange: BabylonArenaProps['onLocalPlayerChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>;
    nowEpochMs: number;
}>): void {
    if (!shouldFireHeldWeapon(
        runtime.input.fire,
        nowEpochMs,
        runtime.localPlayer.combat.shotReadyAtEpochMs,
    )) {
        return;
    }

    fireLocalShot({
        runtime,
        localSessionId,
        localUsername,
        localColor,
        roomId,
        networkEnabled: true,
        remotePlayers,
        shotSeqRef,
        callbacksRef,
    });
}

function fireLocalShot({
    runtime,
    localSessionId,
    localUsername,
    localColor,
    roomId,
    networkEnabled,
    remotePlayers,
    shotSeqRef,
    callbacksRef,
    directionOverride,
    touchAssisted,
}: Readonly<{
    runtime: ArenaRuntime;
    localSessionId?: string;
    localUsername: string;
    localColor: string;
    roomId?: string;
    networkEnabled: boolean;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    shotSeqRef: React.MutableRefObject<number>;
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onPlayerHitIntent: BabylonArenaProps['onPlayerHitIntent'];
        onPickupIntent: BabylonArenaProps['onPickupIntent'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onLocalPlayerChange: BabylonArenaProps['onLocalPlayerChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>;
    directionOverride?: Vec3Tuple;
    touchAssisted?: boolean;
}>): void {
    const now = Date.now();
    const sessionId = localSessionId ?? 'local';
    const origin = runtime.localPlayer.position;
    const direction = directionOverride ?? forwardFromAngles(runtime.localPlayer.yaw, runtime.localPlayer.pitch);
    const weapon = getWeaponStats(runtime.localPlayer.loadout.weaponKind);
    shotSeqRef.current += 1;
    const shot: ShotIntent = {
        sessionId,
        username: localUsername,
        color: localColor,
        origin,
        direction,
        weaponKind: weapon.kind,
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
    triggerHaptic(runtime, resolution.accepted.hit ? 24 : 9);
    runtime.audio.play({ kind: 'shot', weaponKind: weapon.kind });
    if (resolution.accepted.hit) {
        runtime.audio.play({ kind: 'hit' });
    }

    createTracer(runtime, vector3(origin), vector3(direction), localColor, resolution.accepted.hit);
    const playerHit = findPredictedPlayerHit(remotePlayers, sessionId, origin, direction, weapon.range);
    if (playerHit) {
        if (networkEnabled) {
            callbacksRef.current.onPlayerHitIntent({
                shot,
                targetSessionId: playerHit.targetSessionId,
                targetSeq: playerHit.targetSeq,
                predictedImpact: playerHit.impact,
                sentAtEpochMs: now,
            });
        }
        createImpact(runtime, vector3(playerHit.impact), MATRIX_THEME.cyan, 1);
    }
    if (touchAssisted) {
        runtime.touchAimAssistUntilMs = performance.now() + 360;
    }
    if (resolution.accepted.hit) {
        createImpact(runtime, vector3(resolution.accepted.impact), MATRIX_THEME.amber, resolution.accepted.combo);
    }

    callbacksRef.current.onLocalCombatChange(resolution.combat);
    if (!networkEnabled) {
        return;
    }
    callbacksRef.current.onLocalShot(
        {
            origin,
            direction,
            charged: shot.charged,
            overdrive: shot.overdrive,
            seq: shot.seq,
            sentAtEpochMs: shot.sentAtEpochMs,
            weaponKind: shot.weaponKind,
        },
        {
            ...resolution.accepted,
            shot: {
                ...resolution.accepted.shot,
                sessionId,
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
        onPlayerHitIntent: BabylonArenaProps['onPlayerHitIntent'];
        onPickupIntent: BabylonArenaProps['onPickupIntent'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onLocalPlayerChange: BabylonArenaProps['onLocalPlayerChange'];
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
        vitals: player.vitals,
        loadout: player.loadout,
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

function applyLook(runtime: ArenaRuntime, yawDelta: number, pitchDelta: number): void {
    runtime.localPlayer = {
        ...runtime.localPlayer,
        yaw: runtime.localPlayer.yaw + yawDelta,
        pitch: clamp(
            runtime.localPlayer.pitch + pitchDelta,
            -1.22,
            1.1,
        ),
    };
}

function syncTargetAvatars(runtime: ArenaRuntime, nowEpochMs: number): void {
    const targetIds = new Set(runtime.arenaState.targets.map((target) => target.id));
    for (const target of runtime.arenaState.targets) {
        const avatar = getOrCreateTargetAvatar(runtime.scene, runtime.targets, target);
        const hostile = isHostileEye(target);
        const dangerPulse = hostile ? 1 + Math.sin(nowEpochMs / 92 + target.phase) * 0.12 : 1;
        avatar.root.position = vector3(target.position);
        avatar.root.position.y += Math.sin(nowEpochMs / 440 + target.phase) * 0.26;
        avatar.root.rotation.y += (hostile ? 0.026 : 0.014) + target.velocity[0] * 0.002;
        const healthScale = 0.55 + target.health / Math.max(1, target.maxHealth) * 0.45;
        avatar.iris.scaling.set(healthScale * dangerPulse, healthScale, healthScale);
        avatar.ring.scaling.set(
            (hostile ? 1.28 : 1.08) + Math.sin(nowEpochMs / 180 + target.phase) * 0.08,
            (hostile ? 0.86 : 1.08) + Math.cos(nowEpochMs / 220 + target.phase) * 0.08,
            1.08,
        );
        avatar.halo.scaling.set(
            (hostile ? 1.7 : 1.28) + Math.sin(nowEpochMs / 160 + target.phase) * 0.12,
            (hostile ? 0.92 : 1.28) + Math.cos(nowEpochMs / 210 + target.phase) * 0.12,
            1.28,
        );
        avatar.halo.rotation.z -= hostile ? 0.046 : 0.018;
        avatar.shardA.rotation.y += hostile ? 0.065 : 0.035;
        avatar.shardB.rotation.x -= hostile ? 0.052 : 0.028;
        avatar.shardA.scaling.y = hostile ? 1.45 + Math.sin(nowEpochMs / 105) * 0.08 : 1;
        avatar.shardB.scaling.y = hostile ? 1.35 + Math.cos(nowEpochMs / 120) * 0.08 : 1;
        avatar.coreMaterial.emissiveColor = Color3.FromHexString(
            hostile ? MATRIX_THEME.danger : target.color,
        ).scale(hostile ? 1.05 : 0.64);
        avatar.pupilMaterial.emissiveColor = Color3.FromHexString(
            hostile ? MATRIX_THEME.magenta : MATRIX_THEME.cyan,
        ).scale(hostile ? 0.82 : 0.26);
        avatar.ringMaterial.emissiveColor = target.rarity === 'bounty'
            ? Color3.FromHexString(MATRIX_THEME.amber).scale(1.05)
            : hostile
            ? Color3.FromHexString(MATRIX_THEME.magenta).scale(1.18)
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

function syncEyeAttackCues(runtime: ArenaRuntime, nowEpochMs: number): void {
    const activeCueIds = new Set(runtime.arenaState.attacks.map((cue) => cue.id));
    for (const cue of runtime.arenaState.attacks) {
        if (runtime.attackCueIds.has(cue.id)) {
            continue;
        }
        runtime.attackCueIds.add(cue.id);
        createEyeBeamWindup(runtime, cue, nowEpochMs);
    }

    for (const cueId of [...runtime.attackCueIds]) {
        if (!activeCueIds.has(cueId)) {
            runtime.attackCueIds.delete(cueId);
        }
    }
}

function createEyeBeamWindup(
    runtime: ArenaRuntime,
    cue: EyeAttackCue,
    nowEpochMs: number,
): void {
    const scene = runtime.scene;
    const origin = vector3(cue.origin);
    const aimPoint = vector3(cue.aimPoint);
    const midpoint = Vector3.Center(origin, aimPoint);
    const length = Vector3.Distance(origin, aimPoint);
    const duration = Math.max(360, cue.expiresAtEpochMs - nowEpochMs + 220);
    const windupMs = Math.max(160, cue.firesAtEpochMs - nowEpochMs);
    const material = createMatrixMaterial(
        scene,
        `eye-attack-beam-mat-${cue.id}`,
        MATRIX_THEME.danger,
        MATRIX_THEME.magenta,
        1,
        0.52,
    );

    const beam = MeshBuilder.CreateBox(`eye-attack-beam-${cue.id}`, {
        width: Math.max(0.12, cue.coneRadians * 0.55),
        height: 0.12,
        depth: length,
    }, scene);
    beam.position = midpoint;
    beam.lookAt(aimPoint);
    beam.material = material;

    const reticle = MeshBuilder.CreateTorus(`eye-attack-reticle-${cue.id}`, {
        diameter: 1.65,
        thickness: 0.045,
        tessellation: 52,
    }, scene);
    reticle.position = aimPoint.clone();
    reticle.position.y = Math.max(0.12, reticle.position.y - 0.75);
    reticle.rotation.x = Math.PI / 2;
    reticle.material = material;

    const warning = MeshBuilder.CreateTorus(`eye-attack-warning-${cue.id}`, {
        diameter: 0.76,
        thickness: 0.035,
        tessellation: 28,
    }, scene);
    warning.position = aimPoint.clone();
    warning.position.y += 0.72;
    warning.billboardMode = Mesh.BILLBOARDMODE_ALL;
    warning.material = material;

    const labelTexture = new DynamicTexture(`eye-attack-label-texture-${cue.id}`, {
        width: 512,
        height: 128,
    }, scene);
    labelTexture.hasAlpha = true;
    drawMatrixPanel(labelTexture, 'LASER AUDIT', 'please remain billable', MATRIX_THEME.danger);
    const labelMaterial = new StandardMaterial(`eye-attack-label-mat-${cue.id}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`eye-attack-label-${cue.id}`, {
        width: 2.75,
        height: 0.7,
    }, scene);
    label.position = aimPoint.clone();
    label.position.y += 1.45;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    addTransientEffect(runtime, {
        startedAtMs: performance.now(),
        durationMs: duration,
        meshes: [beam, reticle, warning, label],
        materials: [material, labelMaterial],
        textures: [labelTexture],
        update: (ageMs, progress) => {
            const windupProgress = clamp(ageMs / windupMs, 0, 1);
            const pulse = 1 + Math.sin(ageMs / 38) * 0.08 + windupProgress * 0.34;
            beam.scaling.x = pulse;
            beam.scaling.y = 0.45 + windupProgress * 1.7;
            beam.visibility = Math.max(0, 0.72 - progress * 0.62);
            reticle.scaling.set(pulse, pulse, pulse);
            reticle.rotation.z += 0.075 + windupProgress * 0.045;
            warning.scaling.set(1 + windupProgress * 0.85, 1 + windupProgress * 0.85, 1);
            warning.rotation.z -= 0.12;
            material.alpha = Math.max(0, 0.56 - progress * 0.48);
            label.position.y += Math.sin(ageMs / 64) * 0.002;
            labelMaterial.alpha = Math.max(0, 1 - Math.max(0, ageMs - windupMs) / 320);
        },
    });
}

function syncPickupAvatars(runtime: ArenaRuntime, nowEpochMs: number): void {
    const visiblePickups = runtime.arenaState.pickups.filter((pickup) =>
        !pickup.pickedBySessionId && pickup.expiresAtEpochMs > nowEpochMs
    );
    const visibleIds = new Set(visiblePickups.map((pickup) => pickup.id));

    for (const pickup of visiblePickups) {
        const avatar = getOrCreatePickupAvatar(runtime.scene, runtime.pickups, pickup);
        avatar.root.position = vector3(pickup.position);
        avatar.root.position.y += 0.2 + Math.sin(nowEpochMs / 280 + pickup.tier) * 0.12;
        avatar.root.rotation.y += 0.028 + pickup.tier * 0.004;
        avatar.ring.rotation.z -= 0.04;
        const pulse = 1 + Math.sin(nowEpochMs / 180) * 0.04;
        avatar.core.scaling.set(pulse, pulse, pulse);
        updatePickupLabel(avatar.labelTexture, pickup);
    }

    for (const [pickupId, avatar] of runtime.pickups) {
        if (visibleIds.has(pickupId)) {
            continue;
        }
        avatar.root.dispose();
        avatar.labelTexture.dispose();
        runtime.pickups.delete(pickupId);
        runtime.sentPickupIds.delete(pickupId);
    }
}

function getOrCreatePickupAvatar(
    scene: Scene,
    pickups: Map<string, PickupAvatar>,
    pickup: ArenaPickupState,
): PickupAvatar {
    const existing = pickups.get(pickup.id);
    if (existing) {
        return existing;
    }

    const root = new TransformNode(`pickup-root-${pickup.id}`, scene);
    root.position = vector3(pickup.position);

    const accent = pickup.tier <= 0
        ? MATRIX_THEME.danger
        : pickup.tier >= 3
        ? MATRIX_THEME.amber
        : MATRIX_THEME.cyan;
    const material = createMatrixMaterial(
        scene,
        `pickup-mat-${pickup.id}`,
        MATRIX_THEME.glass,
        accent,
        0.92,
        0.86,
    );

    const core = MeshBuilder.CreateBox(`pickup-core-${pickup.id}`, {
        width: 0.72,
        height: 0.72,
        depth: 0.72,
    }, scene);
    core.parent = root;
    core.rotation.set(0.4, 0.2, 0.8);
    core.material = material;

    const ring = MeshBuilder.CreateTorus(`pickup-ring-${pickup.id}`, {
        diameter: 1.55,
        thickness: 0.04,
        tessellation: 36,
    }, scene);
    ring.parent = root;
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const labelTexture = new DynamicTexture(`pickup-label-texture-${pickup.id}`, {
        width: 640,
        height: 160,
    }, scene);
    labelTexture.hasAlpha = true;
    updatePickupLabel(labelTexture, pickup);

    const labelMaterial = new StandardMaterial(`pickup-label-mat-${pickup.id}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`pickup-label-${pickup.id}`, {
        width: 2.6,
        height: 0.64,
    }, scene);
    label.parent = root;
    label.position.y = 1.08;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    const avatar = { root, core, ring, label, material, labelTexture };
    pickups.set(pickup.id, avatar);
    return avatar;
}

function detectLocalPickup(
    runtime: ArenaRuntime,
    sessionId: string,
    pickupSeqRef: React.MutableRefObject<number>,
    callbacksRef: React.MutableRefObject<{
        onLocalPose: BabylonArenaProps['onLocalPose'];
        onLocalShot: BabylonArenaProps['onLocalShot'];
        onPlayerHitIntent: BabylonArenaProps['onPlayerHitIntent'];
        onPickupIntent: BabylonArenaProps['onPickupIntent'];
        onLocalCombatChange: BabylonArenaProps['onLocalCombatChange'];
        onLocalPlayerChange: BabylonArenaProps['onLocalPlayerChange'];
        onArenaSnapshot: BabylonArenaProps['onArenaSnapshot'];
    }>,
): void {
    const now = Date.now();
    const pickup = findPickupNearPlayer(runtime.arenaState, sessionId, now);
    if (!pickup || runtime.sentPickupIds.has(pickup.id)) {
        return;
    }
    runtime.sentPickupIds.add(pickup.id);
    pickupSeqRef.current += 1;
    callbacksRef.current.onPickupIntent({
        pickupId: pickup.id,
        sessionId,
        position: runtime.localPlayer.position,
        seq: pickupSeqRef.current,
        sentAtEpochMs: now,
    });
    createImpact(runtime, vector3(pickup.position), MATRIX_THEME.amber, 3);
    runtime.audio.play({ kind: 'pickup' });
    triggerHaptic(runtime, 28);
}

function syncRemotePlayerHits(
    runtime: ArenaRuntime,
    remotePlayerHits: readonly PlayerHitAccepted[],
    localSessionId: string,
): void {
    for (const accepted of remotePlayerHits) {
        const id = `${accepted.intent.shot.sessionId}:${accepted.target.sessionId}:${accepted.revision}:${accepted.intent.shot.seq}`;
        if (runtime.remoteHitIds.has(id)) {
            continue;
        }
        runtime.remoteHitIds.add(id);
        runtime.acceptedHitCount += 1;
        runtime.arenaState = applyPlayerHitAccepted(runtime.arenaState, accepted);
        if (accepted.target.sessionId === localSessionId) {
            runtime.localPlayer = {
                ...runtime.localPlayer,
                vitals: accepted.target.vitals,
                loadout: accepted.target.loadout,
                position: accepted.eliminated
                    ? runtime.localPlayer.position
                    : accepted.target.position,
            };
            runtime.audio.play({ kind: accepted.eliminated ? 'damage' : 'damage' });
        }
        if (accepted.attacker.sessionId === localSessionId) {
            runtime.localPlayer = {
                ...runtime.localPlayer,
                vitals: accepted.attacker.vitals,
            };
        }
        createImpact(
            runtime,
            vector3(accepted.impact),
            accepted.eliminated ? MATRIX_THEME.danger : MATRIX_THEME.cyan,
            accepted.eliminated ? 8 : 2,
        );
    }
}

function syncLocalPlayerFromSnapshot(
    runtime: ArenaRuntime,
    localSessionId: string | undefined,
    snapshot: ArenaSnapshot,
): void {
    const player = localSessionId
        ? snapshot.players.find((candidate) => candidate.sessionId === localSessionId)
        : undefined;
    if (!player) {
        return;
    }
    if (
        player.vitals.respawnedAtEpochMs &&
        player.vitals.respawnedAtEpochMs !== runtime.localPlayer.vitals.respawnedAtEpochMs
    ) {
        runtime.respawnCount += 1;
        runtime.audio.play({ kind: 'respawn' });
        triggerHaptic(runtime, 30);
    }
    if (
        player.vitals.lastDamagedAtEpochMs &&
        player.vitals.lastDamagedAtEpochMs !== runtime.localPlayer.vitals.lastDamagedAtEpochMs
    ) {
        runtime.audio.play({ kind: 'damage' });
        triggerHaptic(runtime, 42);
    }
    runtime.localPlayer = {
        ...runtime.localPlayer,
        position: player.position,
        yaw: player.rotation[1],
        pitch: player.rotation[0],
        vitals: player.vitals,
        loadout: player.loadout,
    };
}

function syncLocalPlayerFromArenaState(runtime: ArenaRuntime, localSessionId: string): void {
    const player = runtime.arenaState.players.find((candidate) =>
        candidate.sessionId === localSessionId
    );
    if (!player) {
        return;
    }
    if (
        player.vitals.respawnedAtEpochMs &&
        player.vitals.respawnedAtEpochMs !== runtime.localPlayer.vitals.respawnedAtEpochMs
    ) {
        runtime.respawnCount += 1;
        runtime.audio.play({ kind: 'respawn' });
    }
    runtime.localPlayer = {
        ...runtime.localPlayer,
        position: player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs > Date.now()
            ? runtime.localPlayer.position
            : player.position,
        vitals: player.vitals,
        loadout: player.loadout,
    };
}

function animateTargets(
    state: ArenaSimulationState,
    dtMs: number,
    nowEpochMs: number,
): ArenaSimulationState {
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    const bounds = Math.max(8, state.layout.halfSize - 2.5);
    const targets = state.targets.map((target) => {
        const next = addTuple(target.position, scaleTuple(target.velocity, dt));
        const bounceX = Math.abs(next[0]) > bounds;
        const bounceY = next[1] < 1.3 || next[1] > 6.2;
        const bounceZ = Math.abs(next[2]) > bounds;
        return {
            ...target,
            position: [
                clamp(next[0], -bounds, bounds),
                clamp(next[1], 1.3, 6.2),
                clamp(next[2], -bounds, bounds),
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
    const hostile = isHostileEye(target);
    const coreColor = hostile ? MATRIX_THEME.danger : target.color;

    const coreMaterial = new StandardMaterial(`target-core-${target.id}`, scene);
    coreMaterial.diffuseColor = Color3.FromHexString(coreColor);
    coreMaterial.emissiveColor = Color3.FromHexString(coreColor).scale(hostile ? 1.0 : 0.64);
    coreMaterial.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.35);

    const pupilMaterial = new StandardMaterial(`target-pupil-${target.id}`, scene);
    pupilMaterial.diffuseColor = Color3.FromHexString(MATRIX_THEME.void);
    pupilMaterial.emissiveColor = Color3.FromHexString(
        hostile ? MATRIX_THEME.magenta : MATRIX_THEME.cyan,
    ).scale(hostile ? 0.82 : 0.26);

    const ringMaterial = new StandardMaterial(`target-ring-${target.id}`, scene);
    ringMaterial.diffuseColor = Color3.FromHexString(coreColor);
    ringMaterial.emissiveColor = Color3.FromHexString(coreColor).scale(hostile ? 1.15 : 0.9);
    ringMaterial.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.4);

    const shardMaterial = createMatrixMaterial(
        scene,
        `target-code-shard-${target.id}`,
        hostile ? MATRIX_THEME.magenta : MATRIX_THEME.cyan,
        hostile ? MATRIX_THEME.magenta : MATRIX_THEME.cyan,
        hostile ? 1.0 : 0.72,
        0.78,
    );

    const iris = MeshBuilder.CreateSphere(`eye-target-${target.id}`, {
        diameterX: target.radius * (hostile ? 3.25 : 2.4),
        diameterY: target.radius * (hostile ? 0.95 : 1.45),
        diameterZ: target.radius * (hostile ? 0.48 : 0.62),
        segments: 28,
    }, scene);
    iris.parent = root;
    iris.material = coreMaterial;

    const pupil = MeshBuilder.CreateSphere(`eye-pupil-${target.id}`, {
        diameterX: target.radius * (hostile ? 1.1 : 0.74),
        diameterY: target.radius * (hostile ? 0.32 : 0.74),
        diameterZ: target.radius * 0.18,
        segments: 18,
    }, scene);
    pupil.parent = root;
    pupil.position.z = -target.radius * 0.34;
    pupil.material = pupilMaterial;

    const ring = MeshBuilder.CreateTorus(`eye-ring-${target.id}`, {
        diameter: target.radius * (hostile ? 3.28 : 2.75),
        thickness: 0.035,
        tessellation: 32,
    }, scene);
    ring.parent = root;
    ring.rotation.x = Math.PI / 2;
    ring.material = ringMaterial;

    const halo = MeshBuilder.CreateTorus(`eye-holo-halo-${target.id}`, {
        diameter: target.radius * (hostile ? 4.15 : 3.65),
        thickness: 0.018,
        tessellation: 42,
    }, scene);
    halo.parent = root;
    halo.rotation.x = Math.PI / 2;
    halo.material = ringMaterial;

    const shardA = MeshBuilder.CreateBox(`eye-shard-a-${target.id}`, {
        width: hostile ? target.radius * 2.7 : 0.08,
        height: hostile ? 0.07 : target.radius * 1.8,
        depth: 0.04,
    }, scene);
    shardA.parent = root;
    shardA.position.set(
        hostile ? 0 : target.radius * 1.8,
        hostile ? target.radius * 0.44 : 0.18,
        -target.radius * 0.08,
    );
    shardA.rotation.z = hostile ? 0.13 : 0.45;
    shardA.material = shardMaterial;

    const shardB = MeshBuilder.CreateBox(`eye-shard-b-${target.id}`, {
        width: hostile ? target.radius * 2.5 : 0.06,
        height: hostile ? 0.07 : target.radius * 1.45,
        depth: 0.04,
    }, scene);
    shardB.parent = root;
    shardB.position.set(
        hostile ? 0 : -target.radius * 1.6,
        hostile ? -target.radius * 0.44 : -0.12,
        -target.radius * 0.06,
    );
    shardB.rotation.z = hostile ? -0.13 : -0.5;
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
        const profile = pose.avatarProfile;
        const accentColor = profile
            ? avatarAccentForPalette(profile.glowPalette)
            : pose.color;
        avatar.material.diffuseColor = Color3.FromHexString(pose.color);
        avatar.material.emissiveColor = Color3.FromHexString(pose.color).scale(0.28);
        avatar.accentMaterial.emissiveColor = Color3.FromHexString(accentColor).scale(0.78);
        avatar.accentMaterial.diffuseColor = Color3.FromHexString(accentColor).scale(0.44);
        avatar.trail.setEnabled(profile?.trailStyle !== 'none');
        avatar.trail.visibility = profile?.trailStyle === 'spark-leak' ? 0.48 : 0.32;
        avatar.decal.rotation.z += profile?.decal === 'bug-bounty' ? 0.035 : 0.018;
        avatar.visor.scaling.x = profile?.visorExpression === 'angry-v' ? 1.18 : 1;
        avatar.ring.rotation.y += 0.025;
        const vitals = pose.vitals;
        if (vitals) {
            const healthRatio = clamp(vitals.health / Math.max(1, vitals.maxHealth), 0, 1);
            avatar.health.scaling.x = Math.max(0.02, healthRatio);
            avatar.health.position.x = -0.55 + healthRatio * 0.55;
            const healthMaterial = avatar.health.material as StandardMaterial | undefined;
            if (healthMaterial) {
                healthMaterial.emissiveColor = Color3.FromHexString(
                    healthRatio <= 0.28 ? MATRIX_THEME.danger : MATRIX_THEME.acid,
                ).scale(0.86);
            }
            avatar.root.setEnabled(!(vitals.deadUntilEpochMs && vitals.deadUntilEpochMs > Date.now()));
        }
        updateLabel(
            avatar.labelTexture,
            pose.username,
            pose.score,
            pose.combo ?? 0,
            pose.color,
            pose.vitals,
            pose.loadout?.weaponKind,
            profile,
        );
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
    const profile = pose.avatarProfile;
    const accentColor = profile
        ? avatarAccentForPalette(profile.glowPalette)
        : pose.color;
    const bodyScale = profile?.robotFrame === 'reaper'
        ? { height: 1.92, width: 0.62, depth: 0.46 }
        : profile?.robotFrame === 'warden'
        ? { height: 1.86, width: 0.84, depth: 0.58 }
        : profile?.robotFrame === 'bulwark'
        ? { height: 1.78, width: 0.92, depth: 0.64 }
        : { height: 1.9, width: 0.76, depth: 0.54 };
    const torsoBoost = profile?.torsoMass === 'titan'
        ? 1.18
        : profile?.torsoMass === 'heavy'
        ? 1.08
        : 1;

    const material = new StandardMaterial(`remote-mat-${sessionId}`, scene);
    material.diffuseColor = Color3.FromHexString(pose.color);
    material.emissiveColor = Color3.FromHexString(pose.color).scale(0.28);
    material.specularColor = Color3.FromHexString(MATRIX_THEME.white).scale(0.22);

    const body = MeshBuilder.CreateBox(`remote-body-${sessionId}`, {
        width: bodyScale.width * torsoBoost,
        height: bodyScale.height * 0.68,
        depth: bodyScale.depth * torsoBoost,
    }, scene);
    body.parent = root;
    body.position.y = -0.78;
    body.material = material;

    const waist = MeshBuilder.CreateBox(`remote-waist-${sessionId}`, {
        width: bodyScale.width * 0.72,
        height: 0.22,
        depth: bodyScale.depth * 0.74,
    }, scene);
    waist.parent = root;
    waist.position.y = -1.38;
    waist.material = material;

    const head = MeshBuilder.CreateBox(`remote-head-${sessionId}`, {
        width: bodyScale.width * 0.74,
        height: 0.42,
        depth: bodyScale.depth * 0.72,
    }, scene);
    head.parent = root;
    head.position.set(0, 0.1, -0.02);
    head.material = material;

    const visorMaterial = new StandardMaterial(`remote-visor-mat-${sessionId}`, scene);
    visorMaterial.diffuseColor = Color3.FromHexString(MATRIX_THEME.void);
    visorMaterial.emissiveColor = Color3.FromHexString(accentColor).scale(0.68);

    const visor = MeshBuilder.CreateBox(`remote-visor-${sessionId}`, {
        width: profile?.visorExpression === 'angry-v' ? 0.64 : 0.52,
        height: profile?.faceplate === 'tax-mask' ? 0.22 : 0.13,
        depth: 0.08,
    }, scene);
    visor.parent = root;
    visor.position.set(0, 0.13, -bodyScale.depth * 0.39);
    visor.rotation.z = profile?.visorExpression === 'grim-smirk' ? 0.05 : 0;
    visor.material = visorMaterial;

    const accentMaterial = createMatrixMaterial(
        scene,
        `remote-accent-${sessionId}`,
        accentColor,
        accentColor,
        0.78,
        0.78,
    );

    const shoulderWidth = profile?.shoulderStyle === 'riot-shields'
        ? 0.56
        : profile?.shoulderStyle === 'spike-rack'
        ? 0.48
        : profile?.shoulderStyle === 'reactor-pauldrons'
        ? 0.5
        : 0.4;
    const shoulderLeft = MeshBuilder.CreateBox(`remote-shoulder-l-${sessionId}`, {
        width: shoulderWidth,
        height: 0.2,
        depth: 0.34,
    }, scene);
    shoulderLeft.parent = root;
    shoulderLeft.position.set(-bodyScale.width * 0.68, -0.32, -0.02);
    shoulderLeft.rotation.z = profile?.shoulderStyle === 'spike-rack' ? -0.18 : 0;
    shoulderLeft.material = accentMaterial;

    const shoulderRight = MeshBuilder.CreateBox(`remote-shoulder-r-${sessionId}`, {
        width: shoulderWidth,
        height: 0.2,
        depth: 0.34,
    }, scene);
    shoulderRight.parent = root;
    shoulderRight.position.set(bodyScale.width * 0.68, -0.32, -0.02);
    shoulderRight.rotation.z = profile?.shoulderStyle === 'spike-rack' ? 0.18 : 0;
    shoulderRight.material = accentMaterial;

    for (const side of [-1, 1] as const) {
        const arm = MeshBuilder.CreateBox(`remote-arm-${side < 0 ? 'l' : 'r'}-${sessionId}`, {
            width: 0.18,
            height: 0.82,
            depth: 0.22,
        }, scene);
        arm.parent = root;
        arm.position.set(side * bodyScale.width * 0.74, -0.86, -0.02);
        arm.rotation.z = side * 0.08;
        arm.material = material;

        const forearm = MeshBuilder.CreateBox(`remote-forearm-${side < 0 ? 'l' : 'r'}-${sessionId}`, {
            width: 0.2,
            height: 0.42,
            depth: 0.26,
        }, scene);
        forearm.parent = root;
        forearm.position.set(side * bodyScale.width * 0.8, -1.24, -0.08);
        forearm.material = accentMaterial;
    }

    const browTilt = profile?.browShape === 'visor-scowl' || profile?.visorExpression === 'angry-v'
        ? 0.16
        : profile?.browShape === 'forked'
        ? 0.08
        : 0;
    for (const side of [-1, 1] as const) {
        const brow = MeshBuilder.CreateBox(`remote-brow-${side < 0 ? 'l' : 'r'}-${sessionId}`, {
            width: 0.26,
            height: 0.055,
            depth: 0.05,
        }, scene);
        brow.parent = root;
        brow.position.set(side * 0.16, 0.28, -bodyScale.depth * 0.43);
        brow.rotation.z = side * -browTilt;
        brow.material = accentMaterial;
    }

    const mouth = MeshBuilder.CreateBox(`remote-mouth-${sessionId}`, {
        width: profile?.visorExpression === 'grim-smirk' ? 0.28 : 0.18,
        height: 0.035,
        depth: 0.045,
    }, scene);
    mouth.parent = root;
    mouth.position.set(profile?.visorExpression === 'grim-smirk' ? 0.04 : 0, -0.08, -bodyScale.depth * 0.43);
    mouth.rotation.z = profile?.visorExpression === 'grim-smirk' ? -0.12 : 0;
    mouth.material = accentMaterial;

    const trail = MeshBuilder.CreatePlane(`remote-trail-${sessionId}`, {
        width: profile?.trailStyle === 'afterimage' ? 0.92 : 0.52,
        height: 1.28,
    }, scene);
    trail.parent = root;
    trail.position.set(0, -0.62, 0.42);
    trail.rotation.x = Math.PI / 2;
    trail.material = accentMaterial;
    trail.setEnabled(profile?.trailStyle !== 'none');

    const decal = MeshBuilder.CreateBox(`remote-decal-${sessionId}`, {
        width: 0.2,
        height: 0.2,
        depth: 0.045,
    }, scene);
    decal.parent = root;
    decal.position.set(0, -0.52, -0.34);
    decal.material = accentMaterial;

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
    updateLabel(labelTexture, pose.username, pose.score, pose.combo ?? 0, pose.color, undefined, undefined, profile);

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

    const healthMaterial = createMatrixMaterial(
        scene,
        `remote-health-${sessionId}`,
        MATRIX_THEME.acid,
        MATRIX_THEME.acid,
        0.86,
        0.92,
    );
    const health = MeshBuilder.CreateBox(`remote-health-bar-${sessionId}`, {
        width: 1.1,
        height: 0.07,
        depth: 0.035,
    }, scene);
    health.parent = root;
    health.position.set(0, 0.62, 0);
    health.material = healthMaterial;

    const avatar = {
        root,
        body,
        visor,
        shoulderLeft,
        shoulderRight,
        trail,
        decal,
        label,
        ring,
        health,
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
    vitals?: PlayerArenaState['vitals'],
    weaponKind?: string,
    profile?: PlayerPose['avatarProfile'],
): void {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 512, 128);
    const accent = profile ? avatarAccentForPalette(profile.glowPalette) : color;
    const displayName = profile?.callsign || username;
    ctx.fillStyle = 'rgba(1, 8, 8, 0.82)';
    ctx.fillRect(10, 20, 492, 86);
    ctx.strokeStyle = MATRIX_THEME.cyan;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 28, 476, 70);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 20, 492, 86);
    ctx.fillStyle = MATRIX_THEME.white;
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(displayName.slice(0, 18), 34, 60);
    ctx.fillStyle = MATRIX_THEME.acid;
    ctx.font = '500 24px system-ui, sans-serif';
    const health = vitals ? ` hp ${Math.ceil(vitals.health)}` : '';
    const weapon = weaponKind ? ` ${weaponKind.replace('-', ' ')}` : '';
    const tag = profile ? ` ${profile.humourTag}` : '';
    ctx.fillText(`score ${score}  x${combo}${health}${weapon}${tag}`.slice(0, 42), 34, 92);
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

function updatePickupLabel(texture: DynamicTexture, pickup: ArenaPickupState): void {
    const accent = pickup.tier <= 0
        ? MATRIX_THEME.danger
        : pickup.tier >= 3
        ? MATRIX_THEME.amber
        : MATRIX_THEME.cyan;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 640, 160);
    ctx.fillStyle = 'rgba(0, 8, 7, 0.78)';
    ctx.fillRect(14, 18, 612, 118);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(14, 18, 612, 118);
    ctx.fillStyle = accent;
    ctx.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(pickup.tier <= 0 ? 'DOWNGRADE' : `TIER ${pickup.tier}`, 34, 58);
    ctx.fillStyle = MATRIX_THEME.white;
    ctx.font = '700 32px system-ui, sans-serif';
    ctx.fillText(pickup.label.slice(0, 24), 34, 98);
    ctx.fillStyle = 'rgba(239, 255, 247, 0.72)';
    ctx.font = '500 19px system-ui, sans-serif';
    ctx.fillText('walk over to accept HR consequences', 34, 124);
    texture.update();
}

function getTargetLabel(target: EyeTargetState): string {
    if (target.threat?.kind === 'boss') {
        return 'Boss Eye Performance Review';
    }
    if (target.threat?.kind === 'beam-sentry') {
        return target.rarity === 'bounty'
            ? 'Bounty Compliance Laser Auditor'
            : 'Compliance Laser Auditor';
    }
    const base = MATRIX_TARGET_LABELS[Math.abs(hashString(target.id)) % MATRIX_TARGET_LABELS.length];
    return target.bountyUntilEpochMs ? `Bounty ${base}` : base;
}

function isHostileEye(target: EyeTargetState): boolean {
    return target.threat?.kind === 'beam-sentry' || target.threat?.kind === 'boss';
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
        : event.kind === 'eye-attack-hit' || event.kind === 'eye-attack-windup' || event.kind === 'boss-eye'
        ? MATRIX_THEME.danger
        : event.kind === 'eye-attack-dodged'
        ? MATRIX_THEME.cyan
        : event.kind === 'wave-complete'
        ? MATRIX_THEME.amber
        : event.kind === 'wave-start'
        ? MATRIX_THEME.magenta
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
    runtime.createdEffectCount += 1;
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
    if (kind === 'wave-start') {
        return 'compliance lasers armed';
    }
    if (kind === 'wave-complete') {
        return 'HR regrets your survival';
    }
    if (kind === 'eye-attack-windup') {
        return 'laser audit is charging';
    }
    if (kind === 'eye-attack-hit') {
        return 'feedback delivered with menace';
    }
    if (kind === 'eye-attack-dodged') {
        return 'audit evaded; paperwork angry';
    }
    if (kind === 'boss-eye') {
        return 'performance review entered the arena';
    }
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

function findPredictedPlayerHit(
    remotePlayers: ReadonlyMap<string, RemotePlayer>,
    localSessionId: string,
    origin: Vec3Tuple,
    direction: Vec3Tuple,
    range: number,
): Readonly<{ targetSessionId: string; targetSeq: number; impact: Vec3Tuple }> | undefined {
    const ray = normalizeTuple(direction);
    let best: Readonly<{ targetSessionId: string; targetSeq: number; impact: Vec3Tuple; distance: number }> | undefined;
    for (const [sessionId, remote] of remotePlayers) {
        if (sessionId === localSessionId) {
            continue;
        }
        if (
            remote.pose.vitals?.deadUntilEpochMs &&
            remote.pose.vitals.deadUntilEpochMs > Date.now()
        ) {
            continue;
        }
        const toTarget = subTuple(remote.pose.position, origin);
        const along = dotTuple(toTarget, ray);
        if (along < 0 || along > range) {
            continue;
        }
        const impact = addTuple(origin, scaleTuple(ray, along));
        const miss = distanceTuple(impact, remote.pose.position);
        if (miss > 0.95) {
            continue;
        }
        if (!best || along < best.distance) {
            best = {
                targetSessionId: sessionId,
                targetSeq: remote.pose.seq,
                impact,
                distance: along,
            };
        }
    }
    return best;
}

function resolveTouchShotDirection(
    runtime: ArenaRuntime,
    event: PointerEvent,
    remotePlayers: ReadonlyMap<string, RemotePlayer>,
    localSessionId: string,
): Readonly<{ direction: Vec3Tuple; assisted: boolean }> {
    const rect = runtime.engine.getRenderingCanvas()?.getBoundingClientRect();
    const renderWidth = runtime.engine.getRenderWidth();
    const renderHeight = runtime.engine.getRenderHeight();
    const x = rect
        ? (event.clientX - rect.left) * (renderWidth / Math.max(1, rect.width))
        : event.offsetX;
    const y = rect
        ? (event.clientY - rect.top) * (renderHeight / Math.max(1, rect.height))
        : event.offsetY;
    const point = { x, y };
    const origin = runtime.localPlayer.position;
    const candidate = chooseTouchAimCandidate({
        point,
        candidates: buildTouchAimCandidates(runtime, remotePlayers, localSessionId, origin),
    });
    if (candidate) {
        createTouchAimPulse(runtime, candidate.world);
        return {
            direction: normalizeTuple(subTuple(candidate.world, origin)),
            assisted: true,
        };
    }

    const ray = runtime.scene.createPickingRay(x, y, Matrix.Identity(), runtime.camera);
    return {
        direction: normalizeTuple([ray.direction.x, ray.direction.y, ray.direction.z]),
        assisted: false,
    };
}

function buildTouchAimCandidates(
    runtime: ArenaRuntime,
    remotePlayers: ReadonlyMap<string, RemotePlayer>,
    localSessionId: string,
    origin: Vec3Tuple,
): readonly TouchAimCandidate[] {
    const candidates: TouchAimCandidate[] = [];
    for (const target of runtime.arenaState.targets) {
        const world = target.position;
        const screen = projectWorldToScreen(runtime, world);
        if (!screen) {
            continue;
        }
        candidates.push({
            id: target.id,
            kind: 'eye',
            screen,
            world,
            distance: distanceTuple(origin, world),
            blocked: blocksShot(runtime.arenaState.layout, origin, world),
        });
    }

    for (const [sessionId, remote] of remotePlayers) {
        if (sessionId === localSessionId) {
            continue;
        }
        const world = remote.pose.position;
        const screen = projectWorldToScreen(runtime, world);
        if (!screen) {
            continue;
        }
        candidates.push({
            id: sessionId,
            kind: 'player',
            screen,
            world,
            distance: distanceTuple(origin, world),
            blocked: blocksShot(runtime.arenaState.layout, origin, world),
        });
    }
    return candidates;
}

function projectWorldToScreen(runtime: ArenaRuntime, world: Vec3Tuple): Point2 | undefined {
    const projected = Vector3.Project(
        vector3(world),
        Matrix.Identity(),
        runtime.scene.getTransformMatrix(),
        runtime.camera.viewport.toGlobal(
            runtime.engine.getRenderWidth(),
            runtime.engine.getRenderHeight(),
        ),
    );
    if (projected.z < 0 || projected.z > 1) {
        return undefined;
    }
    return { x: projected.x, y: projected.y };
}

function createTouchAimPulse(runtime: ArenaRuntime, world: Vec3Tuple): void {
    const material = createMatrixMaterial(
        runtime.scene,
        `touch-aim-assist-${performance.now()}`,
        MATRIX_THEME.acid,
        MATRIX_THEME.cyan,
        1,
        0.72,
    );
    const ring = MeshBuilder.CreateTorus(`touch-aim-ring-${performance.now()}`, {
        diameter: 1.15,
        thickness: 0.035,
        tessellation: 36,
    }, runtime.scene);
    ring.position = vector3(world);
    ring.position.y += 0.12;
    ring.billboardMode = Mesh.BILLBOARDMODE_ALL;
    ring.material = material;
    addTransientEffect(runtime, {
        startedAtMs: performance.now(),
        durationMs: 360,
        meshes: [ring],
        materials: [material],
        update: (_age, progress) => {
            const scale = 1 + progress * 0.9;
            ring.scaling.set(scale, scale, scale);
            material.alpha = Math.max(0, 0.72 - progress * 0.72);
        },
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

function setAction(
    runtime: ArenaRuntime,
    action: MutableButtonAction,
    value: boolean,
): void {
    runtime.input[action] = value;
}

function pulseAction(runtime: ArenaRuntime, action: MutableButtonAction, durationMs = 120): void {
    setAction(runtime, action, true);
    window.setTimeout(() => {
        setAction(runtime, action, false);
    }, durationMs);
}

function triggerHaptic(runtime: ArenaRuntime, durationMs: number): void {
    if (!runtime.mobileSettings.hapticsEnabled || typeof navigator === 'undefined') {
        return;
    }
    navigator.vibrate?.(Math.max(4, Math.min(60, durationMs)));
}

function unlockArenaAudio(runtime: ArenaRuntime): void {
    void runtime.audio.unlock().catch(() => undefined);
}

function safeSetPointerCapture(element: Element, pointerId: number): void {
    try {
        element.setPointerCapture?.(pointerId);
    } catch {
        // Synthetic mobile tests and some Safari edge cases can reject capture
        // for a pointer that has already ended. The input state still updates.
    }
}

function safeReleasePointerCapture(element: Element, pointerId: number): void {
    try {
        if (element.hasPointerCapture?.(pointerId)) {
            element.releasePointerCapture(pointerId);
        }
    } catch {
        // Best-effort cleanup; pointercancel/up also resets the logical state.
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
    canvas.dataset.arenaEffectCount = String(runtime.createdEffectCount);
    canvas.dataset.arenaActiveEffectCount = String(runtime.transientEffects.length);
    canvas.dataset.arenaTargetCount = String(runtime.targets.size);
    canvas.dataset.arenaPointerDownCount = String(runtime.pointerDownCount);
    canvas.dataset.arenaSize = String(runtime.arenaState.layout.halfSize * 2);
    canvas.dataset.arenaLayoutId = runtime.arenaState.layout.id;
    canvas.dataset.arenaPickupCount = String(
        runtime.arenaState.pickups.filter((pickup) => !pickup.pickedBySessionId).length,
    );
    canvas.dataset.arenaWeaponKind = runtime.localPlayer.loadout.weaponKind;
    canvas.dataset.arenaLocalHealth = String(Math.ceil(runtime.localPlayer.vitals.health));
    canvas.dataset.arenaAcceptedHitCount = String(runtime.acceptedHitCount);
    canvas.dataset.arenaRespawnCount = String(runtime.respawnCount);
    canvas.dataset.arenaActiveChaosId = runtime.arenaState.activeEvent?.id ?? '';
    canvas.dataset.arenaWave = String(runtime.arenaState.wave.number);
    canvas.dataset.arenaWavePhase = runtime.arenaState.wave.phase;
    canvas.dataset.arenaAttackCount = String(runtime.arenaState.attacks.length);
    canvas.dataset.arenaHostileEyeCount = String(
        runtime.arenaState.targets.filter(isHostileEye).length,
    );
    const touchDiagnostics = createTouchControlDiagnostics(runtime.touchState, runtime.touchStick);
    canvas.dataset.arenaInputMode = touchDiagnostics.lastInputMode;
    canvas.dataset.arenaMobileControls = runtime.mobileControlsEnabled ? 'true' : 'false';
    canvas.dataset.arenaTouchMoveActive = touchDiagnostics.movePointerId === undefined ? 'false' : 'true';
    canvas.dataset.arenaTouchLookActive = touchDiagnostics.lookActive ? 'true' : 'false';
    canvas.dataset.arenaGyroEnabled = runtime.mobileSettings.gyroEnabled ? 'true' : 'false';
    const audioDiagnostics = runtime.audio.diagnostics();
    canvas.dataset.arenaAudioUnlocked = audioDiagnostics.unlocked ? 'true' : 'false';
    canvas.dataset.arenaAudioState = audioDiagnostics.contextState;
    canvas.dataset.arenaAudioMuted = audioDiagnostics.muted ? 'true' : 'false';
    canvas.dataset.arenaAudioVoices = String(audioDiagnostics.activeVoices);
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

function subTuple(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleTuple(a: Vec3Tuple, scalar: number): Vec3Tuple {
    return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function dotTuple(a: Vec3Tuple, b: Vec3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distanceTuple(a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalizeTuple(value: Vec3Tuple): Vec3Tuple {
    const length = Math.hypot(value[0], value[1], value[2]);
    return length > 0.0001
        ? [value[0] / length, value[1] / length, value[2] / length]
        : [0, 0, 1];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
