import type {
    BlackBoxRunnerArtifactValidationIssue
} from '@shared-test/black-box-runner/artifacts/artifact-reader.ts';

export function artifactIssueText(
    issue: BlackBoxRunnerArtifactValidationIssue
): string {
    const file = issue.file ?? 'bundle';
    return `${file} ${issue.path}: ${issue.message}`;
}
