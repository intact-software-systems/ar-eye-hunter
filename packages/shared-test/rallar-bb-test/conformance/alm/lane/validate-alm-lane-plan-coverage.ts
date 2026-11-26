import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceTag } from '../alm-conformance-scenario-definition.ts';
import type { AlmLanePlannedFamily } from '../lane-result/alm-lane-result.ts';
import type { AlmLaneParameters } from './decode-alm-lane-parameters.ts';

export interface ValidateAlmLanePlanCoverageInput extends Pick<AlmLaneParameters, 'only' | 'skip'> {
    readonly carrier: AlmConformanceCarrier;
    readonly scope: AlmConformanceTag;
    readonly families: readonly AlmLanePlannedFamily[];
}

/**
 * A run that is not narrowed must plan at least one scenario over its carrier, so a required lane cannot pass having
 * run nothing. A narrowed run may plan nothing on purpose.
 */
export function validateAlmLanePlanCoverage(input: ValidateAlmLanePlanCoverageInput): readonly string[] {
    const plansAScenario = input.families.some(({ scenarioKeys }) => scenarioKeys.length > 0);
    return isAlmLanePlanNarrowed(input) || plansAScenario
        ? []
        : [`no ${input.scope} ALM scenario runs over ${input.carrier}`];
}

/**
 * Whether `RALLAR_BLACK_BOX_ALM_ONLY` or `_SKIP` narrows a run: the one rule by which a plan is excused from a check
 * of everything it should hold. `_FAMILIES` narrows no plan, since the plan names every family's cells.
 */
export function isAlmLanePlanNarrowed({ only, skip }: Pick<AlmLaneParameters, 'only' | 'skip'>): boolean {
    return only.length > 0 || skip.length > 0;
}
