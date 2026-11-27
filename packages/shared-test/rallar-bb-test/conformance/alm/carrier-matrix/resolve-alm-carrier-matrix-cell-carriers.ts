import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { ALM_CARRIER_MATRIX } from './alm-carrier-matrix.ts';
import { toAlmCarrierMatrixLaneProofs } from './to-alm-carrier-matrix-cell-proofs.ts';

/** Every scenario some cell of the matrix names as its lane proof. */
export type AlmCarrierMatrixScenarioKey = Extract<
    AlmCarrierMatrixStatedCell['proofs'][number],
    Readonly<{ kind: 'lane-cell'; }>
>['scenarioKey'];

type AlmCarrierMatrixStatedCell = Extract<
    (typeof ALM_CARRIER_MATRIX)[keyof typeof ALM_CARRIER_MATRIX]['cells'][AlmConformanceCarrier],
    Readonly<{ kind: 'stated'; }>
>;

/**
 * The carriers a scenario the matrix names runs over: each one on which some capability names it as a lane proof, in
 * the order of `ALM_CONFORMANCE_CARRIERS`. Such a scenario states no carriers of its own.
 */
export function resolveAlmCarrierMatrixCellCarriers(
    scenarioKey: AlmCarrierMatrixScenarioKey
): readonly AlmConformanceCarrier[] {
    const laneProofs = toAlmCarrierMatrixLaneProofs(ALM_CARRIER_MATRIX);
    return ALM_CONFORMANCE_CARRIERS.filter((carrier) =>
        laneProofs.some((proof) => proof.carrier === carrier && proof.scenarioKey === scenarioKey)
    );
}
