import type { TransportFaultLoss } from '@shared/transport-faults/seeded-transport-fault-action.ts';
import { SeededTransportFaultDraws } from '@shared/transport-faults/seeded-transport-fault-draws.ts';

import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

const DRAWS_FAULT_ID = 'publication-workload-loss';

/**
 * One publisher's frames, of its first `frameCount`, that no subscriber is to get. Only over `ws` is a dropped frame
 * lost: the socket never writes it, and nothing sends it again. Over the RTC carriers a dropped send is a refusal the
 * first hop resubmits, so every frame is expected, later.
 */
export function computePublicationWorkloadLostFrameCount(
    parameters: Pick<PublicationWorkloadParameters, 'carrier' | 'loss'>,
    frameCount: number
): number {
    const { carrier, loss } = parameters;
    return carrier === 'ws' && loss.kind === 'seeded'
        ? computePublicationWorkloadSeededDropCount(loss, frameCount)
        : 0;
}

/**
 * The draws below the ratio among the seed's first `drawCount`, read from the platform's own draws: a fault on `ws`
 * draws once for each frame its socket writes, in order, so these are the frames it drops.
 */
export function computePublicationWorkloadSeededDropCount(loss: TransportFaultLoss, drawCount: number): number {
    const action = { loss: { ratio: loss.ratio, seed: loss.seed } };
    const draws = new SeededTransportFaultDraws();
    draws.rearm(DRAWS_FAULT_ID, action);
    return Array.from({ length: drawCount }, () => draws.decideFrame(DRAWS_FAULT_ID, action))
        .filter((effect) => effect.kind === 'drop').length;
}
