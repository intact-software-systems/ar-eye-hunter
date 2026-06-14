import type { Vec3Tuple } from './types.ts';

export type InputDeviceKind = 'keyboard-mouse' | 'touch' | 'gamepad' | 'gyro-touch';

export type Point2 = Readonly<{
    x: number;
    y: number;
}>;

export type MobileControlSettings = Readonly<{
    touchSensitivity: number;
    invertY: boolean;
    buttonScale: number;
    gyroEnabled: boolean;
    hapticsEnabled: boolean;
}>;

export type TouchControlState = Readonly<{
    movePointerId?: number;
    lookPointerId?: number;
    moveOrigin?: Point2;
    moveCurrent?: Point2;
    lookLast?: Point2;
    lookActive: boolean;
    lastInputMode: InputDeviceKind;
}>;

export type TouchControlDiagnostics = Readonly<{
    movePointerId?: number;
    lookPointerId?: number;
    moveVector: Vec3Tuple;
    lookActive: boolean;
    lastInputMode: InputDeviceKind;
}>;

export type VirtualStickResult = Readonly<{
    moveX: number;
    moveZ: number;
    knobX: number;
    knobY: number;
    magnitude: number;
    sprint: boolean;
}>;

export type TouchAimAssistSettings = Readonly<{
    eyeRadiusPx: number;
    playerRadiusPx: number;
}>;

export type TouchAimCandidate = Readonly<{
    id: string;
    kind: 'eye' | 'player';
    screen: Point2;
    world: Vec3Tuple;
    distance: number;
    blocked: boolean;
}>;

export type TouchShotIntent = Readonly<{
    point: Point2;
    candidates: readonly TouchAimCandidate[];
    settings?: Partial<TouchAimAssistSettings>;
}>;

export const MOBILE_SETTINGS_STORAGE_KEY = 'ar-eye-hunter.mobile-controls.v1';

const DEFAULT_SETTINGS: MobileControlSettings = {
    touchSensitivity: 1,
    invertY: false,
    buttonScale: 1,
    gyroEnabled: false,
    hapticsEnabled: true,
};

const STICK_DEADZONE = 0.16;
const SPRINT_THRESHOLD = 0.82;
const TOUCH_YAW_SCALE = 0.0027;
const TOUCH_PITCH_SCALE = 0.00225;
const DEFAULT_TOUCH_AIM_ASSIST: TouchAimAssistSettings = {
    eyeRadiusPx: 48,
    playerRadiusPx: 28,
};

export function createDefaultMobileControlSettings(): MobileControlSettings {
    return DEFAULT_SETTINGS;
}

export function createInitialTouchControlState(): TouchControlState {
    return {
        lookActive: false,
        lastInputMode: 'keyboard-mouse',
    };
}

export function calculateVirtualStick(
    origin: Point2,
    current: Point2,
    radius: number,
): VirtualStickResult {
    const safeRadius = Math.max(1, radius);
    const rawX = current.x - origin.x;
    const rawY = current.y - origin.y;
    const rawDistance = Math.hypot(rawX, rawY);
    const clampedDistance = Math.min(safeRadius, rawDistance);
    const directionX = rawDistance > 0 ? rawX / rawDistance : 0;
    const directionY = rawDistance > 0 ? rawY / rawDistance : 0;
    const normalized = clampedDistance / safeRadius;
    const magnitude = normalized <= STICK_DEADZONE
        ? 0
        : (normalized - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    const moveX = cleanZero(round3(directionX * magnitude));
    const moveZ = cleanZero(round3(-directionY * magnitude));

    return {
        moveX,
        moveZ,
        knobX: cleanZero(round3(directionX * clampedDistance)),
        knobY: cleanZero(round3(directionY * clampedDistance)),
        magnitude: cleanZero(round3(magnitude)),
        sprint: normalized >= SPRINT_THRESHOLD,
    };
}

export function updateTouchPointer(
    state: TouchControlState,
    role: 'move' | 'look',
    pointerId: number,
    point: Point2,
): TouchControlState {
    if (role === 'move') {
        const samePointer = state.movePointerId === pointerId;
        return {
            ...state,
            movePointerId: pointerId,
            moveOrigin: samePointer ? state.moveOrigin ?? point : point,
            moveCurrent: point,
            lastInputMode: 'touch',
        };
    }

    return {
        ...state,
        lookPointerId: pointerId,
        lookLast: point,
        lookActive: true,
        lastInputMode: state.lastInputMode === 'gyro-touch' ? 'gyro-touch' : 'touch',
    };
}

export function resetTouchPointer(
    state: TouchControlState,
    pointerId: number,
): TouchControlState {
    let next = state;
    if (state.movePointerId === pointerId) {
        next = {
            ...next,
            movePointerId: undefined,
            moveOrigin: undefined,
            moveCurrent: undefined,
        };
    }
    if (state.lookPointerId === pointerId) {
        next = {
            ...next,
            lookPointerId: undefined,
            lookLast: undefined,
            lookActive: false,
        };
    }
    return next;
}

export function mapTouchLookDelta(
    deltaX: number,
    deltaY: number,
    settings: MobileControlSettings,
): Readonly<{ yawDelta: number; pitchDelta: number }> {
    const sensitivity = clamp(settings.touchSensitivity, 0.35, 2.4);
    return {
        yawDelta: round6(deltaX * TOUCH_YAW_SCALE * sensitivity),
        pitchDelta: round6(deltaY * TOUCH_PITCH_SCALE * sensitivity * (settings.invertY ? -1 : 1)),
    };
}

export function shouldFireHeldWeapon(
    fireHeld: boolean,
    nowEpochMs: number,
    shotReadyAtEpochMs: number,
): boolean {
    return fireHeld && nowEpochMs >= shotReadyAtEpochMs;
}

export function chooseTouchAimCandidate(
    intent: TouchShotIntent,
): TouchAimCandidate | undefined {
    const settings = {
        ...DEFAULT_TOUCH_AIM_ASSIST,
        ...intent.settings,
    };
    let best: Readonly<{ candidate: TouchAimCandidate; score: number }> | undefined;
    for (const candidate of intent.candidates) {
        if (candidate.blocked) {
            continue;
        }
        const radius = candidate.kind === 'eye'
            ? settings.eyeRadiusPx
            : settings.playerRadiusPx;
        const pixelDistance = Math.hypot(
            candidate.screen.x - intent.point.x,
            candidate.screen.y - intent.point.y,
        );
        if (pixelDistance > radius) {
            continue;
        }
        const eyeAssistBonus = candidate.kind === 'eye' ? 0.28 : 0;
        const score = pixelDistance / Math.max(1, radius) + candidate.distance * 0.001 - eyeAssistBonus;
        if (!best || score < best.score) {
            best = { candidate, score };
        }
    }
    return best?.candidate;
}

export function loadMobileControlSettings(
    read: (key: string) => string | null,
): MobileControlSettings {
    const raw = read(MOBILE_SETTINGS_STORAGE_KEY);
    if (!raw) {
        return createDefaultMobileControlSettings();
    }
    try {
        const value = JSON.parse(raw) as Partial<MobileControlSettings>;
        return normalizeMobileControlSettings(value);
    } catch {
        return createDefaultMobileControlSettings();
    }
}

export function saveMobileControlSettings(
    settings: MobileControlSettings,
    write: (key: string, value: string) => void,
): void {
    write(MOBILE_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeMobileControlSettings(settings)));
}

export function normalizeMobileControlSettings(
    value: Partial<MobileControlSettings>,
): MobileControlSettings {
    return {
        touchSensitivity: round2(clamp(
            typeof value.touchSensitivity === 'number' ? value.touchSensitivity : DEFAULT_SETTINGS.touchSensitivity,
            0.35,
            2.4,
        )),
        invertY: Boolean(value.invertY),
        buttonScale: round2(clamp(
            typeof value.buttonScale === 'number' ? value.buttonScale : DEFAULT_SETTINGS.buttonScale,
            0.72,
            1.35,
        )),
        gyroEnabled: Boolean(value.gyroEnabled),
        hapticsEnabled: value.hapticsEnabled === undefined
            ? DEFAULT_SETTINGS.hapticsEnabled
            : Boolean(value.hapticsEnabled),
    };
}

export function createTouchControlDiagnostics(
    state: TouchControlState,
    stick: VirtualStickResult,
): TouchControlDiagnostics {
    return {
        movePointerId: state.movePointerId,
        lookPointerId: state.lookPointerId,
        moveVector: [stick.moveX, 0, stick.moveZ],
        lookActive: state.lookActive,
        lastInputMode: state.lastInputMode,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}

function cleanZero(value: number): number {
    return Object.is(value, -0) ? 0 : value;
}
