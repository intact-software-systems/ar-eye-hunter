import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export interface ControlCommandIssue {
    readonly message: string;
    readonly validationIssues: readonly RallarValidationIssue[];
}

export function toControlCommandIssue(message: string): ControlCommandIssue {
    return { message, validationIssues: [] };
}

export function toPrefixedControlCommandIssues(
    prefix: string,
    issues: readonly ControlCommandIssue[]
): readonly ControlCommandIssue[] {
    return issues.map((issue) => ({ ...issue, message: `${prefix}: ${issue.message}` }));
}
