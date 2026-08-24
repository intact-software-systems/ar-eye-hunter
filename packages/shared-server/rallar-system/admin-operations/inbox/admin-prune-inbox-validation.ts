export interface AdminPruneValidationIssue {
    readonly code: string;
    readonly message: string;
    readonly status: number;
}

export class AdminPruneValidationError extends Error {
    readonly code: string;
    readonly status: number;
    readonly issues: readonly AdminPruneValidationIssue[];

    constructor(issues: readonly AdminPruneValidationIssue[]) {
        const firstIssue = issues[0];
        if (firstIssue === undefined) {
            throw new TypeError('Admin prune validation error requires at least one issue');
        }
        super(firstIssue.message);
        this.code = firstIssue.code;
        this.status = firstIssue.status;
        this.issues = issues;
        this.name = 'AdminPruneValidationError';
    }
}

export function throwOnAdminPruneValidationIssues(
    issues: readonly AdminPruneValidationIssue[]
): void {
    const issue = issues[0];
    if (issue === undefined) {
        return;
    }
    throw new AdminPruneValidationError(issues);
}
