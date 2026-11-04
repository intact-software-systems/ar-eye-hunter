import { type CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

import { type RelicCameraMode } from '../relic-scene-model.ts';
import { startCappedRenderLoop } from '../start-capped-render-loop.ts';
import { computeRelicTerminalPresentationKey } from './compute-relic-terminal-presentation-key.ts';
import { readRelicFrameReadiness } from './read-relic-frame-readiness.ts';
import { changeRuntimeCameraMode, updateCamera } from './relic-camera.ts';
import { clearSceneDiagnostics, writeDiagnostics, writeRelicFrameObservation } from './relic-scene-diagnostics.ts';
import { RelicSceneInput } from './relic-scene-input.ts';
import {
    createRelicSceneRuntime,
    RelicSceneRuntime,
    syncRelicSceneSnapshot,
    updateRelicSceneMotion
} from './relic-scene-runtime.ts';

import { syncRelicAvatarPresentation } from './sync-relic-avatar-presentation.ts';

/** Owns one graphics lifetime; React and room/network state stay subscribed outside it. */
export class RelicSceneLifecycle {
    readonly runtime: RelicSceneRuntime;
    private readonly loop: CappedFrameLoop;
    private readonly input: RelicSceneInput;
    private disposed = false;
    private readonly resize = () => {
        this.runtime.engine.resize();
        this.loop.invalidate();
    };

    constructor(runtime: RelicSceneRuntime, loop: CappedFrameLoop, input: RelicSceneInput) {
        this.runtime = runtime;
        this.loop = loop;
        this.input = input;
    }

    start(): void {
        try {
            this.input.start();
            window.addEventListener('resize', this.resize);
            if (this.runtime.terminal) {
                this.loop.pauseWhenReady();
            }
        }
        catch (error) {
            this.dispose();
            throw error;
        }
    }

    update(input: RelicSceneRuntime.Input): void {
        if (this.disposed) {
            return;
        }
        const runtime = this.runtime;
        const terminalKey = computeRelicTerminalPresentationKey(input.snapshot);
        const terminal = terminalKey !== undefined;
        const changedSnapshot = terminal
            ? terminalKey !== runtime.terminalKey
            : input.snapshot !== runtime.snapshot.value;
        const changedView = input.localPlayerId !== runtime.localPlayerId.value ||
            input.selectedRoomId !== runtime.selectedRoomId.value ||
            (!terminal && input.focusRoomId !== runtime.focusRoomId.value);
        const changedLifetime = terminal !== runtime.terminal ||
            input.snapshot?.gameId !== runtime.snapshot.value?.gameId ||
            input.snapshot?.roomId !== runtime.snapshot.value?.roomId;
        if (changedLifetime) {
            this.input.reset();
            resetRelicSceneMotion(runtime);
        }
        runtime.terminal = terminal;
        runtime.terminalKey = terminalKey;
        writeRelicSceneInput(runtime, input);
        if (changedSnapshot || changedView) {
            syncRelicSceneSnapshot(runtime);
            this.loop.invalidate();
        }
        if (terminal) {
            this.loop.pauseWhenReady();
        }
        else {
            this.loop.resume();
        }
    }

    changeCameraMode(mode: RelicCameraMode): void {
        if (!this.disposed) {
            changeRuntimeCameraMode(this.runtime, mode);
            this.loop.invalidate();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        window.removeEventListener('resize', this.resize);
        this.loop.dispose();
        this.input.dispose();
        clearSceneDiagnostics(this.runtime.canvas);
        this.runtime.scene.dispose();
        this.runtime.engine.dispose();
    }
}

export function createRelicSceneLifecycle(input: RelicSceneRuntime.Input): RelicSceneLifecycle {
    const runtime = createRelicSceneRuntime(input);
    const loop = startRelicSceneRendering(runtime);
    const lifecycle = new RelicSceneLifecycle(runtime, loop, new RelicSceneInput(runtime));
    lifecycle.start();
    return lifecycle;
}

function startRelicSceneRendering(runtime: RelicSceneRuntime): CappedFrameLoop {
    try {
        return startCappedRenderLoop({
            engine: runtime.engine,
            frameIntervalMs: 1000 / 45,
            renderFrame: () => renderRelicFrame(runtime)
        });
    }
    catch (error) {
        clearSceneDiagnostics(runtime.canvas);
        runtime.scene.dispose();
        runtime.engine.dispose();
        throw error;
    }
}

export function renderRelicFrame(runtime: RelicSceneRuntime): 'ready' | 'pending' {
    if (runtime.terminal) {
        for (const avatar of runtime.avatars.values()) {
            avatar.root.position.copyFrom(avatar.target);
            avatar.trail.setEnabled(false);
        }
        updateCamera(runtime);
    }
    else {
        updateRelicSceneMotion(runtime);
    }
    syncRelicAvatarPresentation({
        avatars: runtime.avatars,
        firstPersonRig: runtime.firstPersonRig,
        localPlayerId: runtime.localPlayerId.value,
        cameraMode: runtime.cameraMode.value
    });
    const before = runtime.renderScene();
    const after = readRelicFrameReadiness(runtime);
    const ready = before !== undefined && before.ready && after.ready && before.meshKey === after.meshKey;
    writeRelicFrameObservation(runtime, after, ready);
    if (ready) {
        writeDiagnostics(runtime);
    }
    return ready ? 'ready' : 'pending';
}

function writeRelicSceneInput(runtime: RelicSceneRuntime, input: RelicSceneRuntime.Input): void {
    runtime.snapshot.value = input.snapshot;
    runtime.localPlayerId.value = input.localPlayerId;
    runtime.selectedRoomId.value = input.selectedRoomId;
    runtime.primedAction.value = input.primedAction;
    runtime.focusRoomId.value = input.focusRoomId;
    runtime.rtcReady.value = input.rtcReady;
    runtime.inputEnabled.value = input.inputEnabled && !runtime.terminal;
    runtime.reviewDirector.value = input.reviewDirector;
    runtime.onSelectRoom.value = input.onSelectRoom;
    runtime.onPrimeAction.value = input.onPrimeAction;
    runtime.onPickupRelic.value = input.onPickupRelic;
    runtime.onPromptChange.value = input.onPromptChange;
    runtime.onPickupPromptChange.value = input.onPickupPromptChange;
    runtime.onCameraModeChange.value = input.onCameraModeChange;
    runtime.onReviewPlaybackComplete.value = input.onReviewPlaybackComplete;
}

function resetRelicSceneMotion(runtime: RelicSceneRuntime): void {
    runtime.engine.performanceMonitor.reset();
    runtime.nearbyRelic.value = undefined;
    runtime.onPickupPromptChange.value(undefined);
    runtime.onPromptChange.value(undefined);
    runtime.motionPhase.value = 'idle';
    runtime.flyoverStartedAtMs.value = undefined;
    runtime.roamOffset.set(0, 0, 0);
    for (const playerId of runtime.motion.buffer.entityIds()) {
        runtime.motion.buffer.remove(playerId);
    }
    runtime.motion.kinematics.reset();
    runtime.motion.sendGate.reset();
    runtime.motion.adaptiveDelay.reset();
    for (const effect of runtime.effects) {
        effect.dispose();
    }
    runtime.effects = [];
}
