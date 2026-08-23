import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';

import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateOptimisticTransactionalRepositoryLike,
    type RuntimeStateOptimisticTransactionalRepositoryLike,
    type RuntimeStateRepositoryLike
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../persistence/rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import type { RtcTopologyPublicationWorkClaim } from './rtc-topology-publication-repository-contracts.ts';

export type PersistedBoundaryValue =
    | object
    | string
    | number
    | boolean
    | null
    | undefined;

interface AssertTrustedSlotInput {
    readonly decoded: Readonly<{ groupRef: GroupRef; value: string; }>;
    readonly trustedRef: GroupRef | undefined;
    readonly trustedValue: string | undefined;
    readonly storageKey: string;
}

export function validateWorkClaim(
    value: PersistedBoundaryValue,
    expectedRef: GroupRef
): asserts value is RtcTopologyPublicationWorkClaim {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology work claim is invalid');
    }
    assertExactKeys(value, [
        'kind',
        'schemaVersion',
        'groupRef',
        'workId',
        'commandId',
        'requestId',
        'commandHash',
        'publicationId',
        'outcome',
        'attemptCount',
        'acceptedCausalRevision',
        'acceptedStorageRevision',
        'eventId',
        'outboxIds'
    ]);
    validateGroupRef(value.groupRef, expectedRef);
    if (
        value.kind !== 'rtc-topology-execution-receipt' ||
        value.schemaVersion !== 1 || value.outcome !== 'accepted' ||
        typeof value.workId !== 'string' || value.workId.length === 0 ||
        value.commandId !== value.workId || value.requestId !== value.workId ||
        typeof value.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.commandHash) ||
        typeof value.publicationId !== 'string' || value.publicationId.length === 0 ||
        !Number.isSafeInteger(value.attemptCount) || Number(value.attemptCount) < 1 ||
        !Number.isSafeInteger(value.acceptedStorageRevision) ||
        Number(value.acceptedStorageRevision) < 0 || value.eventId !== null ||
        !Array.isArray(value.outboxIds) || value.outboxIds.length !== 1 ||
        value.outboxIds[0] !== value.publicationId
    ) {
        throw new TypeError('RTC topology work claim identity is invalid');
    }
    validateCausalRevision(value.acceptedCausalRevision);
}

export function childKey(groupRef: GroupRef, name: string, value: string): string {
    return `${groupStateGroupStorageKey(groupRef)}:${name}=${encodeURIComponent(value)}`;
}

export function decodeChildKey(
    storageKey: string,
    name: string
): Readonly<{ groupRef: GroupRef; value: string; }> {
    const parts = storageKey.split(':');
    if (parts.length !== 4) {
        throw publicationCorruption(storageKey, `RTC topology ${name} key has invalid arity`);
    }
    let groupRef: GroupRef;
    try {
        groupRef = decodeGroupStateGroupStorageKey(parts.slice(0, 3).join(':'));
    }
    catch (error) {
        throw publicationCorruption(
            storageKey,
            error instanceof Error ? error.message : 'RTC topology scope key is invalid'
        );
    }
    const prefix = `${name}=`;
    if (!parts[3]!.startsWith(prefix)) {
        throw publicationCorruption(storageKey, `RTC topology key is missing ${name}`);
    }
    let value: string;
    try {
        value = decodeURIComponent(parts[3]!.slice(prefix.length));
    }
    catch {
        throw publicationCorruption(storageKey, `RTC topology ${name} encoding is invalid`);
    }
    if (childKey(groupRef, name, value) !== storageKey) {
        throw publicationCorruption(storageKey, `RTC topology ${name} key is not canonical`);
    }
    return { groupRef, value };
}

export function assertTrustedSlot(input: AssertTrustedSlotInput): void {
    const { decoded, trustedRef, trustedValue, storageKey } = input;
    if (
        (trustedRef && !sameGroupRef(decoded.groupRef, trustedRef)) ||
        (trustedValue !== undefined && decoded.value !== trustedValue)
    ) {
        throw publicationCorruption(storageKey, 'RTC topology row differs from trusted slot');
    }
}

export function validateGroupRef(value: PersistedBoundaryValue, expected: GroupRef): void {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology groupRef is invalid');
    }
    assertExactKeys(value, ['applicationId', 'workspaceId', 'groupId']);
    if (
        value.applicationId !== expected.applicationId ||
        value.workspaceId !== expected.workspaceId ||
        value.groupId !== expected.groupId
    ) {
        throw new TypeError('RTC topology publication groupRef differs');
    }
}

export function parseValue(entry: RuntimeStateEntry): PersistedBoundaryValue {
    try {
        return JSON.parse(entry.value);
    }
    catch (error) {
        throw publicationCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology JSON is invalid'
        );
    }
}

export function requireOptimisticRuntime(
    runtime: RuntimeStateRepositoryLike
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC topology publication requires optimistic transactions');
    }
    return runtime;
}

export function assertExactKeys(
    value: Record<string, PersistedBoundaryValue>,
    keys: readonly string[]
): void {
    if (!rtcTopologySemanticEqual(Object.keys(value).sort(), [...keys].sort())) {
        throw new TypeError('RTC topology persisted value has invalid keys');
    }
}

export function isRecord(
    value: PersistedBoundaryValue
): value is Record<string, PersistedBoundaryValue> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function publicationCorruption(
    storageKey: string,
    message: string
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}

export function compact<T>(values: readonly (T | undefined)[]): readonly T[] {
    return values.filter((value): value is T => value !== undefined);
}

function validateCausalRevision(
    value: PersistedBoundaryValue
): asserts value is GroupStateCausalRevision {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology work claim causal revision is invalid');
    }
    assertExactKeys(value, ['groupRevision', 'presenceRevision']);
    if (
        !Number.isSafeInteger(value.groupRevision) || Number(value.groupRevision) < 0 ||
        !Number.isSafeInteger(value.presenceRevision) ||
        Number(value.presenceRevision) < 0
    ) {
        throw new TypeError('RTC topology work claim causal revision is invalid');
    }
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}
