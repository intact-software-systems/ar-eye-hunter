export type BlackBoxRunnerPreflightSeverity = 'error' | 'warning';

export interface BlackBoxRunnerPreflightIssue {
    readonly severity: BlackBoxRunnerPreflightSeverity;
    readonly code: string;
    readonly message: string;
    /** Absent when the issue concerns the whole plan rather than one recipe location. */
    readonly path?: string;
}
