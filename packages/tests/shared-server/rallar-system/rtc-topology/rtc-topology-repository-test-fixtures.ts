import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
  createRtcTopologyExecutionReceipt,
  RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
  RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
  hashRtcTopologyExecutionCommand,
  type RtcTopologyPublication,
  type RtcTopologyPublicationWorkClaim,
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import type { ALMessage } from '@shared/mod.ts';

import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';

export function createGroupRef(): GroupRef {
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
  };
}

export function createPrincipalAuditStamp(atEpochMs: number, principalId: string) {
  return {
    atEpochMs,
    actor: { kind: 'principal' as const, principalId },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
export function createTopologySnapshot(
  groupRef: GroupRef,
  version: number,
): RallarOverlayTopologySnapshot {
  return {
    sourceGroupStateCausalRevision: {
      groupRevision: version,
      presenceRevision: version,
    },
    state: 'active',
    overlayId: JSON.stringify([
      groupRef.applicationId,
      groupRef.workspaceId ?? '',
      groupRef.groupId,
    ]),
    groupRef,
    name: 'Room 1',
    topology: 'tree',
    activeSessionIds: ['session-a', 'session-b'],
    nextHopsBySessionId: {
      'session-a': ['session-b'],
      'session-b': ['session-a'],
    },
    degreeLimit: 5,
    version,
    createdByClientId: 'owner',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 2,
  };
}

export function topologyInvariantCases(): readonly Readonly<{
  defect: string;
  snapshot: RallarOverlayTopologySnapshot;
}>[] {
  const base = createTopologySnapshot(createGroupRef(), 1);
  const threeSessionBase: RallarOverlayTopologySnapshot = {
    ...base,
    activeSessionIds: ['session-a', 'session-b', 'session-c'],
    nextHopsBySessionId: {
      'session-a': ['session-b'],
      'session-b': ['session-a', 'session-c'],
      'session-c': ['session-b'],
    },
  };
  const fourSessionBase: RallarOverlayTopologySnapshot = {
    ...base,
    activeSessionIds: ['session-a', 'session-b', 'session-c', 'session-d'],
    nextHopsBySessionId: {
      'session-a': ['session-b'],
      'session-b': ['session-a'],
      'session-c': ['session-d'],
      'session-d': ['session-c'],
    },
  };
  return [
    {
      defect: 'overlay-mismatch',
      snapshot: { ...base, overlayId: 'wrong-overlay' },
    },
    {
      defect: 'duplicate-active-session',
      snapshot: {
        ...base,
        activeSessionIds: ['session-a', 'session-a', 'session-b'],
      },
    },
    {
      defect: 'noncanonical-active-session-order',
      snapshot: { ...base, activeSessionIds: ['session-b', 'session-a'] },
    },
    {
      defect: 'unknown-hop',
      snapshot: {
        ...base,
        nextHopsBySessionId: {
          'session-a': ['session-b', 'session-z'],
          'session-b': ['session-a'],
        },
      },
    },
    {
      defect: 'self-hop',
      snapshot: {
        ...base,
        nextHopsBySessionId: {
          'session-a': ['session-a', 'session-b'],
          'session-b': ['session-a'],
        },
      },
    },
    {
      defect: 'duplicate-hop',
      snapshot: {
        ...base,
        nextHopsBySessionId: {
          'session-a': ['session-b', 'session-b'],
          'session-b': ['session-a'],
        },
      },
    },
    {
      defect: 'noncanonical-hop-order',
      snapshot: {
        ...threeSessionBase,
        nextHopsBySessionId: {
          ...threeSessionBase.nextHopsBySessionId,
          'session-b': ['session-c', 'session-a'],
        },
      },
    },
    {
      defect: 'nonreciprocal-hop',
      snapshot: {
        ...base,
        nextHopsBySessionId: {
          'session-a': ['session-b'],
          'session-b': [],
        },
      },
    },
    {
      defect: 'missing-routing-key',
      snapshot: {
        ...base,
        nextHopsBySessionId: { 'session-a': ['session-b'] },
      },
    },
    {
      defect: 'unknown-routing-key',
      snapshot: {
        ...base,
        nextHopsBySessionId: {
          ...base.nextHopsBySessionId,
          'session-z': [],
        },
      },
    },
    { defect: 'disconnected-graph', snapshot: fourSessionBase },
    {
      defect: 'over-degree-graph',
      snapshot: { ...threeSessionBase, degreeLimit: 1 },
    },
    {
      defect: 'inverted-timestamps',
      snapshot: { ...base, createdAtEpochMs: 3, updatedAtEpochMs: 2 },
    },
    {
      defect: 'removed-nonempty-edge',
      snapshot: { ...base, state: 'removed' },
    },
    {
      defect: 'removed-missing-routing-key',
      snapshot: {
        ...base,
        state: 'removed',
        nextHopsBySessionId: { 'session-a': [] },
      },
    },
    {
      defect: 'removed-zero-degree-limit',
      snapshot: {
        ...base,
        state: 'removed',
        nextHopsBySessionId: {
          'session-a': [],
          'session-b': [],
        },
        degreeLimit: 0,
      },
    },
  ];
}

export function createPublication(snapshot: RallarOverlayTopologySnapshot, workId: string) {
  const sourceRevision = snapshot.sourceGroupStateCausalRevision;
  return {
    publicationId: `${workId}:${sourceRevision.groupRevision}:${sourceRevision.presenceRevision}:${snapshot.version}`,
    workId,
    groupRef: snapshot.groupRef,
    sourceGroupStateCausalRevision: sourceRevision,
    overlayVersion: snapshot.version,
    targetGroupSnapshotVersion: 1,
    recipientSessionIds: snapshot.activeSessionIds,
    message: {
      id: {
        v: 2,
        msgId: JSON.stringify(['rtc-topology-publication', workId]),
        ts: 10,
        senderId: 'rallar-server',
      },
      route: {
        topicId: AppTopics.overlayTopology,
        contextId: snapshot.groupRef.groupId,
        resourceId: `${snapshot.overlayId}:${sourceRevision.groupRevision}:${sourceRevision.presenceRevision}:${snapshot.version}`,
      },
      payload: {
        typeId: AppTopics.overlayTopology,
        contentType: 'application/json',
        resource: JSON.stringify(snapshot),
      },
      targets: {
        mode: 'broadcast',
        scope: 'room',
        groupRef: snapshot.groupRef,
        minSnapshotVersion: 1,
      },
      delivery: { reliability: 'best-effort', ack: 'none' },
      audit: { createdBy: 'rallar-server', createdTs: 10 },
    } as unknown as ALMessage,
    createdAtEpochMs: 10,
  };
}

export type LegacyRtcTopologyPublication = Omit<
  RtcTopologyPublication,
  'targetGroupSnapshotVersion'
>;

export function toLegacyPublication(
  publication: RtcTopologyPublication,
): LegacyRtcTopologyPublication {
  const { targetGroupSnapshotVersion: _targetGroupSnapshotVersion, ...legacy } =
    structuredClone(publication);
  return {
    ...legacy,
    message: {
      ...legacy.message,
      id: {
        ...legacy.message.id,
        msgId: `legacy-random-${legacy.workId}`,
        ts: legacy.createdAtEpochMs + 1,
      },
      audit: {
        ...legacy.message.audit,
        createdTs: legacy.createdAtEpochMs + 1,
      },
    },
  };
}

export function toUpgradedLegacyPublication(
  legacy: LegacyRtcTopologyPublication,
): RtcTopologyPublication {
  if (
    legacy.message.targets?.mode !== 'broadcast' ||
    legacy.message.targets.minSnapshotVersion === undefined
  ) {
    throw new Error('Expected legacy room publication target');
  }
  return {
    ...legacy,
    targetGroupSnapshotVersion: legacy.message.targets.minSnapshotVersion,
    message: {
      ...legacy.message,
      id: {
        ...legacy.message.id,
        msgId: JSON.stringify(['rtc-topology-publication', legacy.workId]),
        ts: legacy.createdAtEpochMs,
      },
      audit: {
        ...legacy.message.audit,
        createdTs: legacy.createdAtEpochMs,
      },
    },
  };
}

export async function seedLegacyPublicationRows(
  runtime: FakeRuntimeStateRepository,
  publication: LegacyRtcTopologyPublication,
  expiry: number,
): Promise<void> {
  await runtime.upsert(
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    publication.publicationId,
    JSON.stringify(publication),
    expiry,
  );
  await runtime.upsert(
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    publication.workId,
    JSON.stringify(publication.publicationId),
    expiry,
  );
}

export async function putOrLoadTopologyPublication(
  repository: RtcTopologyPublicationRepository,
  publication: RtcTopologyPublication,
  snapshot: RallarOverlayTopologySnapshot,
) {
  const snapshots = new RtcTopologySnapshotRepository(repository.runtimeRepository);
  let stored = await snapshots.findSnapshotEntry(snapshot.groupRef);
  if (!stored) {
    const seeded = await snapshots.commitSnapshotGuard(snapshot, null);
    if (seeded.status !== 'accepted') {
      throw new Error('Expected topology snapshot fixture seed');
    }
    stored = await snapshots.findSnapshotEntry(snapshot.groupRef);
  }
  if (!stored) throw new Error('Expected durable topology snapshot fixture');
  return await repository.putOrLoad(publication, {
    commandHash: await hashRtcTopologyExecutionCommand(publication),
    attemptCount: 1,
    acceptedStorageRevision: stored.entry.revision,
  });
}

export function corruptTopologyExecutionReceipt(
  receipt: RtcTopologyPublicationWorkClaim,
  defect:
    'legacy' | 'missing' | 'extra' | 'hash' | 'attempt' | 'causal' | 'storage' | 'event' | 'outbox',
): unknown {
  if (defect === 'legacy') {
    return {
      groupRef: receipt.groupRef,
      workId: receipt.workId,
      publicationId: receipt.publicationId,
    };
  }
  if (defect === 'missing') {
    const { eventId: _eventId, ...missingEventId } = receipt;
    return missingEventId;
  }
  if (defect === 'extra') return { ...receipt, snapshot: null };
  if (defect === 'hash') {
    return { ...receipt, commandHash: `sha256:${'0'.repeat(64)}` };
  }
  if (defect === 'attempt') return { ...receipt, attemptCount: 0 };
  if (defect === 'causal') {
    return {
      ...receipt,
      acceptedCausalRevision: {
        ...receipt.acceptedCausalRevision,
        groupRevision: receipt.acceptedCausalRevision.groupRevision + 1,
      },
    };
  }
  if (defect === 'storage') {
    return {
      ...receipt,
      acceptedStorageRevision: receipt.acceptedStorageRevision + 1,
    };
  }
  if (defect === 'event') return { ...receipt, eventId: 'unexpected-event' };
  return { ...receipt, outboxIds: [] };
}

export function reorderJsonObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => reorderJsonObjectKeys(entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reorderJsonObjectKeys(entry)]),
  ) as T;
}
