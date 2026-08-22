import type {
    RallarMotionQuantizedVec3,
    RallarMotionQuantizeVec3Options,
    RallarMotionRotationWrap,
    RallarMotionVec3
} from './types.ts';

export function addRallarMotionVec3(
    source: RallarMotionVec3,
    delta: RallarMotionVec3
): RallarMotionVec3 {
    return [
        source[0] + delta[0],
        source[1] + delta[1],
        source[2] + delta[2]
    ];
}

export function subtractRallarMotionVec3(
    source: RallarMotionVec3,
    target: RallarMotionVec3
): RallarMotionVec3 {
    return [
        source[0] - target[0],
        source[1] - target[1],
        source[2] - target[2]
    ];
}

export function scaleRallarMotionVec3(
    source: RallarMotionVec3,
    scalar: number
): RallarMotionVec3 {
    return [
        source[0] * scalar,
        source[1] * scalar,
        source[2] * scalar
    ];
}

export function lerpRallarMotionVec3(
    source: RallarMotionVec3,
    target: RallarMotionVec3,
    t: number
): RallarMotionVec3 {
    return [
        lerpRallarMotionNumber(source[0], target[0], t),
        lerpRallarMotionNumber(source[1], target[1], t),
        lerpRallarMotionNumber(source[2], target[2], t)
    ];
}

export function smoothRallarMotionVec3(
    previous: RallarMotionVec3,
    next: RallarMotionVec3,
    alpha: number
): RallarMotionVec3 {
    return lerpRallarMotionVec3(previous, next, clampRallarMotion01(alpha));
}

export function distanceRallarMotionVec3(
    source: RallarMotionVec3,
    target: RallarMotionVec3
): number {
    const dx = target[0] - source[0];
    const dy = target[1] - source[1];
    const dz = target[2] - source[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distanceRallarMotionWrappedVec3(
    source: RallarMotionVec3,
    target: RallarMotionVec3,
    wrap?: RallarMotionRotationWrap
): number {
    if (!wrap) {
        return distanceRallarMotionVec3(source, target);
    }

    const delta = shortestRallarMotionWrappedVec3Delta(source, target, wrap);
    return Math.sqrt(
        delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]
    );
}

export function wrapRallarMotionAngle(value: number, period: number): number {
    if (!Number.isFinite(period) || period <= 0) {
        return value;
    }

    return ((value % period) + period) % period;
}

export function shortestRallarMotionAngleDelta(
    source: number,
    target: number,
    period: number
): number {
    if (!Number.isFinite(period) || period <= 0) {
        return target - source;
    }

    const halfPeriod = period / 2;
    return wrapRallarMotionAngle(target - source + halfPeriod, period) -
        halfPeriod;
}

export function shortestRallarMotionWrappedVec3Delta(
    source: RallarMotionVec3,
    target: RallarMotionVec3,
    wrap: RallarMotionRotationWrap
): RallarMotionVec3 {
    return [
        shortestRallarMotionAngleDelta(
            source[0],
            target[0],
            periodAt(wrap.period, 0)
        ),
        shortestRallarMotionAngleDelta(
            source[1],
            target[1],
            periodAt(wrap.period, 1)
        ),
        shortestRallarMotionAngleDelta(
            source[2],
            target[2],
            periodAt(wrap.period, 2)
        )
    ];
}

export function interpolateRallarMotionWrappedEuler(
    source: RallarMotionVec3,
    target: RallarMotionVec3,
    t: number,
    wrap: RallarMotionRotationWrap
): RallarMotionVec3 {
    const delta = shortestRallarMotionWrappedVec3Delta(source, target, wrap);
    return [
        wrapRallarMotionAngle(source[0] + delta[0] * t, periodAt(wrap.period, 0)),
        wrapRallarMotionAngle(source[1] + delta[1] * t, periodAt(wrap.period, 1)),
        wrapRallarMotionAngle(source[2] + delta[2] * t, periodAt(wrap.period, 2))
    ];
}

export function roundRallarMotionVec3(
    source: RallarMotionVec3,
    precision = 3
): RallarMotionVec3 {
    const scale = 10 ** Math.max(0, Math.floor(precision));
    return [
        Math.round(source[0] * scale) / scale,
        Math.round(source[1] * scale) / scale,
        Math.round(source[2] * scale) / scale
    ];
}

export function quantizeRallarMotionVec3(
    source: RallarMotionVec3,
    options: RallarMotionQuantizeVec3Options
): RallarMotionQuantizedVec3 {
    const steps = normalizedQuantizeSteps(options);
    return [
        quantizeComponent(source[0], componentAt(options.min, 0), componentAt(options.max, 0), steps),
        quantizeComponent(source[1], componentAt(options.min, 1), componentAt(options.max, 1), steps),
        quantizeComponent(source[2], componentAt(options.min, 2), componentAt(options.max, 2), steps)
    ];
}

export function dequantizeRallarMotionVec3(
    source: RallarMotionQuantizedVec3,
    options: RallarMotionQuantizeVec3Options
): RallarMotionVec3 {
    const steps = normalizedQuantizeSteps(options);
    return [
        dequantizeComponent(source[0], componentAt(options.min, 0), componentAt(options.max, 0), steps),
        dequantizeComponent(source[1], componentAt(options.min, 1), componentAt(options.max, 1), steps),
        dequantizeComponent(source[2], componentAt(options.min, 2), componentAt(options.max, 2), steps)
    ];
}

export function lerpRallarMotionNumber(
    source: number,
    target: number,
    t: number
): number {
    return source + (target - source) * t;
}

export function clampRallarMotion01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function clampRallarMotionNumber(
    value: number,
    min: number,
    max: number
): number {
    return Math.max(min, Math.min(max, value));
}

export function sanitizeRallarMotionNonNegative(
    value: number | undefined,
    fallback: number
): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, value ?? fallback);
}

function componentAt(source: number | RallarMotionVec3, index: number): number {
    return typeof source === 'number' ? source : source[index];
}

function periodAt(source: number | RallarMotionVec3, index: number): number {
    return typeof source === 'number' ? source : source[index];
}

function normalizedQuantizeSteps(options: RallarMotionQuantizeVec3Options): number {
    if (options.bits !== undefined) {
        return Math.max(1, Math.floor(2 ** options.bits - 1));
    }
    return Math.max(1, Math.floor(options.steps ?? 65_535));
}

function quantizeComponent(
    value: number,
    min: number,
    max: number,
    steps: number
): number {
    if (max <= min) {
        return 0;
    }

    const t = clampRallarMotion01((value - min) / (max - min));
    return Math.round(t * steps);
}

function dequantizeComponent(
    value: number,
    min: number,
    max: number,
    steps: number
): number {
    if (max <= min) {
        return min;
    }

    return lerpRallarMotionNumber(min, max, clampRallarMotion01(value / steps));
}
