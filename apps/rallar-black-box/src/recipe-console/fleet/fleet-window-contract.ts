export const FLEET_WINDOW_BUDGETS = {
    heatmapAgents: 32,
    heatmapRuns: 8,
    regions: 24,
    failures: 24,
    regionTiming: 24,
    recipeTiming: 24,
    missingLabels: 40,
    agentRuns: 12,
    failureAgents: 40,
    regionProviders: 24,
    reportRecipes: 24,
    mapAgents: 40,
    mapRegions: 24,
    mapFailures: 40,
    mapRoutes: 32,
    unresolvedAgents: 40,
    unresolvedRouteEndpoints: 40,
    liveAgents: 40
} as const;

export type FleetWindowSection = keyof typeof FLEET_WINDOW_BUDGETS;

export function createFleetWindowFingerprint(
    input: Readonly<{
        contextKey: string;
        section: FleetWindowSection;
    }>
): string {
    return JSON.stringify([
        'fleet-window-v1',
        input.contextKey,
        input.section
    ]);
}

export function fleetWindowBudget(section: FleetWindowSection): number {
    return FLEET_WINDOW_BUDGETS[section];
}
