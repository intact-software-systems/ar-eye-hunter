import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

import { type NeonCameraPose } from '../relic-scene-model.ts';
import {
    planNeonAvatarCameraPose,
    planNeonFirstPersonCameraPose,
    planNeonFlyoverCameraPose,
    planNeonOverviewCameraPose,
    planNeonTacticalCameraPose,
    type RelicCameraMode
} from '../relic-scene-model.ts';
import { roomIdForCuePlayer } from './relic-review.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';

const RELIC_SCENE_CAMERA_MODES: readonly RelicCameraMode[] = [
    'avatar',
    'first-person',
    'overview'
];

export function changeRuntimeCameraMode(runtime: RelicSceneRuntime, mode: RelicCameraMode): void {
    const snapshot = runtime.snapshot.value;
    const hasLocalHunter = hasPlayableLocalHunter(snapshot, runtime.localPlayerId.value);
    const nextMode = (mode === 'avatar' || mode === 'first-person') && !hasLocalHunter ? 'overview' : mode;
    if (nextMode === 'flyover') {
        runtime.previousCameraMode.value = runtime.cameraMode.value === 'flyover'
            ? runtime.previousCameraMode.value
            : runtime.cameraMode.value;
        runtime.flyoverStartedAtMs.value = performance.now();
    }
    else {
        runtime.previousCameraMode.value = nextMode;
        runtime.flyoverStartedAtMs.value = undefined;
        writeCameraModePreference(nextMode);
    }
    runtime.cameraMode.value = nextMode;
    runtime.pointerLook.active = false;
    runtime.onCameraModeChange.value(nextMode);
}

export function cycleRuntimeCameraMode(runtime: RelicSceneRuntime): void {
    const current = runtime.cameraMode.value === 'flyover'
        ? runtime.previousCameraMode.value
        : runtime.cameraMode.value;
    const available = RELIC_SCENE_CAMERA_MODES.filter((mode) =>
        (mode !== 'avatar' && mode !== 'first-person') ||
        hasPlayableLocalHunter(runtime.snapshot.value, runtime.localPlayerId.value)
    );
    const index = Math.max(0, available.indexOf(current));
    changeRuntimeCameraMode(runtime, available[(index + 1) % available.length] ?? 'overview');
}

export function ensureCameraModeHasPlayer(runtime: RelicSceneRuntime): void {
    if (
        (runtime.cameraMode.value === 'avatar' || runtime.cameraMode.value === 'first-person') &&
        !hasPlayableLocalHunter(runtime.snapshot.value, runtime.localPlayerId.value)
    ) {
        changeRuntimeCameraMode(runtime, 'overview');
    }
}

export function resolveDefaultCameraMode(
    snapshot?: RelicPublicSnapshot,
    localPlayerId?: string,
    stored?: RelicCameraMode
): RelicCameraMode {
    if (stored && stored !== 'flyover') {
        if ((stored === 'avatar' || stored === 'first-person') && !hasPlayableLocalHunter(snapshot, localPlayerId)) {
            return 'overview';
        }
        return stored;
    }
    return hasPlayableLocalHunter(snapshot, localPlayerId) ? 'avatar' : 'overview';
}

function hasPlayableLocalHunter(snapshot?: RelicPublicSnapshot, localPlayerId?: string): boolean {
    if (!snapshot || snapshot.phase === 'lobby') {
        return false;
    }
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);
    return !!localPlayer && !localPlayer.escaped && !localPlayer.defeated;
}

export function readStoredCameraMode(): RelicCameraMode | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    const value = window.localStorage?.getItem(CAMERA_MODE_STORAGE_KEY);
    return isRelicCameraMode(value) && value !== 'flyover' ? value : undefined;
}

function writeCameraModePreference(mode: RelicCameraMode): void {
    if (typeof window === 'undefined' || mode === 'flyover') {
        return;
    }
    window.localStorage?.setItem(CAMERA_MODE_STORAGE_KEY, mode);
}

function isRelicCameraMode(value: string | null): value is RelicCameraMode {
    return value === 'avatar' || value === 'first-person' || value === 'overview' || value === 'flyover';
}

export function readReducedMotionPreference(): boolean {
    return typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface RelicCameraFrame {
    readonly pose: NeonCameraPose;
    readonly smoothing: number;
}

export function updateCamera(runtime: RelicSceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    ensureCameraModeHasPlayer(runtime);
    const aspectRatio = runtime.engine.getRenderWidth() / Math.max(1, runtime.engine.getRenderHeight());
    const frame = updateCameraFrame(runtime, snapshot, aspectRatio);
    runtime.camera.position = runtime.terminal
        ? frame.pose.position
        : Vector3.Lerp(runtime.camera.position, frame.pose.position, frame.smoothing);
    runtime.camera.fov += (frame.pose.fov - runtime.camera.fov) * (runtime.terminal ? 1 : 0.14);
    runtime.camera.setTarget(frame.pose.target);
}

function updateCameraFrame(
    runtime: RelicSceneRuntime,
    snapshot: RelicPublicSnapshot,
    aspectRatio: number
): RelicCameraFrame {
    const reviewCue = !runtime.terminal && snapshot.phase === 'review' && !runtime.review.completed
        ? runtime.review.queue[runtime.review.index]?.cue
        : undefined;
    if (reviewCue) {
        return {
            pose: planNeonTacticalCameraPose({
                snapshot,
                aspectRatio,
                localPlayerId: runtime.localPlayerId.value,
                selectedRoomId: reviewCue.roomId ?? roomIdForCuePlayer(snapshot, reviewCue.playerId),
                focusRoomId: reviewCue.roomId ?? roomIdForCuePlayer(snapshot, reviewCue.playerId)
            }),
            smoothing: 0.26
        };
    }
    const localAvatar = runtime.localPlayerId.value ? runtime.avatars.get(runtime.localPlayerId.value) : undefined;
    if (
        isAvatarCameraMode(runtime.cameraMode.value) && localAvatar &&
        hasPlayableLocalHunter(snapshot, runtime.localPlayerId.value)
    ) {
        const input = {
            avatarPosition: localAvatar.root.position,
            cameraYaw: runtime.cameraYaw.value,
            cameraPitch: runtime.cameraPitch.value
        };
        return runtime.cameraMode.value === 'first-person'
            ? { pose: planNeonFirstPersonCameraPose(input), smoothing: 0.56 }
            : { pose: planNeonAvatarCameraPose(input), smoothing: 0.28 };
    }
    return runtime.cameraMode.value === 'flyover' && !runtime.terminal
        ? updateFlyoverCamera(runtime, snapshot, aspectRatio)
        : { pose: planNeonOverviewCameraPose({ snapshot, aspectRatio }), smoothing: CAMERA_SMOOTHING };
}

function updateFlyoverCamera(
    runtime: RelicSceneRuntime,
    snapshot: RelicPublicSnapshot,
    aspectRatio: number
): RelicCameraFrame {
    const startedAt = runtime.flyoverStartedAtMs.value ?? performance.now();
    runtime.flyoverStartedAtMs.value = startedAt;
    const progress = Math.min(1, (performance.now() - startedAt) / runtime.flyoverDurationMs.value);
    const pose = planNeonFlyoverCameraPose({ snapshot, progress, aspectRatio });
    if (progress >= 1) {
        changeRuntimeCameraMode(runtime, runtime.previousCameraMode.value);
    }
    return { pose, smoothing: runtime.reducedMotion.value ? 0.72 : 0.2 };
}

export function isAvatarCameraMode(mode: RelicCameraMode): boolean {
    return mode === 'avatar' || mode === 'first-person';
}

const CAMERA_SMOOTHING = 0.12;

const CAMERA_MODE_STORAGE_KEY = 'relic.sceneNext.cameraMode';
