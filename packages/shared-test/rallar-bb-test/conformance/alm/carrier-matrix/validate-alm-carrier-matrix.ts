import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceTag } from '../alm-conformance-scenario-definition.ts';
import type { AlmCarrierMatrix } from './alm-carrier-matrix.ts';
import { toAlmCarrierMatrixLaneProofs, type AlmCarrierMatrixLaneProof } from './to-alm-carrier-matrix-cell-proofs.ts';

/** One scenario the catalogue creates over one carrier. */
export interface AlmCarrierMatrixCatalogueCell {
    readonly carrier: AlmConformanceCarrier;
    readonly scenarioKey: string;
    readonly tags: readonly AlmConformanceTag[];
}

export interface ValidateAlmCarrierMatrixInput {
    readonly matrix: AlmCarrierMatrix;
    /** Every cell of the catalogue, over every carrier. */
    readonly cells: readonly AlmCarrierMatrixCatalogueCell[];
}

/**
 * The matrix and the catalogue agree when every lane cell a capability names runs over that carrier in the `full`
 * scope, and the catalogue runs a scenario the matrix names over no carrier the matrix leaves out: a named scenario's
 * carriers are then the matrix's.
 */
export function validateAlmCarrierMatrix({ matrix, cells }: ValidateAlmCarrierMatrixInput): readonly string[] {
    const laneProofs = toAlmCarrierMatrixLaneProofs(matrix);
    const namedScenarioKeys = new Set(laneProofs.map((proof) => proof.scenarioKey));
    return [
        ...laneProofs.flatMap((proof) => validateLaneProof(proof, cells.find((cell) => isSameCell(proof, cell)))),
        ...cells
            .filter((cell) => namedScenarioKeys.has(cell.scenarioKey))
            .filter((cell) => !laneProofs.some((proof) => isSameCell(proof, cell)))
            .map(({ carrier, scenarioKey }) =>
                `the catalogue runs ${scenarioKey} over ${carrier}, where no capability names it`
            )
    ];
}

function validateLaneProof(
    proof: AlmCarrierMatrixLaneProof,
    catalogueCell: AlmCarrierMatrixCatalogueCell | undefined
): readonly string[] {
    const named = `${proof.capabilityId} names the lane cell ${proof.scenarioKey} over ${proof.carrier}`;
    if (catalogueCell === undefined) {
        return [`${named}, where the catalogue does not run it`];
    }
    return catalogueCell.tags.includes('full') ? [] : [`${named}, which is outside the full scope`];
}

function isSameCell(proof: AlmCarrierMatrixLaneProof, catalogueCell: AlmCarrierMatrixCatalogueCell): boolean {
    return proof.carrier === catalogueCell.carrier && proof.scenarioKey === catalogueCell.scenarioKey;
}
