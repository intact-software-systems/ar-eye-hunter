import type { RecipeConsoleDiagnosticSeverity, RecipeConsoleTransport } from '../routing/url-state-contract.ts';

export const MONITOR_WINDOW_BUDGETS = {
    failures: 60,
    agents: 80,
    recipes: 60,
    readiness: 60,
    diagnostics: 50,
    timeline: 40,
    events: 40,
    composites: 40,
    commandEvidence: 16,
    failureDestinations: 40,
    diagnosticFailureLinks: 40
} as const;

export type MonitorWindowSection = keyof typeof MONITOR_WINDOW_BUDGETS;

export type MonitorWindowFingerprintInput = Readonly<{
    contextKey: string;
    section: MonitorWindowSection;
    diagnosticSeverity?: RecipeConsoleDiagnosticSeverity;
    transport?: RecipeConsoleTransport;
}>;

export function createMonitorWindowFingerprint(
    input: MonitorWindowFingerprintInput
): string {
    const diagnosticFilters = input.section === 'diagnostics'
        ? [input.diagnosticSeverity ?? null, input.transport ?? null]
        : [];
    return JSON.stringify([
        'monitor-window-v1',
        input.contextKey,
        input.section,
        ...diagnosticFilters
    ]);
}

export function monitorWindowBudget(section: MonitorWindowSection): number {
    return MONITOR_WINDOW_BUDGETS[section];
}
