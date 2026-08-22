import {
    deriveFleetReportTimingDistribution,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportTimingGroupsByRegion
} from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type { ControlFleetRunReport, ControlFleetTimingDistribution } from '../../../control-run-manager.ts';
import type { FleetTimingGroup } from './fleet-types.ts';

export function fleetTimingGroupsByRegion(
    reports: readonly ControlFleetRunReport[]
): readonly FleetTimingGroup[] {
    return deriveFleetReportTimingGroupsByRegion(reports, {
        reportOrder: 'input',
        timedOutAsFailed: false,
        stableTieBreaks: false,
        textCollation: 'legacy-locale'
    });
}

export function fleetTimingGroupsByRecipe(
    reports: readonly ControlFleetRunReport[]
): readonly FleetTimingGroup[] {
    return deriveFleetReportTimingGroupsByRecipe(reports, {
        reportOrder: 'input',
        timedOutAsFailed: false,
        stableTieBreaks: false,
        textCollation: 'legacy-locale'
    });
}

export function fleetTimingDistribution(
    values: readonly number[]
): ControlFleetTimingDistribution {
    return deriveFleetReportTimingDistribution(values);
}
