import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';

import type { RallarBlackBoxTestRecord } from '../../../rallar-black-box-test-contracts.ts';

import { computePublicationWorkloadFrameCount } from './compute-publication-workload-plan.ts';
import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

/** The payload field that carries the publisher's clock at the send, which a receiver's sample age is read from. */
export const PUBLICATION_WORKLOAD_SENT_AT_FIELD = 'sentAtEpochMs';

/** A loop child resolves a string that is exactly one placeholder to a number, so each serialises as bare digits. */
const SEQUENCE_PLACEHOLDER = '{loop.iteration}';
const SENT_AT_PLACEHOLDER = '{loop.atEpochMs}';

/** An epoch in milliseconds has 13 digits from September 2001 to November 2286. */
const WIDEST_SENT_AT_EPOCH_MS = 9_999_999_999_999;

/** The serialised bytes of the payload with no filler, at the frame count as the widest sequence number. */
export function computePublicationWorkloadMinimumPayloadBytes(frameCount: number): number {
    return computeUtf8ByteLength(JSON.stringify(toPayloadFields(frameCount, WIDEST_SENT_AT_EPOCH_MS, '')));
}

/**
 * Defined for a point `validatePublicationWorkloadParameters` passes. The filler brings the last frame to
 * `payloadBytes`; an earlier frame is smaller by the digits its sequence number lacks.
 */
export function toPublicationWorkloadPayload(parameters: PublicationWorkloadParameters): RallarBlackBoxTestRecord {
    const frameCount = computePublicationWorkloadFrameCount(parameters);
    const fillerBytes = parameters.payloadBytes - computePublicationWorkloadMinimumPayloadBytes(frameCount);
    return toPayloadFields(SEQUENCE_PLACEHOLDER, SENT_AT_PLACEHOLDER, 'x'.repeat(fillerBytes));
}

function toPayloadFields(
    sequence: number | string,
    sentAtEpochMs: number | string,
    pad: string
): RallarBlackBoxTestRecord {
    return { seq: sequence, [PUBLICATION_WORKLOAD_SENT_AT_FIELD]: sentAtEpochMs, pad };
}
