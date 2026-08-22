import {
    deriveFleetReportAgentDetail,
    deriveFleetReportHeatmapRows,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportRegionRows
} from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type { ControlFleetRunReport } from '../../../control-run-manager.ts';
import type { FleetAgentHeatmapRow } from './fleet-types.ts';

export function fleetHeatmapRows(
    reports: readonly ControlFleetRunReport[],
    runs: readonly ControlFleetRunReport[]
): readonly FleetAgentHeatmapRow[] {
    return deriveFleetReportHeatmapRows(reports, runs, {
        reportOrder: 'input',
        timedOutAsFailed: false,
        stableTieBreaks: false,
        textCollation: 'legacy-locale'
    }).rows;
}

export function fleetRegionRows(reports: readonly ControlFleetRunReport[]) {
    return deriveFleetReportRegionRows(reports, {
        reportOrder: 'input',
        timedOutAsFailed: false,
        stableTieBreaks: false,
        textCollation: 'legacy-locale'
    });
}

export function fleetMissingLabelAgents(
    reports: readonly ControlFleetRunReport[]
): readonly string[] {
    return deriveFleetReportMissingLabelAgentIds(reports);
}

export function fleetAgentDetail(
    agentId: string,
    reports: readonly ControlFleetRunReport[]
) {
    return deriveFleetReportAgentDetail(agentId, reports, {
        reportOrder: 'input',
        timedOutAsFailed: false,
        stableTieBreaks: false,
        textCollation: 'legacy-locale'
    });
}
