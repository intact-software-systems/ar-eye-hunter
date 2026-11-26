import {
    validateALPublicationPolicy,
    type ALPublicationPolicy
} from '@shared/al-contracts/publication/al-publication-policy.ts';
import { RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';

import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
import { RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS } from '../../../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger } from '../../../runtime/decode-runtime-result-values.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { computePublicationWorkloadFrameCount } from './compute-publication-workload-plan.ts';
import { computePublicationWorkloadMinimumPayloadBytes } from './to-publication-workload-payload.ts';

/** One point of the publication workload family. The family has no default for any field. */
export interface PublicationWorkloadParameters {
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** One publisher; every other agent subscribes. */
    readonly participantCount: number;
    readonly carrier: AlmConformanceCarrier;
    readonly publishIntervalMs: number;
    readonly windowMs: number;
    readonly publication: ALPublicationPolicy;
    /** The UTF-8 bytes of the serialised payload at the widest sequence number. */
    readonly payloadBytes: number;
    readonly ttlMs: number;
    readonly minReceiveRatio: number;
    readonly minSendSuccessRatio: number;
    readonly readyTimeoutMs: number;
}

export const PUBLICATION_WORKLOAD_LIMITS = {
    minParticipantCount: 2,
    maxParticipantCount: 50,
    /** The publisher's loop holds one send per frame, and a loop expands at most this many commands. */
    maxFrameCount: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands,
    maxPayloadBytes: RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES
} as const;

/**
 * A point whose window gives no whole frame count is sized against the one-frame template, the smallest any point
 * has, so its payload is reported only when no frame count could hold it.
 */
const SMALLEST_FRAME_COUNT = 1;

/**
 * Each field contributes the first bound it breaks. A bound stated against another field is checked only when that
 * field holds its own: a window is a multiple of nothing while the interval is no positive integer.
 */
export function validatePublicationWorkloadParameters(
    parameters: PublicationWorkloadParameters
): readonly RallarValidationIssue[] {
    return [
        validateParticipantCount(parameters.participantCount),
        validateCarrier(parameters.carrier),
        validatePublishIntervalMs(parameters),
        validateWindowMs(parameters),
        ...validateALPublicationPolicy(parameters.publication),
        validatePayloadBytes(parameters),
        validatePositiveInteger(parameters, 'ttlMs', 'invalid-ttl-ms'),
        validateShare(parameters, 'minReceiveRatio', 'invalid-min-receive-ratio'),
        validateShare(parameters, 'minSendSuccessRatio', 'invalid-min-send-success-ratio'),
        validatePositiveInteger(parameters, 'readyTimeoutMs', 'invalid-ready-timeout-ms')
    ].filter((issue) => issue !== undefined);
}

function validateParticipantCount(participantCount: number): RallarValidationIssue | undefined {
    const { minParticipantCount, maxParticipantCount } = PUBLICATION_WORKLOAD_LIMITS;
    return Number.isInteger(participantCount) &&
            participantCount >= minParticipantCount &&
            participantCount <= maxParticipantCount
        ? undefined
        : toIssue(
            'participantCount',
            'invalid-participant-count',
            `Expected an integer from ${minParticipantCount} to ${maxParticipantCount}: one publisher and its subscribers.`
        );
}

function validateCarrier(carrier: AlmConformanceCarrier): RallarValidationIssue | undefined {
    return ALM_CONFORMANCE_CARRIERS.includes(carrier)
        ? undefined
        : toIssue('carrier', 'invalid-carrier', `Expected one of ${ALM_CONFORMANCE_CARRIERS.join(', ')}.`);
}

function validatePublishIntervalMs(parameters: PublicationWorkloadParameters): RallarValidationIssue | undefined {
    const { publishIntervalMs, publication } = parameters;
    if (decodePositiveInteger(publishIntervalMs) === undefined) {
        return toIssue(
            'publishIntervalMs',
            'invalid-publish-interval-ms',
            'Expected a positive integer of milliseconds.'
        );
    }
    return publishIntervalMs < publication.cadenceMs
        ? toIssue(
            'publishIntervalMs',
            'publish-interval-below-cadence',
            `Expected at least the publication cadence of ${publication.cadenceMs} ms.`
        )
        : undefined;
}

function validateWindowMs(parameters: PublicationWorkloadParameters): RallarValidationIssue | undefined {
    if (decodePositiveInteger(parameters.windowMs) === undefined) {
        return toIssue('windowMs', 'invalid-window-ms', 'Expected a positive integer of milliseconds.');
    }
    if (decodePositiveInteger(parameters.publishIntervalMs) === undefined) {
        return undefined;
    }
    const frameCount = computePublicationWorkloadFrameCount(parameters);
    if (!Number.isInteger(frameCount)) {
        return toIssue(
            'windowMs',
            'window-not-multiple-of-publish-interval',
            `Expected a multiple of the publish interval of ${parameters.publishIntervalMs} ms.`
        );
    }
    return frameCount > PUBLICATION_WORKLOAD_LIMITS.maxFrameCount
        ? toIssue(
            'windowMs',
            'frame-count-above-limit',
            `Expected at most ${PUBLICATION_WORKLOAD_LIMITS.maxFrameCount} frames; the window holds ${frameCount}.`
        )
        : undefined;
}

function validatePayloadBytes(parameters: PublicationWorkloadParameters): RallarValidationIssue | undefined {
    const { payloadBytes } = parameters;
    if (!Number.isInteger(payloadBytes)) {
        return toIssue('payloadBytes', 'invalid-payload-bytes', 'Expected an integer of bytes.');
    }
    const minimumBytes = computePublicationWorkloadMinimumPayloadBytes(resolveSizedFrameCount(parameters));
    return payloadBytes < minimumBytes
        ? toIssue(
            'payloadBytes',
            'payload-bytes-below-template-minimum',
            `Expected at least ${minimumBytes} bytes, the payload with no filler at the widest sequence number.`
        )
        : validatePayloadBytesCeiling(parameters);
}

function validatePayloadBytesCeiling(parameters: PublicationWorkloadParameters): RallarValidationIssue | undefined {
    const { payloadBytes, publication } = parameters;
    if (payloadBytes > PUBLICATION_WORKLOAD_LIMITS.maxPayloadBytes) {
        return toIssue(
            'payloadBytes',
            'payload-bytes-above-message-limit',
            `Expected at most the message payload limit of ${PUBLICATION_WORKLOAD_LIMITS.maxPayloadBytes} bytes.`
        );
    }
    return payloadBytes > publication.drain.bytes
        ? toIssue(
            'payloadBytes',
            'payload-bytes-above-drain-bytes',
            `Expected at most the publication drain budget of ${publication.drain.bytes} bytes.`
        )
        : undefined;
}

function validatePositiveInteger(
    parameters: PublicationWorkloadParameters,
    field: 'ttlMs' | 'readyTimeoutMs',
    code: string
): RallarValidationIssue | undefined {
    return decodePositiveInteger(parameters[field]) === undefined
        ? toIssue(field, code, 'Expected a positive integer of milliseconds.')
        : undefined;
}

function validateShare(
    parameters: PublicationWorkloadParameters,
    field: 'minReceiveRatio' | 'minSendSuccessRatio',
    code: string
): RallarValidationIssue | undefined {
    const share = parameters[field];
    return share > 0 && share <= 1 ? undefined : toIssue(field, code, 'Expected a share above 0 and at most 1.');
}

function resolveSizedFrameCount(parameters: PublicationWorkloadParameters): number {
    const frameCount = computePublicationWorkloadFrameCount(parameters);
    return decodePositiveInteger(parameters.publishIntervalMs) !== undefined &&
            decodePositiveInteger(frameCount) !== undefined
        ? frameCount
        : SMALLEST_FRAME_COUNT;
}

function toIssue(
    field: keyof PublicationWorkloadParameters,
    code: string,
    message: string
): RallarValidationIssue {
    return { path: `$.${field}`, code, message };
}
