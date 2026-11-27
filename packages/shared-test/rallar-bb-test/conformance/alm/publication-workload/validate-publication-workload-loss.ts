import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import {
    validateSeededTransportFaultAction,
    type TransportFaultLoss
} from '@shared/transport-faults/seeded-transport-fault-action.ts';
import type { TransportFaultCarrier } from '@shared/transport-faults/transport-fault-port.ts';

import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    computePublicationWorkloadLostFrameCount,
    computePublicationWorkloadSeededDropCount
} from './compute-publication-workload-lost-frame-count.ts';
import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

/** What a point loses: stated outright, so a point without loss names no seed. */
export type PublicationWorkloadLoss = PublicationWorkloadNoLoss | PublicationWorkloadSeededLoss;

export interface PublicationWorkloadNoLoss {
    readonly kind: 'none';
}

/**
 * Each publisher's page drops this share of its own frames of the family's type on the point's carrier, drawn from the
 * seed: every page draws from the same seed, so over `ws` every publisher loses the same frame positions.
 */
export interface PublicationWorkloadSeededLoss extends TransportFaultLoss {
    readonly kind: 'seeded';
}

/** The counts a seeded loss is checked against, each only where the fields it comes from hold their own bounds. */
export interface PublicationWorkloadLossBounds {
    /** One publisher's frames. */
    readonly frameCount: number | undefined;
    /** The frames each publisher's stage must hand to a carrier; the loss must drop one of the first of them. */
    readonly minAcceptedSends: number | undefined;
}

const PUBLICATION_WORKLOAD_LOSS_KINDS: readonly string[] = ['none', 'seeded'];

/**
 * Every issue of the loss: the platform's own sentences where it cannot be injected, else the family's rules. Under
 * `rtc-with-ws-fallback` the loss stands on the RTC leg alone, so a frame handed to WS is never lost.
 */
export function validatePublicationWorkloadLoss(
    parameters: Pick<PublicationWorkloadParameters, 'carrier' | 'loss'>,
    bounds: PublicationWorkloadLossBounds
): readonly RallarValidationIssue[] {
    const { loss } = parameters;
    if (!PUBLICATION_WORKLOAD_LOSS_KINDS.includes(loss.kind)) {
        return [
            toIssue(
                '$.loss',
                'invalid-loss',
                `Expected a loss of kind ${PUBLICATION_WORKLOAD_LOSS_KINDS.join(' or ')}.`
            )
        ];
    }
    if (loss.kind === 'none') {
        return [];
    }
    const platformIssues = validateSeededTransportFaultAction({ loss: toTransportFaultLoss(loss) });
    if (platformIssues.length > 0) {
        return platformIssues.map((sentence) =>
            toIssue(
                '$.loss',
                'invalid-seeded-loss',
                `Expected a loss the platform's seeded fault accepts: ${sentence}.`
            )
        );
    }
    if (loss.ratio >= 1) {
        return [
            toIssue(
                '$.loss.ratio',
                'loss-ratio-not-below-one',
                'Expected a ratio below 1: at 1 no frame leaves a publisher.'
            )
        ];
    }
    return [
        ...validateLossDropsFrame(loss, bounds.minAcceptedSends),
        ...validateLossLeavesFrame(parameters, bounds.frameCount)
    ];
}

/** The fault the recipes arm: `ws` for a `ws` point, otherwise the RTC carrier, the first leg of a fallback strategy. */
export function resolvePublicationWorkloadLossCarrier(carrier: AlmConformanceCarrier): TransportFaultCarrier {
    return carrier === 'ws' ? 'ws' : 'rtc';
}

/** The platform's loss holds no kind: its decoder refuses a field it does not know. */
export function toTransportFaultLoss(loss: PublicationWorkloadSeededLoss): TransportFaultLoss {
    return { ratio: loss.ratio, seed: loss.seed };
}

/** A publisher writes at least `minAcceptedSends` frames, so a drop among their draws makes the fault's release read one. */
function validateLossDropsFrame(
    loss: PublicationWorkloadSeededLoss,
    minAcceptedSends: number | undefined
): readonly RallarValidationIssue[] {
    return minAcceptedSends !== undefined && computePublicationWorkloadSeededDropCount(loss, minAcceptedSends) === 0
        ? [toIssue(
            '$.loss',
            'loss-drops-no-frame',
            `Expected a loss that drops one of the first ${minAcceptedSends} frames; the seed drops none of them.`
        )]
        : [];
}

function validateLossLeavesFrame(
    parameters: Pick<PublicationWorkloadParameters, 'carrier' | 'loss'>,
    frameCount: number | undefined
): readonly RallarValidationIssue[] {
    return frameCount !== undefined && computePublicationWorkloadLostFrameCount(parameters, frameCount) === frameCount
        ? [toIssue(
            '$.loss',
            'loss-leaves-no-frame',
            `Expected a loss that leaves a subscriber a frame; the seed drops all ${frameCount}.`
        )]
        : [];
}

function toIssue(path: string, code: string, message: string): RallarValidationIssue {
    return { path, code, message };
}
