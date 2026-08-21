export interface AdminPruneValidationIssue {
    readonly code: string;
    readonly message: string;
    readonly status: number;
}

export function throwOnAdminPruneValidationIssues(
    issues: readonly AdminPruneValidationIssue[]
): void {
    const issue = issues[0];
    if (issue === undefined) {
        return;
    }
    throw Object.assign(new Error(issue.message), {
        code: issue.code,
        status: issue.status,
        issues
    });
}
