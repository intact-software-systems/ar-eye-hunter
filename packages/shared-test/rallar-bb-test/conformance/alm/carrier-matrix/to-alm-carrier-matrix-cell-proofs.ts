import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmCarrierMatrix, AlmCarrierProof } from './alm-carrier-matrix.ts';

/** One proof of the cell a capability states on one carrier. */
export interface AlmCarrierMatrixCellProof {
    readonly capabilityId: string;
    readonly carrier: AlmConformanceCarrier;
    readonly proof: AlmCarrierProof;
}

/** One lane cell a capability names as a proof of its cell on one carrier. */
export interface AlmCarrierMatrixLaneProof {
    readonly capabilityId: string;
    readonly carrier: AlmConformanceCarrier;
    readonly scenarioKey: string;
}

/**
 * Every proof of every stated cell, capability by capability in the order the matrix writes them, carrier by carrier
 * in the order of `ALM_CONFORMANCE_CARRIERS`, proof by proof in the order the cell lists them. A cell that is not
 * applicable has none.
 */
export function toAlmCarrierMatrixCellProofs(matrix: AlmCarrierMatrix): readonly AlmCarrierMatrixCellProof[] {
    return Object.entries(matrix).flatMap(([capabilityId, capability]) =>
        ALM_CONFORMANCE_CARRIERS.flatMap((carrier) => {
            const cell = capability.cells[carrier];
            return cell.kind === 'stated' ? cell.proofs.map((proof) => ({ capabilityId, carrier, proof })) : [];
        })
    );
}

/** Every lane cell the matrix names as a proof, in the order of `toAlmCarrierMatrixCellProofs`. */
export function toAlmCarrierMatrixLaneProofs(matrix: AlmCarrierMatrix): readonly AlmCarrierMatrixLaneProof[] {
    return toAlmCarrierMatrixCellProofs(matrix).flatMap(({ capabilityId, carrier, proof }) =>
        proof.kind === 'lane-cell' ? [{ capabilityId, carrier, scenarioKey: proof.scenarioKey }] : []
    );
}
