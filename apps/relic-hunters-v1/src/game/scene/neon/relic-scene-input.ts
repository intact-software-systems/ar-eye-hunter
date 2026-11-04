import { type PointerInfo } from '@babylonjs/core/Events/pointerEvents.js';
import { type Observer } from '@babylonjs/core/Misc/observable.js';

import { sceneMoveActionForPickedRoom } from '../movement.ts';
import { directionBetweenRooms } from '../prompts.ts';
import { blackHumourSignForRoom } from '../relic-scene-model.ts';
import { changeRuntimeCameraMode, cycleRuntimeCameraMode, isAvatarCameraMode } from './relic-camera.ts';
import { updateRoomHighlights } from './relic-facility.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { clamp, wrapAngle } from './relic-scene-space.ts';

const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright', 'shift']);

export interface PointerLookState {
    active: boolean;
    pointerId: number | undefined;
    lastX: number;
    lastY: number;
}

/** Owns browser and Babylon input registration for one completed graphics lifetime. */
export class RelicSceneInput {
    private readonly runtime: RelicSceneRuntime;
    private picking: Observer<PointerInfo> | null = null;
    private readonly keydown = (event: KeyboardEvent) => this.pressKey(event);
    private readonly keyup = (event: KeyboardEvent) => this.runtime.pressedKeys.delete(event.key.toLowerCase());
    private readonly pointerdown = (event: PointerEvent) => this.startLook(event);
    private readonly pointermove = (event: PointerEvent) => this.moveLook(event);
    private readonly pointerup = (event: PointerEvent) => this.stopLook(event);
    private readonly pointerlockchange = () => {
        this.runtime.pointerLook.active = !this.runtime.terminal &&
            document.pointerLockElement === this.runtime.canvas;
    };
    private readonly pick = (event: PointerInfo) => this.pickTarget(event);

    constructor(runtime: RelicSceneRuntime) {
        this.runtime = runtime;
    }

    start(): void {
        const canvas = this.runtime.canvas;
        window.addEventListener('keydown', this.keydown);
        window.addEventListener('keyup', this.keyup);
        canvas.addEventListener('pointerdown', this.pointerdown);
        canvas.addEventListener('pointermove', this.pointermove);
        canvas.addEventListener('pointerup', this.pointerup);
        canvas.addEventListener('pointercancel', this.pointerup);
        document.addEventListener('pointerlockchange', this.pointerlockchange);
        this.picking = this.runtime.scene.onPointerObservable.add(this.pick);
    }

    dispose(): void {
        const canvas = this.runtime.canvas;
        window.removeEventListener('keydown', this.keydown);
        window.removeEventListener('keyup', this.keyup);
        canvas.removeEventListener('pointerdown', this.pointerdown);
        canvas.removeEventListener('pointermove', this.pointermove);
        canvas.removeEventListener('pointerup', this.pointerup);
        canvas.removeEventListener('pointercancel', this.pointerup);
        document.removeEventListener('pointerlockchange', this.pointerlockchange);
        this.runtime.scene.onPointerObservable.remove(this.picking);
        this.reset();
    }

    reset(): void {
        const { canvas, pointerLook, pressedKeys } = this.runtime;
        pressedKeys.clear();
        if (pointerLook.pointerId !== undefined && canvas.hasPointerCapture?.(pointerLook.pointerId)) {
            canvas.releasePointerCapture(pointerLook.pointerId);
        }
        pointerLook.active = false;
        pointerLook.pointerId = undefined;
        if (document.pointerLockElement === canvas) {
            document.exitPointerLock();
        }
    }

    private pressKey(event: KeyboardEvent): void {
        const runtime = this.runtime;
        if (runtime.terminal || !runtime.inputEnabled.value || isTypingTarget(event.target)) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === 'e' && runtime.nearbyRelic.value) {
            runtime.onPickupRelic.value(runtime.nearbyRelic.value.relicId);
        }
        else if (isCameraModeCycleKey(key)) {
            cycleRuntimeCameraMode(runtime);
        }
        else if (isFlyoverKey(key)) {
            changeRuntimeCameraMode(runtime, 'flyover');
        }
        else if (isCameraRotateKey(key) || MOVEMENT_KEYS.has(key)) {
            runtime.pressedKeys.add(key);
        }
        else {
            return;
        }
        runtime.canvas.focus();
        event.preventDefault();
    }

    private startLook(event: PointerEvent): void {
        const runtime = this.runtime;
        if (runtime.terminal || !runtime.inputEnabled.value) {
            return;
        }
        runtime.canvas.focus();
        if (!isAvatarCameraMode(runtime.cameraMode.value)) {
            return;
        }
        runtime.pointerLook.active = true;
        runtime.pointerLook.pointerId = event.pointerId;
        runtime.pointerLook.lastX = event.clientX;
        runtime.pointerLook.lastY = event.clientY;
        runtime.canvas.setPointerCapture?.(event.pointerId);
    }

    private moveLook(event: PointerEvent): void {
        const runtime = this.runtime;
        if (runtime.terminal || !runtime.inputEnabled.value) {
            return;
        }
        if (document.pointerLockElement === runtime.canvas) {
            applyCameraLook(runtime, event.movementX, event.movementY);
            event.preventDefault();
            return;
        }
        if (!runtime.pointerLook.active || runtime.pointerLook.pointerId !== event.pointerId) {
            return;
        }
        applyCameraLook(runtime, event.clientX - runtime.pointerLook.lastX, event.clientY - runtime.pointerLook.lastY);
        runtime.pointerLook.lastX = event.clientX;
        runtime.pointerLook.lastY = event.clientY;
        event.preventDefault();
    }

    private stopLook(event: PointerEvent): void {
        const { canvas, pointerLook } = this.runtime;
        if (pointerLook.pointerId !== event.pointerId) {
            return;
        }
        pointerLook.active = false;
        pointerLook.pointerId = undefined;
        if (canvas.hasPointerCapture?.(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
    }

    private pickTarget(event: PointerInfo): void {
        const runtime = this.runtime;
        if (event.event.type !== 'pointerdown' || runtime.terminal || !runtime.inputEnabled.value) {
            return;
        }
        const metadata: unknown = event.pickInfo?.pickedMesh?.metadata;
        if (!metadata || typeof metadata !== 'object') {
            return;
        }
        if ('relicId' in metadata && typeof metadata.relicId === 'string') {
            runtime.onPickupRelic.value(metadata.relicId);
            return;
        }
        if ('primeAction' in metadata && metadata.primeAction === 'search') {
            runtime.onPrimeAction.value({ kind: 'search' });
            return;
        }
        if (!('roomId' in metadata) || typeof metadata.roomId !== 'string') {
            return;
        }
        const roomId = metadata.roomId;
        const move = sceneMoveActionForPickedRoom({
            snapshot: runtime.snapshot.value,
            localPlayerId: runtime.localPlayerId.value,
            roomId
        });
        runtime.onSelectRoom.value(roomId);
        runtime.selectedRoomId.value = roomId;
        updatePromptForSelection(runtime, roomId);
        updateRoomHighlights(runtime);
        if (move) {
            runtime.onPrimeAction.value(move);
        }
    }
}

function isTypingTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function updatePromptForSelection(runtime: RelicSceneRuntime, roomId?: string): void {
    if (!runtime.inputEnabled.value || !roomId) {
        runtime.onPromptChange.value(undefined);
        return;
    }
    const snapshot = runtime.snapshot.value;
    const room = snapshot?.map.find((candidate) => candidate.id === roomId);
    if (!snapshot || !room) {
        runtime.onPromptChange.value(undefined);
        return;
    }
    const move = sceneMoveActionForPickedRoom({
        snapshot,
        localPlayerId: runtime.localPlayerId.value,
        roomId
    });
    if (move) {
        const localPlayer = snapshot.players.find((player) => player.playerId === runtime.localPlayerId.value);
        const localRoom = snapshot.map.find((candidate) => candidate.id === localPlayer?.roomId);
        runtime.onPromptChange.value({
            kind: 'move',
            roomId,
            roomName: room.name,
            direction: localRoom ? directionBetweenRooms(localRoom, room) : 'north'
        });
        return;
    }
    const localPlayer = snapshot.players.find((player) => player.playerId === runtime.localPlayerId.value);
    if (localPlayer?.roomId === roomId && snapshot.phase === 'planning') {
        runtime.onPromptChange.value({
            kind: 'search',
            label: blackHumourSignForRoom(room),
            detail: 'Inspect the room. The facility insists this counts as optimism.'
        });
        return;
    }
    runtime.onPromptChange.value(undefined);
}

function isCameraRotateKey(key: string): boolean {
    const value = key.toLowerCase();
    return value === 'q' || value === 'e';
}

function isCameraModeCycleKey(key: string): boolean {
    return key.toLowerCase() === 'c';
}

function isFlyoverKey(key: string): boolean {
    return key.toLowerCase() === 'f';
}

export function updateCameraYawFromKeys(runtime: RelicSceneRuntime): void {
    if (!isAvatarCameraMode(runtime.cameraMode.value)) {
        return;
    }
    const left = runtime.pressedKeys.has('q') ? 1 : 0;
    const right = runtime.pressedKeys.has('e') ? 1 : 0;
    if (left === right) {
        return;
    }
    runtime.cameraYaw.value = wrapAngle(runtime.cameraYaw.value + (left - right) * KEYBOARD_LOOK_STEP);
}

export function applyCameraLook(runtime: RelicSceneRuntime, deltaX: number, deltaY: number): void {
    if (!isAvatarCameraMode(runtime.cameraMode.value)) {
        return;
    }
    runtime.cameraYaw.value = wrapAngle(runtime.cameraYaw.value + deltaX * POINTER_LOOK_SENSITIVITY);
    runtime.cameraPitch.value = clamp(
        runtime.cameraPitch.value - deltaY * POINTER_LOOK_SENSITIVITY * 0.75,
        -0.72,
        0.72
    );
}

const POINTER_LOOK_SENSITIVITY = 0.006;

const KEYBOARD_LOOK_STEP = 0.055;
