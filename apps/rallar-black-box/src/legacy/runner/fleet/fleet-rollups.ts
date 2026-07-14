import {
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
} from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type {
    ControlFleetFailureSignature,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
} from '../../../control-run-manager.ts';

export function fleetDisplaySummary(
    reports: readonly ControlFleetRunReport[],
    response: ControlFleetReportsResponse | undefined,
): Readonly<{
    runs: number;
    agents: number;
    regions: number;
    passRate: number;
    failureGroups: number;
    p95DurationMs?: number;
    stale: number;
}> {
    return deriveFleetReportDisplaySummary(reports, response);
}

export function fleetFailureRows(
    reports: readonly ControlFleetRunReport[],
): readonly ControlFleetFailureSignature[] {
    return deriveFleetReportFailureRows(reports, {
        reportOrder: 'input',
        timedOutAsFailed: false,
        stableTieBreaks: false,
        textCollation: 'legacy-locale',
    });
}
