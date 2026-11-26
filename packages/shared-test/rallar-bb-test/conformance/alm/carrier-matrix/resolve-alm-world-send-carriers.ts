import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { ALM_CARRIER_MATRIX } from './alm-carrier-matrix.ts';

/**
 * The carriers on which a world broadcast leaves its sender's page: each one whose `world-broadcast` cell delivers it
 * or hands it to WS, in the order of `ALM_CONFORMANCE_CARRIERS`. A cell that needs one sent runs over these alone.
 */
export function resolveAlmWorldSendCarriers(): readonly AlmConformanceCarrier[] {
    const cells = ALM_CARRIER_MATRIX['world-broadcast'].cells;
    return ALM_CONFORMANCE_CARRIERS.filter((carrier) => {
        const { kind } = cells[carrier].outcome;
        return kind === 'delivered' || kind === 'handed-to-ws';
    });
}
