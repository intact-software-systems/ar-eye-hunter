export const EXECUTE_WINDOW_BUDGETS = {
    targets: 100,
    resolution: 100,
    preflightRows: 100,
    preflightIssues: 100,
    manifestErrors: 100,
    inspectorCommands: 100,
    inspectorPrerequisites: 100
} as const;

export type ExecuteWindowSection = keyof typeof EXECUTE_WINDOW_BUDGETS;

export function createExecuteWindowFingerprint(
    input: Readonly<{
        contextKey: string;
        section: ExecuteWindowSection;
    }>
): string {
    return JSON.stringify([
        'execute-window-v1',
        input.contextKey,
        input.section
    ]);
}

export function executeWindowBudget(section: ExecuteWindowSection): number {
    return EXECUTE_WINDOW_BUDGETS[section];
}
