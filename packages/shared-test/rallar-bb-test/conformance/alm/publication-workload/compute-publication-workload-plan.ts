import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

/** What one point of the family sends and expects, in whole messages. */
export interface PublicationWorkloadPlan {
    readonly frameCount: number;
    /** Derived from the integer interval, so it is not rounded. */
    readonly configuredRateHz: number;
    readonly subscriberCount: number;
    readonly expectedDeliveriesPerSubscriber: number;
    readonly minDeliveriesPerSubscriber: number;
    readonly minAcceptedSends: number;
    readonly logicalFanoutMessages: number;
}

/** One frame per send: a whole number only when the window is a multiple of the interval. */
export function computePublicationWorkloadFrameCount(
    parameters: Pick<PublicationWorkloadParameters, 'windowMs' | 'publishIntervalMs'>
): number {
    return parameters.windowMs / parameters.publishIntervalMs;
}

/** Defined for a point `validatePublicationWorkloadParameters` passes. A ratio's fraction of a message rounds down. */
export function computePublicationWorkloadPlan(parameters: PublicationWorkloadParameters): PublicationWorkloadPlan {
    const frameCount = computePublicationWorkloadFrameCount(parameters);
    const subscriberCount = parameters.participantCount - 1;
    return {
        frameCount,
        configuredRateHz: 1_000 / parameters.publishIntervalMs,
        subscriberCount,
        expectedDeliveriesPerSubscriber: frameCount,
        minDeliveriesPerSubscriber: Math.floor(frameCount * parameters.minReceiveRatio),
        minAcceptedSends: Math.floor(frameCount * parameters.minSendSuccessRatio),
        logicalFanoutMessages: frameCount * subscriberCount
    };
}
