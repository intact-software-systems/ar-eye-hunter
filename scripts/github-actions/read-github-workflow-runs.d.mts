/** The fields of a GitHub workflow run that typed callers read; the reader returns the API's whole object. */
export interface GithubWorkflowRun {
    readonly id: number;
    readonly head_sha: string;
    readonly event: string;
    readonly run_attempt: number;
}

export interface GithubWorkflowRunsFilter {
    readonly repository: string;
    readonly workflowPath: string;
    readonly branch?: string;
    readonly event?: string;
    readonly status?: string;
    /** At most one page: the newest runs only. */
    readonly limit?: number;
}

export interface GithubWorkflowRunJob {
    readonly name: string;
    readonly status: string;
    /** Null while the job runs. */
    readonly conclusion: string | null;
}

export interface GithubWorkflowRunIdentity {
    readonly repository: string;
    readonly runId: number;
}

export interface ReadGithubArtifactDirectoryInput<T> extends GithubWorkflowRunIdentity {
    readonly artifactName: string;
    readonly readDirectory: (artifactDirectory: string) => T;
}

export function readGithubRepository(): string;
export function readGithubWorkflowRuns(filter: GithubWorkflowRunsFilter): readonly GithubWorkflowRun[];
export function toGithubWorkflowRunsEndpoint(filter: GithubWorkflowRunsFilter): string;
export function readWorkflowRunsEnvelope(source: string): readonly GithubWorkflowRun[];
export function readGithubWorkflowRunJobs(run: GithubWorkflowRunIdentity): readonly GithubWorkflowRunJob[];
export function toGithubWorkflowRunJobs(source: string): readonly GithubWorkflowRunJob[];
export function readGithubWorkflowRunArtifactNames(run: GithubWorkflowRunIdentity): readonly string[];
export function toGithubArtifactNames(source: string): readonly string[];
export function readGithubArtifactDirectory<T>(input: ReadGithubArtifactDirectoryInput<T>): T | undefined;
