import {
    isAlmLanePlanNarrowed,
    type ValidateAlmLanePlanCoverageInput
} from '../lane/validate-alm-lane-plan-coverage.ts';
import type { AlmCarrierMatrix } from './alm-carrier-matrix.ts';
import { toAlmCarrierMatrixLaneProofs } from './to-alm-carrier-matrix-cell-proofs.ts';

export interface ValidateAlmCarrierMatrixPlanInput {
    readonly matrix: AlmCarrierMatrix;
    /** The plan of one carrier's run, as `validateAlmLanePlanCoverage` takes it. */
    readonly plan: ValidateAlmLanePlanCoverageInput;
}

/**
 * A `full` run that is not narrowed must plan every lane cell the matrix names over its carrier: the cell is what
 * proves a capability's outcome there, so a plan that leaves it out proves less than the matrix states. A `smoke` run,
 * and a run `isAlmLanePlanNarrowed` calls narrowed, plan fewer cells on purpose. A plan takes its cells from the
 * catalogue, so a named scenario planned over a carrier no capability names it on is the catalogue's disagreement,
 * which `validateAlmCarrierMatrix` reports.
 */
export function validateAlmCarrierMatrixPlan({ matrix, plan }: ValidateAlmCarrierMatrixPlanInput): readonly string[] {
    if (plan.scope !== 'full' || isAlmLanePlanNarrowed(plan)) {
        return [];
    }
    const plannedScenarioKeys = new Set(plan.families.flatMap(({ scenarioKeys }) => scenarioKeys));
    return toAlmCarrierMatrixLaneProofs(matrix)
        .filter((proof) => proof.carrier === plan.carrier && !plannedScenarioKeys.has(proof.scenarioKey))
        .map(({ capabilityId, scenarioKey, carrier }) =>
            `${capabilityId} names the lane cell ${scenarioKey} over ${carrier}, which the full plan leaves out`
        );
}
