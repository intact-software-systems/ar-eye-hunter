import { distanceRallarMotionVec3, distanceRallarMotionWrappedVec3 } from './math.ts';
import type {
    RallarMotionSendGate,
    RallarMotionSendGateOptions,
    RallarMotionSendSampleLike,
    RallarMotionSendUpdateDecision,
    RallarMotionSendUpdateInput,
    RallarMotionSendUpdateReason
} from './types.ts';

export function shouldSendRallarMotionSample(
    nowEpochMs: number,
    nextAllowedEpochMs: number,
    cadenceMs: number
): boolean {
    return cadenceMs <= 0 || nowEpochMs >= nextAllowedEpochMs;
}

export function shouldSendRallarMotionUpdate(
    input: RallarMotionSendUpdateInput
): RallarMotionSendUpdateDecision {
    if (!input.lastSentSample || input.lastSentAtEpochMs === undefined) {
        return {
            shouldSend: true,
            reason: 'initial',
            nextAllowedEpochMs: input.nowEpochMs + normalizedCadence(input)
        };
    }

    const elapsedMs = input.nowEpochMs - input.lastSentAtEpochMs;
    if (
        input.forceSendAfterMs !== undefined &&
        elapsedMs >= input.forceSendAfterMs
    ) {
        return {
            shouldSend: true,
            reason: 'force',
            nextAllowedEpochMs: input.nowEpochMs + normalizedCadence(input)
        };
    }

    const movementReason = movementReasonFor(input);
    if (movementReason) {
        const cadenceMs = normalizedCadence(input);
        const nextAllowedEpochMs = input.lastSentAtEpochMs + cadenceMs;
        return {
            shouldSend: shouldSendRallarMotionSample(
                input.nowEpochMs,
                nextAllowedEpochMs,
                cadenceMs
            ),
            reason: input.nowEpochMs >= nextAllowedEpochMs
                ? movementReason
                : 'waiting',
            nextAllowedEpochMs
        };
    }

    const idleCadenceMs = Math.max(0, input.idleCadenceMs ?? 0);
    if (idleCadenceMs > 0) {
        const nextAllowedEpochMs = input.lastSentAtEpochMs + idleCadenceMs;
        return {
            shouldSend: input.nowEpochMs >= nextAllowedEpochMs,
            reason: input.nowEpochMs >= nextAllowedEpochMs ? 'idle' : 'waiting',
            nextAllowedEpochMs
        };
    }

    return {
        shouldSend: false,
        reason: 'waiting',
        nextAllowedEpochMs: input.lastSentAtEpochMs + normalizedCadence(input)
    };
}

export function createRallarMotionSendGate(
    options: RallarMotionSendGateOptions = {}
): RallarMotionSendGate {
    let lastSentSample: RallarMotionSendSampleLike | undefined;
    let lastSentAtEpochMs: number | undefined;

    return {
        check(sample, nowEpochMs): RallarMotionSendUpdateDecision {
            return shouldSendRallarMotionUpdate({
                ...options,
                nowEpochMs,
                lastSentAtEpochMs,
                lastSentSample,
                nextSample: sample
            });
        },
        recordSent(sample, nowEpochMs): void {
            lastSentSample = sample;
            lastSentAtEpochMs = nowEpochMs;
        },
        reset(): void {
            lastSentSample = undefined;
            lastSentAtEpochMs = undefined;
        }
    };
}

function movementReasonFor(
    input: RallarMotionSendUpdateInput
): Exclude<RallarMotionSendUpdateReason, 'initial' | 'force' | 'idle' | 'waiting'> | undefined {
    if (
        distanceRallarMotionVec3(
            input.lastSentSample!.position,
            input.nextSample.position
        ) > Math.max(0, input.minPositionDelta ?? 0)
    ) {
        return 'position';
    }

    if (
        input.lastSentSample!.rotation &&
        input.nextSample.rotation &&
        distanceRallarMotionWrappedVec3(
                input.lastSentSample!.rotation,
                input.nextSample.rotation,
                input.rotationWrap
            ) > Math.max(0, input.minRotationDelta ?? 0)
    ) {
        return 'rotation';
    }

    if (
        input.lastSentSample!.velocity &&
        input.nextSample.velocity &&
        distanceRallarMotionVec3(
                input.lastSentSample!.velocity,
                input.nextSample.velocity
            ) > Math.max(0, input.minVelocityDelta ?? 0)
    ) {
        return 'velocity';
    }

    return undefined;
}

function normalizedCadence(input: RallarMotionSendGateOptions): number {
    return Math.max(0, input.cadenceMs ?? 0);
}
