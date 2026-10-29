import type { PointerEvent, RefObject } from 'react';
import {
    calculateVirtualStick,
    mapTouchLookDelta,
    resetTouchPointer,
    updateTouchPointer,
    type Point2
} from '../mobile-input.ts';
import type { MutableButtonAction, MutableInputState } from './arena-scene-contracts.ts';
import { createScanPulse } from './arena-scene-effects.ts';
import { triggerHaptic, unlockArenaAudio } from './arena-scene-feedback.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { applyLook } from './arena-scene-step.ts';
export interface ArenaStickView {
    readonly active: boolean;
    readonly knobX: number;
    readonly knobY: number;
}
export namespace ArenaTouchInput {
    export interface Input {
        readonly runtimeRef: RefObject<ArenaSceneRuntime | undefined>;
        readonly onStickChange: (view: ArenaStickView) => void;
        readonly localColor: string;
    }
}
const MOBILE_STICK_RADIUS = 72;
const EMPTY_TOUCH_STICK = calculateVirtualStick({ x: 0, y: 0 }, { x: 0, y: 0 }, MOBILE_STICK_RADIUS);
export class ArenaTouchInput {
    private readonly input: ArenaTouchInput.Input;
    constructor(input: ArenaTouchInput.Input) {
        this.input = input;
    }
    readonly updateMoveStick = (runtime: ArenaSceneRuntime): void => {
        const origin = runtime.touchState.moveOrigin;
        const current = runtime.touchState.moveCurrent;
        if (!origin || !current) {
            runtime.touchStick = EMPTY_TOUCH_STICK;
            runtime.input.moveX = 0;
            runtime.input.moveZ = 0;
            runtime.input.sprint = false;
            this.input.onStickChange({ active: false, knobX: 0, knobY: 0 });
            return;
        }
        const stick = calculateVirtualStick(origin, current, MOBILE_STICK_RADIUS);
        runtime.touchStick = stick;
        runtime.input.moveX = stick.moveX;
        runtime.input.moveZ = stick.moveZ;
        runtime.input.sprint = stick.sprint;
        runtime.inputDevice = runtime.mobileSettings.gyroEnabled ? 'gyro-touch' : 'touch';
        runtime.mobileControlsEnabled = true;
        this.input.onStickChange({
            active: true,
            knobX: stick.knobX,
            knobY: stick.knobY
        });
    };

    readonly pointFromPointer = (event: PointerEvent): Point2 => ({
        x: event.clientX,
        y: event.clientY
    });

    readonly onMovePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const runtime = this.input.runtimeRef.current;
        if (!runtime) {
            return;
        }
        unlockArenaAudio(runtime);
        safeSetPointerCapture(event.currentTarget, event.pointerId);
        runtime.touchState = updateTouchPointer({
            state: runtime.touchState,
            role: 'move',
            pointerId: event.pointerId,
            point: this.pointFromPointer(event)
        });
        this.updateMoveStick(runtime);
    };

    readonly onMovePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const runtime = this.input.runtimeRef.current;
        if (!runtime || runtime.touchState.movePointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        runtime.touchState = updateTouchPointer({
            state: runtime.touchState,
            role: 'move',
            pointerId: event.pointerId,
            point: this.pointFromPointer(event)
        });
        this.updateMoveStick(runtime);
    };

    readonly releasePointer = (event: PointerEvent<HTMLElement>) => {
        const runtime = this.input.runtimeRef.current;
        if (!runtime) {
            return;
        }
        runtime.touchState = resetTouchPointer(runtime.touchState, event.pointerId);
        if (!runtime.touchState.movePointerId) {
            this.updateMoveStick(runtime);
        }
        if (!runtime.touchState.lookPointerId) {
            runtime.inputDevice = 'touch';
        }
        safeReleasePointerCapture(event.currentTarget, event.pointerId);
    };

    readonly onLookPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const runtime = this.input.runtimeRef.current;
        if (!runtime) {
            return;
        }
        unlockArenaAudio(runtime);
        safeSetPointerCapture(event.currentTarget, event.pointerId);
        runtime.touchState = updateTouchPointer({
            state: runtime.touchState,
            role: 'look',
            pointerId: event.pointerId,
            point: this.pointFromPointer(event)
        });
        runtime.inputDevice = runtime.mobileSettings.gyroEnabled ? 'gyro-touch' : 'touch';
        runtime.mobileControlsEnabled = true;
    };

    readonly onLookPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const runtime = this.input.runtimeRef.current;
        if (!runtime || runtime.touchState.lookPointerId !== event.pointerId) {
            return;
        }
        const previous = runtime.touchState.lookLast;
        const point = this.pointFromPointer(event);
        if (previous) {
            const delta = mapTouchLookDelta(
                point.x - previous.x,
                point.y - previous.y,
                runtime.mobileSettings
            );
            applyLook(runtime, delta.yawDelta, delta.pitchDelta);
        }
        runtime.touchState = updateTouchPointer({
            state: runtime.touchState,
            role: 'look',
            pointerId: event.pointerId,
            point: point
        });
        event.preventDefault();
    };

    readonly onActionDown = (
        event: PointerEvent<HTMLButtonElement>,
        action: MutableButtonAction,
        mode: 'hold' | 'pulse'
    ) => {
        event.preventDefault();
        const runtime = this.input.runtimeRef.current;
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
            runtime.pulse(action, 120);
            return;
        }
        runtime.input[action] = true;
    };

    readonly onActionUp = (
        event: PointerEvent<HTMLButtonElement>,
        action: MutableButtonAction,
        mode: 'hold' | 'pulse'
    ) => {
        const runtime = this.input.runtimeRef.current;
        if (runtime && mode === 'hold') {
            runtime.input[action] = false;
        }
        safeReleasePointerCapture(event.currentTarget, event.pointerId);
    };

    readonly onScanDown = (event: PointerEvent<HTMLButtonElement>) => {
        this.onActionDown(event, 'altFire', 'hold');
        const runtime = this.input.runtimeRef.current;
        if (runtime) {
            createScanPulse(runtime, runtime.localPlayer.position, this.input.localColor);
        }
    };
}

export function setInputKey(input: MutableInputState, code: string, pressed: boolean): void {
    if (code === 'KeyW') {
        input.moveZ = pressed ? 1 : input.moveZ === 1 ? 0 : input.moveZ;
    }
    else if (code === 'KeyS') {
        input.moveZ = pressed ? -1 : input.moveZ === -1 ? 0 : input.moveZ;
    }
    else if (code === 'KeyA') {
        input.moveX = pressed ? -1 : input.moveX === -1 ? 0 : input.moveX;
    }
    else if (code === 'KeyD') {
        input.moveX = pressed ? 1 : input.moveX === 1 ? 0 : input.moveX;
    }
    else if (code === 'ShiftLeft' || code === 'ShiftRight') {
        input.sprint = pressed;
    }
    else if (code === 'Space') {
        input.jump = pressed;
    }
    else if (code === 'KeyE') {
        input.dash = pressed;
    }
    else if (code === 'ControlLeft' || code === 'KeyC') {
        input.slide = pressed;
    }
    else if (code === 'KeyQ') {
        input.overdrive = pressed;
    }
    else if (code === 'Escape') {
        input.pause = pressed;
    }
}
function safeSetPointerCapture(element: Element, pointerId: number): void {
    try {
        element.setPointerCapture?.(pointerId);
    }
    catch {
        // Synthetic mobile tests and some Safari edge cases can reject capture
        // for a pointer that has already ended. The input state still updates.
    }
}
function safeReleasePointerCapture(element: Element, pointerId: number): void {
    try {
        if (element.hasPointerCapture?.(pointerId)) {
            element.releasePointerCapture(pointerId);
        }
    }
    catch {
        // Best-effort cleanup; pointercancel/up also resets the logical state.
    }
}
