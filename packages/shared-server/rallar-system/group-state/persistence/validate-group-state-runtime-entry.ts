import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requireRecord
} from '../group-state-validation-primitives.ts';

export function validateGroupStateRuntimeEntry<T>(
    stored: RuntimeStateEntryValue<T>,
    label: string,
    expectedKey?: string
): void {
    const wrapper = requireRecord(stored, label);
    assertExactKeys(wrapper, ['entry', 'value'], label);
    assertRequiredKeys(wrapper, ['entry', 'value'], label);
    const entry = requireRecord(wrapper.entry, `${label} entry`);
    assertExactKeys(
        entry,
        ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
        `${label} entry`
    );
    assertRequiredKeys(
        entry,
        ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
        `${label} entry`
    );
    requireNonEmptyString(entry.key, `${label} entry key`);
    if (expectedKey !== undefined && entry.key !== expectedKey) {
        throw new TypeError(`${label} entry key is not canonical for its identity`);
    }
    if (typeof entry.value !== 'string') {
        throw new TypeError(`${label} entry value must be serialized JSON`);
    }
    if (!Number.isSafeInteger(entry.expireAtTimestamp) || Number(entry.expireAtTimestamp) < 0) {
        throw new TypeError(`${label} expiry must be a non-negative safe integer`);
    }
    requireNonNegativeSafeInteger(entry.revision, `${label} revision`);
    requireNonEmptyString(entry.updatedTimestamp, `${label} updatedTimestamp`);
    if (Number.isNaN(Date.parse(entry.updatedTimestamp))) {
        throw new TypeError(`${label} updatedTimestamp must be an ISO timestamp`);
    }
    let parsed;
    try {
        parsed = decodeJsonWireValue(JSON.parse(entry.value), `${label} entry value`);
    }
    catch {
        throw new TypeError(`${label} entry value must be valid JSON`);
    }
    if (!jsonEquals(parsed, wrapper.value)) {
        throw new TypeError(`${label} entry value differs from parsed value`);
    }
}
