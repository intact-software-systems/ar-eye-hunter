import { beforeEach, describe, expect, it } from 'vitest';

import * as clientSnapshots from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupSnapshots from '@shared/repository/group-state-snapshots-repository.ts';
import {
  captureStateSnapshotCollectionObservations,
  reconcileCompleteStateSnapshotCollections,
} from '@shared-web/browser/state-read/reconciliation.ts';

import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import {
  createClientSnapshotFixture,
  createGroupSnapshotFixture,
} from './authoritative-group-fixtures.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('browser complete snapshot reconciliation', () => {
  beforeEach(() => configureTestCacheRepositories());

  it('removes authoritative omissions only when the captured identity is unchanged', () => {
    const oldClient = createClientSnapshotFixture({ ...scope, principalId: 'alice' });
    const oldGroup = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
    clientSnapshots.setClientStateSnapshots([oldClient]);
    groupSnapshots.setGroupStateSnapshots([oldGroup]);
    const observations = captureStateSnapshotCollectionObservations(scope);

    const newerClient = { ...oldClient, stateRevision: 2 };
    const newerGroup = {
      ...oldGroup,
      stateRevision: 2,
      causalRevision: { groupRevision: 2, presenceRevision: 0 },
    };
    clientSnapshots.setClientStateSnapshots([newerClient]);
    groupSnapshots.setGroupStateSnapshots([newerGroup]);

    reconcileCompleteStateSnapshotCollections(observations, [], []);

    expect(clientSnapshots.findClientStateSnapshotByRef(oldClient.principal)).toBe(newerClient);
    expect(groupSnapshots.findGroupStateSnapshotByRef(oldGroup.group)).toBe(newerGroup);
  });

  it('physically removes unchanged omissions and allows delayed stale publication to reinsert', () => {
    const observed = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
    groupSnapshots.setGroupStateSnapshots([observed]);

    reconcileCompleteStateSnapshotCollections(
      captureStateSnapshotCollectionObservations(scope),
      [],
      [],
    );
    expect(groupSnapshots.findGroupStateSnapshotByRef(observed.group)).toBeUndefined();

    groupSnapshots.setGroupStateSnapshots([observed]);
    expect(groupSnapshots.findGroupStateSnapshotByRef(observed.group)).toBe(observed);
  });
});
