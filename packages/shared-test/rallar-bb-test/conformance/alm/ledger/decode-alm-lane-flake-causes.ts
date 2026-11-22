import { isApiJsonObject, type ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { ALM_CONFORMANCE_LANE_FAMILIES } from '../alm-conformance-scenario-definition.ts';
import {
    decodeJsonText,
    toField,
    toIssue,
    validateList,
    validateObject,
    validateText,
    validateUniqueKey,
    type AlmLaneFileField
} from '../lane-result/alm-lane-file-field.ts';
import type { AlmLaneFlakeCause } from './compute-alm-lane-ledger.ts';

const CARRIER_PATTERN = ALM_CONFORMANCE_CARRIERS.join('|');

/** `carrier/family/scenarioKey`, `carrier/family`, or `carrier/run/<run id>` for a red run that names no key. */
const CAUSE_KEY_PATTERN = new RegExp(
    `^(${CARRIER_PATTERN})/((${ALM_CONFORMANCE_LANE_FAMILIES.join('|')})(/[^/]+)?|run/[1-9][0-9]*)$`
);

const CAUSE_KEY_FORMS =
    'carrier/family/scenarioKey, carrier/family or carrier/run/<run id>, with a known carrier and family';

/**
 * The recorded causes, read from `alm-lane-flake-causes.json`. Every issue names the field's path and what was there;
 * a key named twice is an issue, since the ledger reads at most one cause per key.
 */
export function decodeAlmLaneFlakeCauses(value: unknown): Either<readonly string[], readonly AlmLaneFlakeCause[]> {
    if (!Array.isArray(value)) {
        const received = isApiJsonObject(value) ? 'an object' : String(JSON.stringify(value));
        return Either.ofLeft([`The flake causes must be an array; received ${received}.`]);
    }
    const causes: AlmLaneFileField = { path: 'causes', value };
    const issues = [...validateList(causes, validateCause), ...validateUniqueKey(causes, 'key')];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight((value as readonly ApiJsonObject[]).map((entry): AlmLaneFlakeCause => ({
        key: entry.key as string,
        cause: entry.cause as string,
        fixedByPullRequest: entry.fixedByPullRequest as number | null
    })));
}

function validateCause(field: AlmLaneFileField): readonly string[] {
    return validateObject(field, (entry) => [
        ...validateCauseKey(toField(entry, 'key', field.path)),
        ...validateText(toField(entry, 'cause', field.path)),
        ...validatePullRequest(toField(entry, 'fixedByPullRequest', field.path))
    ]);
}

function validateCauseKey(field: AlmLaneFileField): readonly string[] {
    return typeof field.value === 'string' && CAUSE_KEY_PATTERN.test(field.value)
        ? []
        : [toIssue(field, CAUSE_KEY_FORMS)];
}

function validatePullRequest(field: AlmLaneFileField): readonly string[] {
    const accepted = field.value === null ||
        (typeof field.value === 'number' && Number.isInteger(field.value) && field.value > 0);
    return accepted ? [] : [toIssue(field, 'a positive integer or null')];
}

/**
 * The text of `alm-lane-flake-causes.json`, or null when the file could not be read. A file that could not be read or
 * is not JSON is an issue, as a malformed entry is.
 */
export function decodeAlmLaneFlakeCausesText(
    text: string | null
): Either<readonly string[], readonly AlmLaneFlakeCause[]> {
    if (text === null) {
        return Either.ofLeft(['The flake causes file could not be read.']);
    }
    const value = decodeJsonText(text);
    return value === undefined
        ? Either.ofLeft(['The flake causes file is not JSON.'])
        : decodeAlmLaneFlakeCauses(value);
}
