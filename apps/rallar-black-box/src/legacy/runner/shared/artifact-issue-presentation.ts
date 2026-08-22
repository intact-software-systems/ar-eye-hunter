import type { RallarBlackBoxSharedTestArtifactValidationIssue } from '../../../shared-test-handoff-fixtures.ts';

export function artifactIssueText(
    issue: RallarBlackBoxSharedTestArtifactValidationIssue
): string {
    const file = issue.file ?? 'bundle';
    return `${file} ${issue.path}: ${issue.message}`;
}
