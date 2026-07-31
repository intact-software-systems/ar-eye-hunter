import type { GroupRef, GroupScope, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import type { GroupStateEventStore } from '../../repositories/StateEventStore.ts';

export type GroupStateRepositoryOptions = Readonly<{
  events?: GroupStateEventStore;
}>;

export type GroupStateAuthorityGuard = Readonly<{
  groupRef: GroupRef;
  entry: RuntimeStateEntry;
  causalGroupRevision: number;
}>;

export type GroupStateAuthoritativeSnapshot = Readonly<{
  snapshot: GroupSnapshot;
  authorityGuard: GroupStateAuthorityGuard;
}>;

export class GroupStateRepositoryInvariantCorruptionError extends Error {
  readonly code = 'group-state-repository-invariant-corruption';

  constructor(
    readonly storageKey: string,
    message: string,
  ) {
    super(`${message}: ${storageKey}`);
    this.name = 'GroupStateRepositoryInvariantCorruptionError';
  }
}

export async function toLiveGroupStateEntryValue<T>(
  entry: RuntimeStateEntry,
): Promise<RuntimeStateEntryValue<T> | undefined> {
  if (entry.expireAtTimestamp <= Date.now()) {
    return undefined;
  }
  try {
    return { entry, value: JSON.parse(entry.value) as T };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new GroupStateRepositoryInvariantCorruptionError(
        entry.key,
        `Stored group-state JSON is invalid: ${error.message}`,
      );
    }
    throw error;
  }
}

export function assertGroupRefIdentity(
  value: GroupRef,
  expected: GroupRef,
  storageKey: string,
): void {
  if (
    value.applicationId !== expected.applicationId ||
    value.workspaceId !== expected.workspaceId ||
    value.groupId !== expected.groupId
  ) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      storageKey,
      'Stored group-state identity differs from the requested slot',
    );
  }
}

export function assertDecodedGroupScope(
  decoded: GroupRef,
  expected: GroupScope,
  storageKey: string,
): void {
  if (
    decoded.applicationId !== expected.applicationId ||
    decoded.workspaceId !== expected.workspaceId
  ) {
    throwGroupStateIdentityCorruption(storageKey, 'scope');
  }
}

export function assertTrustedGroupRef(
  decoded: GroupRef,
  expected: GroupRef | undefined,
  storageKey: string,
): void {
  if (expected) {
    assertGroupRefIdentity(decoded, expected, storageKey);
  }
}

export function decodeStoredGroupStateKey<T>(
  storageKey: string,
  decode: (storageKey: string) => T,
): T {
  try {
    return decode(storageKey);
  } catch (error) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      storageKey,
      error instanceof Error ? error.message : 'Stored group-state key is invalid',
    );
  }
}

export function normalizeStoredGroupStateValue<T>(
  value: unknown,
  ref: GroupRef,
  storageKey: string,
  normalize: (value: unknown, ref: GroupRef) => T,
  fallback: string,
): T {
  try {
    return normalize(value, ref);
  } catch (error) {
    throw new GroupStateRepositoryInvariantCorruptionError(
      storageKey,
      error instanceof Error ? error.message : fallback,
    );
  }
}

export function throwGroupStateIdentityCorruption(storageKey: string, slot: string): never {
  throw new GroupStateRepositoryInvariantCorruptionError(
    storageKey,
    `Stored group-state ${slot} differs from the decoded slot`,
  );
}
