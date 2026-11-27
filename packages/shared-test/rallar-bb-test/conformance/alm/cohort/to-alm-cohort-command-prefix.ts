/**
 * What one role's commands and its connection are named by in a cohort: `<scope>-<role name>`. A family reads a
 * role's results and names its connection by the same prefix the cohort's setup gave them.
 */
export function toAlmCohortCommandPrefix(scope: string, roleName: string): string {
    return `${scope}-${roleName}`;
}
