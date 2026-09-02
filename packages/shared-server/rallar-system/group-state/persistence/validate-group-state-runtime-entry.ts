import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    validateExactKeys,
    validateNonEmptyString,
    validateNonNegativeSafeInteger,
    validateRecord,
    validateRequiredKeys
} from '../group-state-validation-issues.ts';

export function validateGroupStateRuntimeEntry<T>(
    stored: RuntimeStateEntryValue<T>,
    label: string,
    expectedKey?: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const wrapper = stored;
    if (!isGroupStateRecord(wrapper)) {
        return [...issues, ...validateRecord(wrapper, label)];
    }
    issues.push(...validateExactKeys(wrapper, ['entry', 'value'], label));
    issues.push(...validateRequiredKeys(wrapper, ['entry', 'value'], label));
    const entry = wrapper.entry;
    if (!isGroupStateRecord(entry)) {
        return [...issues, ...validateRecord(entry, `${label} entry`)];
    }
    issues.push(...validateExactKeys(
        entry,
        ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
        `${label} entry`
    ));
    issues.push(...validateRequiredKeys(
        entry,
        ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
        `${label} entry`
    ));
    issues.push(...validateNonEmptyString(entry.key, `${label} entry key`));
    if (expectedKey !== undefined && entry.key !== expectedKey) {
        issues.push(toGroupStateValidationIssue(label, `${label} entry key is not canonical for its identity`));
    }
    if (typeof entry.value !== 'string') {
        issues.push(toGroupStateValidationIssue(label, `${label} entry value must be serialized JSON`));
    }
    if (!Number.isSafeInteger(entry.expireAtTimestamp) || Number(entry.expireAtTimestamp) < 0) {
        issues.push(toGroupStateValidationIssue(label, `${label} expiry must be a non-negative safe integer`));
    }
    issues.push(...validateNonNegativeSafeInteger(entry.revision, `${label} revision`));
    issues.push(...validateNonEmptyString(entry.updatedTimestamp, `${label} updatedTimestamp`));
    if (typeof entry.updatedTimestamp === 'string' && Number.isNaN(Date.parse(entry.updatedTimestamp))) {
        issues.push(toGroupStateValidationIssue(label, `${label} updatedTimestamp must be an ISO timestamp`));
    }
    if (typeof entry.value !== 'string') {
        return issues;
    }
    let parsed;
    try {
        parsed = decodeJsonWireValue(JSON.parse(entry.value), `${label} entry value`);
    }
    catch {
        return [...issues, toGroupStateValidationIssue(label, `${label} entry value must be valid JSON`)];
    }
    if (!jsonEquals(parsed, wrapper.value)) {
        issues.push(toGroupStateValidationIssue(label, `${label} entry value differs from parsed value`));
    }
    return issues;
}
