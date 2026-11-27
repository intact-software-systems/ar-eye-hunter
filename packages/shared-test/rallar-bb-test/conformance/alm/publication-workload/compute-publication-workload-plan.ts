import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

/** What one point of the family sends and expects, in whole messages. */
export interface PublicationWorkloadPlan {
    /** The frames one publisher sends. */
    readonly frameCount: number;
    /** One publisher's rate. Derived from the integer interval, so it is not rounded. */
    readonly configuredRateHz: number;
    /** The agents of the room that only subscribe. */
    readonly subscriberCount: number;
    /** The frames one publisher's publication stage is expected to hand to a carrier. */
    readonly expectedAdmissions: number;
    /**
     * What one subscriber is to receive, in the words of the artifact analysis's `ReceiverDeliverySpec`: the expected
     * admissions of every publisher of its room together.
     */
    readonly expectedInboundMessages: number;
    /** The fewest of them that reach `minReceiveRatio`, again for one subscriber. */
    readonly minExpectedInboundMessages: number;
    /**
     * The fewest of one publisher's expected admissions that reach `minSendSuccessRatio`. A send is accepted when the
     * publisher's publication stage handed its value to a carrier, the stage's `admitted` counter; a send the harness
     * submitted is not yet one.
     */
    readonly minAcceptedSends: number;
    /** Every publisher's expected admissions to every other member of the room, publishers included. */
    readonly logicalFanoutMessages: number;
}

/** One frame per send: a whole number only when the window is a multiple of the interval. */
export function computePublicationWorkloadFrameCount(
    parameters: Pick<PublicationWorkloadParameters, 'windowMs' | 'publishIntervalMs'>
): number {
    return parameters.windowMs / parameters.publishIntervalMs;
}

/** Defined for a point `validatePublicationWorkloadParameters` passes. */
export function computePublicationWorkloadPlan(parameters: PublicationWorkloadParameters): PublicationWorkloadPlan {
    const { participantCount, publisherCount } = parameters;
    const frameCount = computePublicationWorkloadFrameCount(parameters);
    const expectedAdmissions = frameCount;
    const expectedInboundMessages = expectedAdmissions * publisherCount;
    return {
        frameCount,
        configuredRateHz: 1_000 / parameters.publishIntervalMs,
        subscriberCount: participantCount - publisherCount,
        expectedAdmissions,
        expectedInboundMessages,
        minExpectedInboundMessages: computeMinimumCount(expectedInboundMessages, parameters.minReceiveRatio),
        minAcceptedSends: computeMinimumCount(expectedAdmissions, parameters.minSendSuccessRatio),
        logicalFanoutMessages: expectedInboundMessages * (participantCount - 1)
    };
}

/**
 * The smallest whole count whose share of `expected` reaches the ratio. The count is tested as a share because the
 * product alone can land under the whole number it stands for: 100 x 0.57 is 56.99999999999999.
 */
function computeMinimumCount(expected: number, ratio: number): number {
    const floor = Math.floor(expected * ratio);
    return floor / expected >= ratio ? floor : floor + 1;
}
