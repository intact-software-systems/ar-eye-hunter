import type { Group, GroupEvent, GroupRef, GroupScope } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
  isRuntimeStateConditionalRepositoryLike,
  type RuntimeStateConditionalWriteResult,
  type RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import {
  RuntimeStateJsonStore,
  type RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
// prettier-ignore
import type {
  RuntimeStateGuardedBatchUpdate,
} from '../../../runtime-state/RuntimeStateGuardedBatch.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
// prettier-ignore
import {
  validateGroupMutationIdempotencyRecord,
} from '../mutation/result-validation/validate-group-mutation-result.ts';
import { validatePersistedGroupEvent } from '../../persisted-group-event.ts';
import type { GroupStateEventStore } from '../../repositories/StateEventStore.ts';
import { filterStateEventsForList, type StateEventListQuery } from '../../state-event-listing.ts';
import { normalizePersistedGroup } from './group-state-persistence-codec.ts';
import {
  assertGroupRefIdentity,
  decodeStoredGroupStateKey,
  GroupStateRepositoryInvariantCorruptionError,
  normalizeStoredGroupStateValue,
  throwGroupStateIdentityCorruption,
  type GroupStateAuthorityGuard,
} from './group-state-persistence-contracts.ts';
import {
  decodeGroupStateGroupStorageKey,
  decodeGroupStateIdempotencyStorageKey,
  groupStateGroupStorageKey,
  groupStateIdempotencyStorageKey,
} from './group-state-storage-keys.ts';
import { GROUPS_NAMESPACE, IDEMPOTENT_NAMESPACE } from './group-state-runtime-namespaces.ts';
import { validatePersistedGroup } from './validate-persisted-group.ts';

export class GroupAggregateRepository extends RuntimeStateJsonStore {
  constructor(
    repository: RuntimeStateRepositoryLike,
    private readonly events: GroupStateEventStore,
  ) {
    super(repository);
  }

  async insertIdempotentGroupMutationReceipt(
    ref: GroupRef,
    requestId: string,
    record: GroupMutationIdempotencyRecord,
    purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
  ): Promise<RuntimeStateConditionalWriteResult> {
    const key = groupStateIdempotencyStorageKey(ref, requestId);
    assertIdempotencyIdentity(record, { ...ref, requestId }, key);
    return await this.putValueIfAbsent(IDEMPOTENT_NAMESPACE, key, record, purgeAfterEpochMs);
  }

  async insertGroup(group: Group): Promise<RuntimeStateConditionalWriteResult> {
    validatePersistedGroup(group, group);
    return await this.putValueIfAbsent(
      GROUPS_NAMESPACE,
      groupStateGroupStorageKey(group),
      group,
      group.purgeAfterEpochMs ?? this.neverExpireAtTimestamp(),
    );
  }

  async updateGroup(
    group: Group,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalWriteResult> {
    validatePersistedGroup(group, group);
    return await this.putValueIfRevision(
      GROUPS_NAMESPACE,
      groupStateGroupStorageKey(group),
      group,
      group.purgeAfterEpochMs ?? this.neverExpireAtTimestamp(),
      expectedRevision,
    );
  }

  async advanceAuthorityFence(
    guard: GroupStateAuthorityGuard,
  ): Promise<RuntimeStateConditionalWriteResult> {
    const descriptor = materializeGroupStateAuthorityGuard(guard);
    if (!isRuntimeStateConditionalRepositoryLike(this.repository)) {
      throw new TypeError('Group authority fences require a conditional runtime-state repository');
    }
    return await this.repository.upsertIfRevision(
      descriptor.namespace,
      descriptor.key,
      descriptor.value,
      descriptor.expireAtTimestamp,
      descriptor.expectedRevision,
    );
  }

  async putGroup(group: Group): Promise<void> {
    validatePersistedGroup(group, group);
    await this.putValue(
      GROUPS_NAMESPACE,
      groupStateGroupStorageKey(group),
      group,
      group.purgeAfterEpochMs ?? this.neverExpireAtTimestamp(),
    );
  }

  async removeGroup(ref: GroupRef): Promise<void> {
    await this.deleteValue(GROUPS_NAMESPACE, groupStateGroupStorageKey(ref));
  }

  async appendEvent(event: GroupEvent): Promise<void> {
    validatePersistedGroupEvent(event, event);
    await this.events.appendGroupEvent(event);
  }

  async listEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
    return await this.events.listGroupEvents(ref);
  }

  async listRecentEvents(
    ref: GroupRef,
    query: StateEventListQuery = {},
  ): Promise<readonly GroupEvent[]> {
    return this.events.listRecentGroupEvents
      ? await this.events.listRecentGroupEvents(ref, query)
      : filterStateEventsForList(await this.events.listGroupEvents(ref), query);
  }

  async listEventPage(
    ref: GroupRef,
    query: StateEventListQuery = {},
  ): Promise<StateEventPage<GroupEvent>> {
    return await this.events.listGroupEventPage(ref, query);
  }
}

export function materializeGroupStateAuthorityGuard(
  guard: GroupStateAuthorityGuard,
): RuntimeStateGuardedBatchUpdate {
  const stored = assertGroupStateAuthorityGuard(guard);
  return {
    operation: 'update',
    namespace: GROUPS_NAMESPACE,
    key: stored.entry.key,
    expectedRevision: stored.entry.revision,
    value: stored.entry.value,
    expireAtTimestamp: stored.entry.expireAtTimestamp,
  };
}

export function canonicalStoredGroup(
  stored: RuntimeStateEntryValue<unknown>,
  expectedScope: GroupScope,
): RuntimeStateEntryValue<Group> {
  let decoded: GroupRef;
  try {
    decoded = decodeGroupStateGroupStorageKey(stored.entry.key);
  } catch (error) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      stored.entry.key,
      error instanceof Error ? error.message : 'Stored group key is invalid',
    );
  }
  if (
    decoded.applicationId !== expectedScope.applicationId ||
    decoded.workspaceId !== expectedScope.workspaceId
  ) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      stored.entry.key,
      'Stored group key differs from the requested scope',
    );
  }
  if (isGroupRef(expectedScope)) {
    assertGroupRefIdentity(decoded, expectedScope, stored.entry.key);
  }
  const value = normalizeStoredGroupStateValue(
    stored.value,
    decoded,
    stored.entry.key,
    normalizePersistedGroup,
    'Stored group value is invalid',
  );
  assertGroupRefIdentity(value, decoded, stored.entry.key);
  return { entry: stored.entry, value };
}

export function toGroupStateAuthorityGuard(
  ref: GroupRef,
  stored: RuntimeStateEntryValue<Group>,
): GroupStateAuthorityGuard {
  const canonical = canonicalStoredGroup(stored, ref);
  assertAuthorityFencePhysicalExpiry(canonical);
  return {
    groupRef: { ...ref },
    entry: { ...stored.entry },
    causalGroupRevision: canonical.value.snapshotVersion,
  };
}

function assertGroupStateAuthorityGuard(
  guard: GroupStateAuthorityGuard,
): RuntimeStateEntryValue<Group> {
  if (!guard || typeof guard !== 'object') {
    throw new TypeError('Group authority guard is invalid');
  }
  const entry = guard.entry;
  if (
    !entry ||
    typeof entry.key !== 'string' ||
    typeof entry.value !== 'string' ||
    !Number.isSafeInteger(entry.expireAtTimestamp) ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0 ||
    !Number.isSafeInteger(guard.causalGroupRevision) ||
    guard.causalGroupRevision < 1
  ) {
    throw new TypeError('Group authority guard entry is invalid');
  }
  let value: Group;
  try {
    value = normalizeStoredGroupStateValue(
      JSON.parse(entry.value) as unknown,
      guard.groupRef,
      entry.key,
      normalizePersistedGroup,
      'Stored authority-fence group value is invalid',
    );
  } catch (error) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      entry.key,
      error instanceof Error
        ? `Stored authority-fence group JSON is invalid: ${error.message}`
        : 'Stored authority-fence group JSON is invalid',
    );
  }
  if (guard.causalGroupRevision !== value.snapshotVersion) {
    throw new TypeError('Group authority guard causal mismatch');
  }
  const stored = { entry, value };
  assertAuthorityFencePhysicalExpiry(stored);
  return stored;
}

function assertAuthorityFencePhysicalExpiry(stored: RuntimeStateEntryValue<Group>): void {
  const expectedExpiry = stored.value.purgeAfterEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP;
  if (stored.entry.expireAtTimestamp !== expectedExpiry) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      stored.entry.key,
      'Stored group physical expiry differs from its domain purge boundary',
    );
  }
}

export function assertStoredIdempotency(
  stored: RuntimeStateEntryValue<GroupMutationIdempotencyRecord>,
  expected: GroupRef & Readonly<{ requestId: string }>,
): void {
  const decoded = decodeStoredGroupStateKey(
    stored.entry.key,
    decodeGroupStateIdempotencyStorageKey,
  );
  assertGroupRefIdentity(decoded, expected, stored.entry.key);
  assertIdempotencyIdentity(stored.value, decoded, stored.entry.key);
}

function assertIdempotencyIdentity(
  value: GroupMutationIdempotencyRecord,
  expected: GroupRef & Readonly<{ requestId: string }>,
  storageKey: string,
): void {
  try {
    validateGroupMutationIdempotencyRecord(value, expected);
  } catch (error) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      storageKey,
      error instanceof Error ? error.message : 'Stored group idempotency value is invalid',
    );
  }
  if (value.requestId !== expected.requestId) {
    throwGroupStateIdentityCorruption(storageKey, 'idempotency request');
  }
  assertGroupRefIdentity(value.aggregateRef, expected, storageKey);
}

function isGroupRef(value: GroupScope): value is GroupRef {
  return 'groupId' in value && typeof value.groupId === 'string';
}
