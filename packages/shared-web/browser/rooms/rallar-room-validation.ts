import type { GroupRef } from '@shared/api/group-types.ts';
import {
    throwRallarValidation,
    validateRallarGroupRef,
    validateRallarRouteId,
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';

/** Adds route validation failures for an optional room identifier. */
export interface OptionalRouteIdIssueInput {
    readonly value: string | undefined;
    readonly path: string;
    readonly label: string;
    readonly issues: RallarValidationIssue[];
}

export function pushOptionalRouteIdIssue(
    input: OptionalRouteIdIssueInput
): void {
    const { value, path, label, issues } = input;
    if (value !== undefined) {
        issues.push(...validateRallarRouteId(value, path, label).issues);
    }
}

export function pushOptionalGroupRefIssue(
    value: GroupRef | undefined,
    path: string,
    issues: RallarValidationIssue[]
): void {
    if (value !== undefined) {
        issues.push(...validateRallarGroupRef(value, path).issues);
    }
}

export function throwRallarValidationIssue(
    path: string,
    code: string,
    message: string
): never {
    throwRallarValidation([{ path, code, message }]);
}

export function throwIfRallarValidationIssues(
    issues: readonly RallarValidationIssue[]
): void {
    if (issues.length > 0) {
        throwRallarValidation(issues);
    }
}
