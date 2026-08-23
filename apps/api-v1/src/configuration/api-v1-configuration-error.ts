export type ApiV1ConfigurationIssueSource =
    | 'defaults'
    | 'profile'
    | 'environment'
    | 'secret'
    | 'invariant';

export interface ApiV1ConfigurationIssue {
    readonly source: ApiV1ConfigurationIssueSource;
    readonly path: string;
    readonly environmentName?: string;
    readonly code: string;
    readonly message: string;
}

const SOURCE_ORDER: Readonly<Record<ApiV1ConfigurationIssueSource, number>> = {
    defaults: 0,
    profile: 1,
    environment: 2,
    secret: 3,
    invariant: 4
};

export class ApiV1ConfigurationError extends Error {
    override readonly name = 'ApiV1ConfigurationError';
    readonly issues: readonly ApiV1ConfigurationIssue[];

    constructor(issues: readonly ApiV1ConfigurationIssue[]) {
        const sortedIssues = Object.freeze([...issues].sort(compareIssues));
        super(renderApiV1ConfigurationIssues(sortedIssues));
        this.issues = sortedIssues;
    }

    toSafeString(): string {
        return this.message;
    }

    toJSON(): Readonly<{
        name: string;
        message: string;
        issues: readonly ApiV1ConfigurationIssue[];
    }> {
        return {
            name: this.name,
            message: this.message,
            issues: this.issues
        };
    }
}

function compareIssues(
    left: ApiV1ConfigurationIssue,
    right: ApiV1ConfigurationIssue
): number {
    return SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] ||
        left.path.localeCompare(right.path) ||
        (left.environmentName ?? '').localeCompare(right.environmentName ?? '') ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message);
}

function renderApiV1ConfigurationIssues(
    issues: readonly ApiV1ConfigurationIssue[]
): string {
    const details = issues.map((issue) => {
        const environment = issue.environmentName === undefined
            ? ''
            : ` (${issue.environmentName})`;
        return `- ${issue.source}:${issue.path}${environment} [${issue.code}] ${issue.message}`;
    });
    return ['API-v1 configuration validation failed:', ...details].join('\n');
}
