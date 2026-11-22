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
 * run nothing. A run narrowed by `only` or `skip` may plan nothing on purpose.
 */
export function validateAlmLanePlanCoverage(input: ValidateAlmLanePlanCoverageInput): readonly string[] {
    const narrowed = input.only.length > 0 || input.skip.length > 0;
    const plansAScenario = input.families.some(({ scenarioKeys }) => scenarioKeys.length > 0);
    return narrowed || plansAScenario ? [] : [`no ${input.scope} ALM scenario runs over ${input.carrier}`];
}
