import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { RefObject } from 'react';

import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { createRallarMotionBuffer } from '@shared/rallar-motion/mod.ts';
import { CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

import type { ArenaSimulationState } from '@ar-eye-hunter/arena-contracts.ts';
import {
    createInitialPlayerState,
    EMPTY_INPUT,
    type LocalPlayerState
} from '@ar-eye-hunter/arena-player-state.ts';
import type { ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import {
    createInitialArenaState,
    hydrateArenaSnapshot,
    toArenaSnapshot
} from '@ar-eye-hunter/simulation.ts';
import {
    calculateArenaMusicLayerState,
    ProceduralArenaAudio,
    type ArenaAudioSettings,
    type ArenaMusicLayerState
} from '../arena-audio.ts';
import type { PlayerPose } from '../arena-contracts.ts';
import {
    calculateVirtualStick,
    createInitialTouchControlState,
    type InputDeviceKind,
    type MobileControlSettings
} from '../mobile-input.ts';
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

interface ArenaGraphics {
    readonly scene: Scene;
    readonly camera: FreeCamera;
}

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
    private started = false;
    private readonly frameLoop: CappedFrameLoop;
    private previewInteracted = false;
    private presentedTerminal: ArenaTournamentSnapshot | undefined;
    private idlePlayer: LocalPlayerState | undefined;
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
        this.frameLoop = new CappedFrameLoop({
            driver: {
                start: (frame) => this.engine.runRenderLoop(frame),
                stop: (frame) => this.engine.stopRenderLoop(frame),
                resetTiming: () => {
                    this.lastFrameEpochMs = this.clock.nowEpochMs();
                }
            },
            nowMs: this.clock.nowMonotonicMs,
            renderFrame: () => this.render()
        }, { frameIntervalMs: 0 });
    }

    get arenaState(): ArenaSimulationState {
        return this.simulation.getSimulation();
    }
    set arenaState(state: ArenaSimulationState) {
        this.simulation.setPrediction(state);
    }

    start(): void {
        if (this.started || this.scene.isDisposed) {
            return;
        }
        this.started = true;
        window.addEventListener('resize', this.resize);
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerdown', this.onPointerDown, true);
        this.canvas.addEventListener('pointerup', this.onPointerUp, true);
        this.canvas.addEventListener('contextmenu', this.onContextMenu, true);
        this.scene.onBeforeRenderObservable.add(this.advanceFrame);
        this.refreshPresentation();
    }

    /** Reconcile native presentation after React has installed the current room scene and props. */
    refreshPresentation(): void {
        if (!this.started) {
            return;
        }
        const snapshot = this.props.current.tournament?.snapshot;
        if (isTerminalTournament(snapshot)) {
            if (isSameTerminalPresentation(this.presentedTerminal, snapshot)) {
                return;
            }
            this.frameLoop.pauseWhenReady();
            this.frameLoop.invalidate();
            return;
        }
        if (this.idlePlayer) {
            this.resetIdleInput();
            this.idlePlayer = undefined;
        }
        this.presentedTerminal = undefined;
        if (this.isUntouchedPreview()) {
            this.frameLoop.pauseWhenReady();
        }
        else {
            this.frameLoop.resume();
            this.frameLoop.start();
        }
    }

    beginInteraction(): boolean {
        if (!this.acceptsInput()) {
            return false;
        }
        this.previewInteracted = true;
        this.frameLoop.resume();
        return true;
    }

    private isUntouchedPreview(): boolean {
        const props = this.props.current;
        return !this.previewInteracted && props.roomId === undefined && !props.tournament && !props.spectating;
    }

    stop(): void {
        this.started = false;
        this.frameLoop.dispose();
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
        this.audio.dispose();
        this.scene.dispose();
        this.canvas.dataset.arenaRuntimeReady = 'false';
    }

    pulse(action: MutableButtonAction, durationMs: number): void {
        if (!this.acceptsInput()) {
            return;
        }
        this.beginInteraction();
        this.input[action] = true;
        const timer = setTimeout(() => {
            this.pulseTimers.delete(timer);
            this.input[action] = false;
        }, durationMs);
        this.pulseTimers.add(timer);
    }

    private readonly advanceFrame = (): void => {
        if (this.idlePlayer) {
            this.resetIdleInput();
        }
        runFrame({
            ...this.props.current,
            runtime: this
        });
    };
    private readonly render = (): 'ready' | 'pending' => {
        if (!this.started) {
            return 'ready';
        }
        const snapshot = this.props.current.tournament?.snapshot;
        const terminal = isTerminalTournament(snapshot);
        // A terminal frame is complete only after its materials were ready before drawing and remain
        // ready afterwards: applying the native snapshot can introduce meshes during onBeforeRender.
        const settling = terminal || this.isUntouchedPreview();
        const readyBeforeRender = !settling || this.scene.isReady();
        this.scene.render();
        writeArenaDiagnostics(this.canvas, this);
        if (settling && (!readyBeforeRender || !this.scene.isReady())) {
            return 'pending';
        }
        if (terminal) {
            this.idlePlayer = this.localPlayer;
            this.resetIdleInput();
            this.presentedTerminal = snapshot;
        }
        return 'ready';
    };
    private readonly resize = (): void => {
        if (!this.started) {
            return;
        }
        this.engine.resize();
        this.frameLoop.invalidate();
    };
    private acceptsInput(): boolean {
        return this.started && !isTerminalTournament(this.props.current.tournament?.snapshot);
    }
    private resetIdleInput(): void {
        Object.assign(this.input, EMPTY_INPUT);
        for (const timer of this.pulseTimers) {
            clearTimeout(timer);
        }
        this.pulseTimers.clear();
        this.touchState = createInitialTouchControlState();
        this.touchStick = calculateVirtualStick({ x: 0, y: 0 }, { x: 0, y: 0 }, 72);
        this.localPoseRef.current = undefined;
        this.lastFrameEpochMs = this.clock.nowEpochMs();
        if (this.idlePlayer) {
            this.localPlayer = { ...this.localPlayer, yaw: this.idlePlayer.yaw, pitch: this.idlePlayer.pitch };
        }
    }
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (
            !this.acceptsInput() ||
            event.target instanceof Element &&
                event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        ) {
            return;
        }
        if (!setInputKey(this.input, event.code, true)) {
            return;
        }
        if (event.code !== 'Escape') {
            this.beginInteraction();
        }
        this.inputDevice = 'keyboard-mouse';
    };
    private readonly onKeyUp = (event: KeyboardEvent): void => {
        setInputKey(this.input, event.code, false);
    };
    private readonly onPointerMove = (event: PointerEvent): void => {
        if (this.acceptsInput() && document.pointerLockElement === this.canvas) {
            this.inputDevice = 'keyboard-mouse';
            applyLook(this, event.movementX * 0.0024, event.movementY * 0.002);
        }
    };
    private readonly onPointerDown = (event: PointerEvent): void => {
        if (!this.acceptsInput()) {
            return;
        }
        this.pointerDownCount += 1;
        unlockArenaAudio(this);
        const props = this.props.current;
        if (props.spectating) {
            return;
        }
        this.beginInteraction();
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

function isTerminalTournament(snapshot: ArenaTournamentSnapshot | undefined): snapshot is ArenaTournamentSnapshot {
    return snapshot?.status === 'finished' || snapshot?.status === 'cancelled';
}

function isSameTerminalPresentation(
    previous: ArenaTournamentSnapshot | undefined,
    current: ArenaTournamentSnapshot
): boolean {
    return previous !== undefined && previous.status === current.status &&
        previous.binding.gameId === current.binding.gameId &&
        isSameGroupRef(previous.binding.roomRef, current.binding.roomRef) &&
        previous.state?.arena.revision === current.state?.arena.revision &&
        previous.state?.simulatedAtEpochMs === current.state?.simulatedAtEpochMs;
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
    return { scene, camera };
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
