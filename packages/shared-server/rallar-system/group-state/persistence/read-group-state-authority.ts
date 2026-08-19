import type { GroupRef } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import {
  isRuntimeStateReadBatchRepositoryLike,
  type RuntimeStateReadBatchSelector,
} from '../../../runtime-state/RuntimeStateReadBatch.ts';
import { resolveRuntimeStateReadBatchLiveValues } from '../../../runtime-state/RuntimeStateReadBatchLiveValues.ts';
import { groupStateGroupStorageKey } from './group-state-storage-keys.ts';
import {
  GROUPS_NAMESPACE,
  MEMBERS_NAMESPACE,
  PRESENCE_SUMMARIES_NAMESPACE,
  SESSIONS_NAMESPACE,
} from './group-state-runtime-namespaces.ts';

export type GroupStateAuthorityBatchRead =
  | Readonly<{ status: 'fallback' }>
  | Readonly<{
      status: 'stable';
      group: RuntimeStateEntryValue<unknown> | undefined;
      members: readonly RuntimeStateEntryValue<unknown>[];
      summary: RuntimeStateEntryValue<unknown> | undefined;
      sessions: readonly RuntimeStateEntryValue<unknown>[];
    }>;

export async function readGroupStateAuthorityBatch(
  repository: RuntimeStateRepositoryLike,
  ref: GroupRef,
  toLiveEntryValue: (
    namespace: string,
    entry: RuntimeStateEntry,
  ) => Promise<RuntimeStateEntryValue<unknown> | undefined>,
): Promise<GroupStateAuthorityBatchRead> {
  if (!isRuntimeStateReadBatchRepositoryLike(repository)) {
    return { status: 'fallback' };
  }
  const groupKey = groupStateGroupStorageKey(ref);
  const childPrefix = `${groupKey}:`;
  const selectors: readonly RuntimeStateReadBatchSelector[] = [
    {
      selectorId: 'group',
      kind: 'key',
      namespace: GROUPS_NAMESPACE,
      key: groupKey,
    },
    {
      selectorId: 'members',
      kind: 'prefix',
      namespace: MEMBERS_NAMESPACE,
      keyPrefix: childPrefix,
    },
    {
      selectorId: 'presence-summary',
      kind: 'key',
      namespace: PRESENCE_SUMMARIES_NAMESPACE,
      key: groupKey,
    },
    {
      selectorId: 'presence-sessions',
      kind: 'prefix',
      namespace: SESSIONS_NAMESPACE,
      keyPrefix: childPrefix,
    },
  ];
  const resolved = await resolveRuntimeStateReadBatchLiveValues(
    selectors,
    await repository.readRuntimeStateBatch(selectors),
    toLiveEntryValue,
  );
  if (resolved.status === 'changed') return { status: 'fallback' };
  const [group, members, summary, sessions] = resolved.selections;
  return {
    status: 'stable',
    group: group.entries[0],
    members: members.entries,
    summary: summary.entries[0],
    sessions: sessions.entries,
  };
}
