import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

/** What one point of the family sends and expects, in whole messages. */
export interface PublicationWorkloadPlan {
    readonly frameCount: number;
    /** Derived from the integer interval, so it is not rounded. */
    readonly configuredRateHz: number;
    readonly subscriberCount: number;
    /** What one subscriber is to receive, in the words of the artifact analysis's `ReceiverDeliverySpec`. */
    readonly expectedInboundMessages: number;
    /** The fewest of them that reach `minReceiveRatio`, again for one subscriber. */
    readonly minExpectedInboundMessages: number;
    /**
     * The fewest frames that reach `minSendSuccessRatio`. A send is accepted when the publisher's publication stage
     * handed its value to a carrier, the stage's `admitted` counter; a send the harness submitted is not yet one.
     */
    readonly minAcceptedSends: number;
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
    const frameCount = computePublicationWorkloadFrameCount(parameters);
    const subscriberCount = parameters.participantCount - 1;
    return {
        frameCount,
        configuredRateHz: 1_000 / parameters.publishIntervalMs,
        subscriberCount,
        expectedInboundMessages: frameCount,
        minExpectedInboundMessages: computeMinimumFrameCount(frameCount, parameters.minReceiveRatio),
        minAcceptedSends: computeMinimumFrameCount(frameCount, parameters.minSendSuccessRatio),
        logicalFanoutMessages: frameCount * subscriberCount
    };
}

/**
 * The smallest whole count whose share of the frames reaches the ratio. The count is tested as a share because the
 * product alone can land under the whole number it stands for: 100 x 0.57 is 56.99999999999999.
 */
function computeMinimumFrameCount(frameCount: number, ratio: number): number {
    const floor = Math.floor(frameCount * ratio);
    return floor / frameCount >= ratio ? floor : floor + 1;
}
