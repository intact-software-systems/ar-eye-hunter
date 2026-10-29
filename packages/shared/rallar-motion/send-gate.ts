import { computeCadenceBoundaryAtMs, isCadenceDue } from '../resilience/cadence.ts';
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
    return isCadenceDue({ boundaryAtMs: nextAllowedEpochMs, cadenceMs, nowMs: nowEpochMs });
}

export function shouldSendRallarMotionUpdate(
    input: RallarMotionSendUpdateInput
): RallarMotionSendUpdateDecision {
    if (!input.lastSentSample || input.lastSentAtEpochMs === undefined) {
        return {
            shouldSend: true,
            reason: 'initial',
            nextAllowedEpochMs: computeSentNextAllowedEpochMs(input)
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
            nextAllowedEpochMs: computeSentNextAllowedEpochMs(input)
        };
    }

    const movementReason = movementReasonFor(input);
    if (movementReason) {
        return decideMovementSend(input, input.lastSentAtEpochMs, movementReason);
    }

    const idleCadenceMs = Math.max(0, input.idleCadenceMs ?? 0);
    if (idleCadenceMs > 0) {
        return decideIdleSend(input, input.lastSentAtEpochMs, idleCadenceMs);
    }

    return {
        shouldSend: false,
        reason: 'waiting',
        nextAllowedEpochMs: computeCadenceBoundaryAtMs({
            lastAtMs: input.lastSentAtEpochMs,
            cadenceMs: normalizedCadence(input)
        })
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

function decideMovementSend(
    input: RallarMotionSendUpdateInput,
    lastSentAtEpochMs: number,
    movementReason: Exclude<RallarMotionSendUpdateReason, 'initial' | 'force' | 'idle' | 'waiting'>
): RallarMotionSendUpdateDecision {
    const cadenceMs = normalizedCadence(input);
    const nextAllowedEpochMs = computeCadenceBoundaryAtMs({ lastAtMs: lastSentAtEpochMs, cadenceMs });
    const due = isCadenceDue({ boundaryAtMs: nextAllowedEpochMs, cadenceMs, nowMs: input.nowEpochMs });
    return { shouldSend: due, reason: due ? movementReason : 'waiting', nextAllowedEpochMs };
}

function decideIdleSend(
    input: RallarMotionSendUpdateInput,
    lastSentAtEpochMs: number,
    idleCadenceMs: number
): RallarMotionSendUpdateDecision {
    const nextAllowedEpochMs = computeCadenceBoundaryAtMs({ lastAtMs: lastSentAtEpochMs, cadenceMs: idleCadenceMs });
    const due = isCadenceDue({ boundaryAtMs: nextAllowedEpochMs, cadenceMs: idleCadenceMs, nowMs: input.nowEpochMs });
    return { shouldSend: due, reason: due ? 'idle' : 'waiting', nextAllowedEpochMs };
}

function computeSentNextAllowedEpochMs(input: RallarMotionSendUpdateInput): number {
    return computeCadenceBoundaryAtMs({ lastAtMs: input.nowEpochMs, cadenceMs: normalizedCadence(input) });
}

function normalizedCadence(input: RallarMotionSendGateOptions): number {
    return Math.max(0, input.cadenceMs ?? 0);
}
