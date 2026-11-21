import { isApiJsonObject, type ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    toField,
    toIssue,
    validateList,
    validateObject,
    validateText,
    validateUnique,
    type AlmLaneFileField
} from '../lane-result/alm-lane-file-field.ts';
import type { AlmLaneFlakeCause } from './compute-alm-lane-ledger.ts';

/**
 * The recorded causes, read from `alm-lane-flake-causes.json`. Every issue names the field's path and what was there;
 * a scenario named twice is an issue, since the ledger reads at most one cause per scenario.
 */
export function decodeAlmLaneFlakeCauses(value: unknown): Either<readonly string[], readonly AlmLaneFlakeCause[]> {
    if (!Array.isArray(value)) {
        const received = isApiJsonObject(value) ? 'an object' : String(JSON.stringify(value));
        return Either.ofLeft([`The flake causes must be an array; received ${received}.`]);
    }
    const causes: AlmLaneFileField = { path: 'causes', value };
    const issues = [...validateList(causes, validateCause), ...validateUnique(causes, 'scenario')];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight((value as readonly ApiJsonObject[]).map((entry): AlmLaneFlakeCause => ({
        scenario: entry.scenario as string,
        cause: entry.cause as string,
        fixedByPullRequest: entry.fixedByPullRequest as number | null
    })));
}

function validateCause(field: AlmLaneFileField): readonly string[] {
    return validateObject(field, (entry) => [
        ...validateText(toField(entry, 'scenario', field.path)),
        ...validateText(toField(entry, 'cause', field.path)),
        ...validatePullRequest(toField(entry, 'fixedByPullRequest', field.path))
    ]);
}

function validatePullRequest(field: AlmLaneFileField): readonly string[] {
    const accepted = field.value === null ||
        (typeof field.value === 'number' && Number.isInteger(field.value) && field.value > 0);
    return accepted ? [] : [toIssue(field, 'a positive integer or null')];
}
