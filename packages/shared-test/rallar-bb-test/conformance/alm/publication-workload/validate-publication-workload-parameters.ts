import {
    validateALPublicationPolicy,
    type ALPublicationPolicy
} from '@shared/al-contracts/publication/al-publication-policy.ts';
import {
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    validateRallarGroupRef,
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';

import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
import { RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS } from '../../../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger } from '../../../runtime/decode-runtime-result-values.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { computePublicationWorkloadFrameCount } from './compute-publication-workload-plan.ts';
import { computePublicationWorkloadMinimumPayloadBytes } from './to-publication-workload-payload.ts';

/** One point of the publication workload family. The family has no default for any field. */
export interface PublicationWorkloadParameters {
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** The agents of the room: its publishers and its subscribers. */
    readonly participantCount: number;
    /** The agents of the room that publish. Every other agent only subscribes, and at least one does. */
    readonly publisherCount: number;
    readonly carrier: AlmConformanceCarrier;
    readonly publishIntervalMs: number;
    readonly windowMs: number;
    readonly publication: ALPublicationPolicy;
    /** The UTF-8 bytes of the serialised payload at the widest sequence number. */
    readonly payloadBytes: number;
    readonly ttlMs: number;
    readonly minReceiveRatio: number;
    /**
     * The share of the frames the publisher's publication stage must hand to a carrier. A frame the stage refused,
     * displaced or let expire is no success, though its send command returned.
     */
    readonly minSendSuccessRatio: number;
    readonly readyTimeoutMs: number;
}

const PUBLICATION_WORKLOAD_LIMITS = {
    minParticipantCount: 2,
    maxParticipantCount: 50,
    /** The publisher's loop holds one send per frame, and a loop expands at most this many commands. */
    maxFrameCount: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands,
    maxPayloadBytes: RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES
} as const;

/**
 * A point with no whole frame count within the limit is sized against the one-frame template, the smallest any point
 * has, so its payload is reported only when no frame count could hold it.
 */
const SMALLEST_FRAME_COUNT = 1;

/**
 * A field contributes the first bound it breaks; `group` and `publication` contribute every issue of their own
 * validators. A bound stated against another field is checked only when that other field holds its own bound.
 */
export function validatePublicationWorkloadParameters(
    parameters: PublicationWorkloadParameters
): readonly RallarValidationIssue[] {
    const publicationIssues = validateALPublicationPolicy(parameters.publication);
    const wholeFrameCount = resolveWholeFrameCount(parameters);
    return [
        ...validateRallarGroupRef(parameters.group, '$.group').issues,
        validateParticipantCount(parameters.participantCount),
        validatePublisherCount(parameters),
        validateCarrier(parameters.carrier),
        validatePublishIntervalMs(parameters, publicationIssues),
        validateWindowMs(parameters, wholeFrameCount),
        ...publicationIssues,
        validatePayloadBytes(parameters, wholeFrameCount, publicationIssues),
        validatePositiveMilliseconds(parameters, 'ttlMs', 'invalid-ttl-ms'),
        validateShare(parameters, 'minReceiveRatio', 'invalid-min-receive-ratio'),
        validateShare(parameters, 'minSendSuccessRatio', 'invalid-min-send-success-ratio'),
        validatePositiveMilliseconds(parameters, 'readyTimeoutMs', 'invalid-ready-timeout-ms')
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
            `Expected an integer from ${minParticipantCount} to ${maxParticipantCount}: the publishers and the subscribers.`
        );
}

/** The last agent of a room subscribes, so the publishers are one fewer than the agents at most. */
function validatePublisherCount(parameters: PublicationWorkloadParameters): RallarValidationIssue | undefined {
    const { participantCount, publisherCount } = parameters;
    if (decodePositiveInteger(publisherCount) === undefined) {
        return toIssue('publisherCount', 'invalid-publisher-count', 'Expected an integer of at least 1.');
    }
    return validateParticipantCount(participantCount) === undefined && publisherCount >= participantCount
        ? toIssue(
            'publisherCount',
            'publisher-count-leaves-no-subscriber',
            `Expected at most ${participantCount - 1}, so that one of the ${participantCount} agents subscribes.`
        )
        : undefined;
}

function validateCarrier(carrier: AlmConformanceCarrier): RallarValidationIssue | undefined {
    return ALM_CONFORMANCE_CARRIERS.includes(carrier)
        ? undefined
        : toIssue('carrier', 'invalid-carrier', `Expected one of ${ALM_CONFORMANCE_CARRIERS.join(', ')}.`);
}

function validatePublishIntervalMs(
    parameters: PublicationWorkloadParameters,
    publicationIssues: readonly RallarValidationIssue[]
): RallarValidationIssue | undefined {
    const { publishIntervalMs, publication } = parameters;
    const ownIssue = validatePositiveMilliseconds(parameters, 'publishIntervalMs', 'invalid-publish-interval-ms');
    if (ownIssue !== undefined) {
        return ownIssue;
    }
    return hasNoIssueAt(publicationIssues, '$.publication.cadenceMs') && publishIntervalMs < publication.cadenceMs
        ? toIssue(
            'publishIntervalMs',
            'publish-interval-below-cadence',
            `Expected at least the publication cadence of ${publication.cadenceMs} ms.`
        )
        : undefined;
}

function validateWindowMs(
    parameters: PublicationWorkloadParameters,
    wholeFrameCount: number | undefined
): RallarValidationIssue | undefined {
    const { publishIntervalMs } = parameters;
    const { maxFrameCount } = PUBLICATION_WORKLOAD_LIMITS;
    const ownIssue = validatePositiveMilliseconds(parameters, 'windowMs', 'invalid-window-ms');
    if (ownIssue !== undefined) {
        return ownIssue;
    }
    if (decodePositiveInteger(publishIntervalMs) === undefined) {
        return undefined;
    }
    if (wholeFrameCount === undefined) {
        return toIssue(
            'windowMs',
            'window-not-multiple-of-publish-interval',
            `Expected a multiple of the publish interval of ${publishIntervalMs} ms.`
        );
    }
    return wholeFrameCount > maxFrameCount
        ? toIssue(
            'windowMs',
            'frame-count-above-limit',
            `Expected at most ${maxFrameCount} frames; the window holds ${wholeFrameCount}.`
        )
        : undefined;
}

function validatePayloadBytes(
    parameters: PublicationWorkloadParameters,
    wholeFrameCount: number | undefined,
    publicationIssues: readonly RallarValidationIssue[]
): RallarValidationIssue | undefined {
    const { payloadBytes } = parameters;
    if (!Number.isInteger(payloadBytes)) {
        return toIssue('payloadBytes', 'invalid-payload-bytes', 'Expected an integer of bytes.');
    }
    const sizedFrameCount =
        wholeFrameCount !== undefined && wholeFrameCount <= PUBLICATION_WORKLOAD_LIMITS.maxFrameCount
            ? wholeFrameCount
            : SMALLEST_FRAME_COUNT;
    const minimumBytes = computePublicationWorkloadMinimumPayloadBytes(sizedFrameCount);
    return payloadBytes < minimumBytes
        ? toIssue(
            'payloadBytes',
            'payload-bytes-below-template-minimum',
            `Expected at least ${minimumBytes} bytes, the payload with no filler at the widest sequence number.`
        )
        : validatePayloadBytesCeiling(parameters, publicationIssues);
}

function validatePayloadBytesCeiling(
    parameters: PublicationWorkloadParameters,
    publicationIssues: readonly RallarValidationIssue[]
): RallarValidationIssue | undefined {
    const { payloadBytes, publication } = parameters;
    if (payloadBytes > PUBLICATION_WORKLOAD_LIMITS.maxPayloadBytes) {
        return toIssue(
            'payloadBytes',
            'payload-bytes-above-message-limit',
            `Expected at most the message payload limit of ${PUBLICATION_WORKLOAD_LIMITS.maxPayloadBytes} bytes.`
        );
    }
    return hasNoIssueAt(publicationIssues, '$.publication.drain.bytes') && payloadBytes > publication.drain.bytes
        ? toIssue(
            'payloadBytes',
            'payload-bytes-above-drain-bytes',
            `Expected at most the publication drain budget of ${publication.drain.bytes} bytes.`
        )
        : undefined;
}

function validatePositiveMilliseconds(
    parameters: PublicationWorkloadParameters,
    field: 'publishIntervalMs' | 'windowMs' | 'ttlMs' | 'readyTimeoutMs',
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

/** Whole frames of a positive whole interval: the window is then that many intervals, so it holds its own bound too. */
function resolveWholeFrameCount(parameters: PublicationWorkloadParameters): number | undefined {
    return decodePositiveInteger(parameters.publishIntervalMs) === undefined
        ? undefined
        : decodePositiveInteger(computePublicationWorkloadFrameCount(parameters));
}

function hasNoIssueAt(issues: readonly RallarValidationIssue[], path: string): boolean {
    return issues.every((issue) => issue.path !== path);
}

function toIssue(
    field: keyof PublicationWorkloadParameters,
    code: string,
    message: string
): RallarValidationIssue {
    return { path: `$.${field}`, code, message };
}
