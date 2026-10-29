import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { RefObject } from 'react';

import { createRallarMotionBuffer } from '@shared/rallar-motion/mod.ts';

import {
    calculateArenaMusicLayerState,
    ProceduralArenaAudio,
    type ArenaAudioSettings,
    type ArenaMusicLayerState
} from '../arenaAudio.ts';
import {
    calculateVirtualStick,
    createInitialTouchControlState,
    type InputDeviceKind,
    type MobileControlSettings
} from '../mobileInput.ts';
import {
    createInitialArenaState,
    createInitialPlayerState,
    EMPTY_INPUT,
    hydrateArenaSnapshot,
    toArenaSnapshot,
    type ArenaSimulationState,
    type LocalPlayerState
} from '../simulation.ts';
import type { PlayerPose } from '../types.ts';
import type {
    ArenaSceneClock,
    BabylonArenaProps,
    LocalPoseHistory,
    MutableButtonAction,
    PickupAvatar,
    RemoteAvatar,
    TargetAvatar,
    TransientEffect
} from './arena-scene-contracts.ts';
import { createScanPulse } from './arena-scene-effects.ts';
import { unlockArenaAudio, writeArenaDiagnostics } from './arena-scene-feedback.ts';
import { ArenaSceneState } from './arena-scene-state.ts';
import {
    applyLook,
    fireLocalShot,
    runFrame,
    syncLocalPlayerFromSnapshot
} from './arena-scene-step.ts';
import { ARENA_SCENE_THEME } from './arena-scene-theme.ts';
import { resolveTouchShotDirection } from './arena-shot-aim.ts';
import { syncTargetAvatars } from './arena-target-view.ts';
import { setInputKey } from './arena-touch-input.ts';
import { buildArena, buildLayoutProps } from './arena-world-view.ts';

export namespace ArenaSceneRuntime {
    export interface Input {
        readonly canvas: HTMLCanvasElement;
        readonly engine: Engine;
        readonly props: RefObject<BabylonArenaProps>;
        readonly mobileSettings: MobileControlSettings;
        readonly audioSettings: ArenaAudioSettings;
        readonly clock: ArenaSceneClock;
    }
}

/** Owns one room scene; the canvas owner retains the engine and simulation owns accepted state. */
export class ArenaSceneRuntime {
    private readonly canvas: HTMLCanvasElement;
    private readonly props: RefObject<BabylonArenaProps>;
    readonly clock: ArenaSceneClock;
    readonly engine: Engine;
    readonly scene: Scene;
    readonly camera: FreeCamera;
    readonly glow: GlowLayer;
    readonly layoutPropRoot: TransformNode;
    readonly simulation: ArenaSceneState;
    readonly avatars = new Map<string, RemoteAvatar>();
    readonly targets = new Map<string, TargetAvatar>();
    readonly pickups = new Map<string, PickupAvatar>();
    readonly motionBuffer = createRallarMotionBuffer<PlayerPose>({ interpolationDelayMs: 75, maxExtrapolationMs: 130 });
    readonly motionSampleKeys = new Map<string, string>();
    readonly remoteShotIds = new Set<string>();
    readonly remoteHitIds = new Set<string>();
    readonly attackCueIds = new Set<string>();
    readonly sentPickupIds = new Set<string>();
    readonly appliedEventIds = new Set<string>();
    readonly audio: ProceduralArenaAudio;
    readonly input = { ...EMPTY_INPUT };
    readonly poseSeqRef = { current: 0 };
    readonly shotSeqRef = { current: 0 };
    readonly pickupSeqRef = { current: 0 };
    readonly localPoseRef: { current: LocalPoseHistory | undefined; } = { current: undefined };
    private readonly pulseTimers = new Set<ReturnType<typeof setTimeout>>();
    localPlayer: LocalPlayerState;
    lastFrameEpochMs: number;
    lastSnapshotRevision = -1;
    recoil = 0;
    hitStopUntilEpochMs = 0;
    transientEffects: TransientEffect[] = [];
    createdEffectCount = 0;
    pointerDownCount = 0;
    acceptedHitCount = 0;
    respawnCount = 0;
    inputDevice: InputDeviceKind = 'keyboard-mouse';
    touchState = createInitialTouchControlState();
    touchStick = calculateVirtualStick({ x: 0, y: 0 }, { x: 0, y: 0 }, 72);
    mobileSettings: MobileControlSettings;
    mobileControlsEnabled = false;
    audioSettings: ArenaAudioSettings;
    audioLayerState: ArenaMusicLayerState;
    linkTone: BabylonArenaProps['linkState']['tone'];
    playedNoticeIds = new Set<string>();
    lastAudioMatchStatus = 'infinite';
    lastAudioWaveKey = '1:warmup';
    lowHealthWarned = false;
    touchAimAssistUntilMs = 0;

    constructor(input: ArenaSceneRuntime.Input) {
        this.canvas = input.canvas;
        this.props = input.props;
        this.clock = input.clock;
        this.mobileSettings = input.mobileSettings;
        this.audioSettings = input.audioSettings;
        const graphics = createArenaGraphics(input.engine);
        this.engine = input.engine;
        this.scene = graphics.scene;
        this.camera = graphics.camera;
        this.glow = graphics.glow;
        this.lastFrameEpochMs = input.clock.nowEpochMs();
        const snapshot = input.props.current.arenaSnapshot;
        const initial = snapshot
            ? hydrateArenaSnapshot(snapshot)
            : createInitialArenaState(undefined, this.lastFrameEpochMs);
        this.simulation = new ArenaSceneState(initial);
        this.localPlayer = createInitialPlayerState(this.lastFrameEpochMs);
        this.layoutPropRoot = new TransformNode('arena-layout-props', this.scene);
        this.audio = new ProceduralArenaAudio(input.audioSettings);
        this.linkTone = input.props.current.linkState.tone;
        this.audioLayerState = initialMusicState(this.linkTone, input.audioSettings);
        buildArena(this.scene, initial.layout, this.clock.nowMonotonicMs);
        buildLayoutProps(this.scene, this.layoutPropRoot, { layout: initial.layout, nowMs: this.clock.nowMonotonicMs });
        syncLocalPlayerFromSnapshot(
            this,
            input.props.current.localSessionId,
            toArenaSnapshot(initial, input.props.current.roomId, this.lastFrameEpochMs)
        );
        syncTargetAvatars(this, this.lastFrameEpochMs);
    }

    get arenaState(): ArenaSimulationState {
        return this.simulation.getSimulation();
    }
    set arenaState(state: ArenaSimulationState) {
        this.simulation.setPrediction(state);
    }

    start(): void {
        window.addEventListener('resize', this.resize);
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerdown', this.onPointerDown, true);
        this.canvas.addEventListener('pointerup', this.onPointerUp, true);
        this.canvas.addEventListener('contextmenu', this.onContextMenu, true);
        this.scene.onBeforeRenderObservable.add(this.advanceFrame);
        this.engine.runRenderLoop(this.render);
    }

    stop(): void {
        window.removeEventListener('resize', this.resize);
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerdown', this.onPointerDown, true);
        this.canvas.removeEventListener('pointerup', this.onPointerUp, true);
        this.canvas.removeEventListener('contextmenu', this.onContextMenu, true);
        for (const timer of this.pulseTimers) {
            clearTimeout(timer);
        }
        this.pulseTimers.clear();
        this.engine.stopRenderLoop(this.render);
        this.audio.dispose();
        this.scene.dispose();
        this.canvas.dataset.arenaRuntimeReady = 'false';
    }

    pulse(action: MutableButtonAction, durationMs: number): void {
        this.input[action] = true;
        const timer = setTimeout(() => {
            this.pulseTimers.delete(timer);
            this.input[action] = false;
        }, durationMs);
        this.pulseTimers.add(timer);
    }

    private readonly advanceFrame = (): void => {
        runFrame({
            ...this.props.current,
            runtime: this
        });
    };
    private readonly render = (): void => {
        this.scene.render();
        writeArenaDiagnostics(this.canvas, this);
    };
    private readonly resize = (): void => this.engine.resize();
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        this.inputDevice = 'keyboard-mouse';
        setInputKey(this.input, event.code, true);
    };
    private readonly onKeyUp = (event: KeyboardEvent): void => setInputKey(this.input, event.code, false);
    private readonly onPointerMove = (event: PointerEvent): void => {
        if (document.pointerLockElement === this.canvas) {
            this.inputDevice = 'keyboard-mouse';
            applyLook(this, event.movementX * 0.0024, event.movementY * 0.002);
        }
    };
    private readonly onPointerDown = (event: PointerEvent): void => {
        this.pointerDownCount += 1;
        unlockArenaAudio(this);
        const props = this.props.current;
        if (props.spectating) {
            return;
        }
        if (event.button === 0) {
            const touch = event.pointerType === 'touch';
            const aim = touch
                ? resolveTouchShotDirection({
                    runtime: this,
                    event: event,
                    remotePlayers: props.remotePlayers,
                    localSessionId: props.localSessionId ?? 'local'
                })
                : undefined;
            if (touch) {
                event.preventDefault();
            }
            fireLocalShot({
                ...props,
                runtime: this,
                directionOverride: aim?.direction,
                touchAssisted: aim?.assisted
            });
            if (!touch) {
                requestArenaPointerLock(this.canvas);
            }
        }
        else if (event.button === 2) {
            this.input.altFire = true;
            createScanPulse(this, this.localPlayer.position, props.localColor);
            requestArenaPointerLock(this.canvas);
        }
    };
    private readonly onPointerUp = (event: PointerEvent): void => {
        if (event.button === 2) {
            this.input.altFire = false;
        }
    };
    private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault();
}

interface ArenaGraphics {
    readonly scene: Scene;
    readonly camera: FreeCamera;
    readonly glow: GlowLayer;
}

function createArenaGraphics(engine: Engine): ArenaGraphics {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.003, 0.018, 0.014, 1);
    scene.ambientColor = Color3.FromHexString(ARENA_SCENE_THEME.acid).scale(0.18);
    scene.collisionsEnabled = true;
    const camera = new FreeCamera('hunter-camera', new Vector3(0, 1.72, -11), scene);
    camera.minZ = 0.05;
    camera.maxZ = 190;
    camera.fov = 0.94;
    const glow = new GlowLayer('arena-glow', scene);
    glow.intensity = 0.92;
    return { scene, camera, glow };
}

function initialMusicState(
    linkTone: BabylonArenaProps['linkState']['tone'],
    settings: ArenaAudioSettings
): ArenaMusicLayerState {
    return calculateArenaMusicLayerState({
        matchStatus: 'infinite',
        matchRemainingRatio: 1,
        wavePhase: 'warmup',
        waveNumber: 1,
        hostileCount: 0,
        incomingAttack: false,
        healthRatio: 1,
        linkTone,
        reducedIntensity: settings.reducedIntensity
    }, settings);
}

function requestArenaPointerLock(canvas: HTMLCanvasElement): void {
    try {
        const result = canvas.requestPointerLock?.();
        if (result instanceof Promise) {
            void result.catch(() => undefined);
        }
    }
    catch {
        // Browser policy can block pointer lock in embedded views; aiming remains available.
    }
}
